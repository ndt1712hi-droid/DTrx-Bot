import { spawn } from "node:child_process";
import { createAudioResource, StreamType } from "@discordjs/voice";
import prism from "prism-media";
/**
 * ZiPlayer delegates arbitrary audio to prism's FFmpeg transform. On an early
 * stop/skip, destroying the last stream does not always destroy that transform,
 * leaving an FFmpeg child alive indefinitely. Decode explicitly and tie the
 * subprocess and input stream to the lifetime of the resulting audio resource.
 */
export function installManagedAudioResources(player, ffmpegPath) {
    const playback = player.runtimeGraph.playbackController;
    const original = playback.createResource.bind(playback);
    playback.createResource = (stream, track, inputType) => {
        const annotatedType = inputType ?? stream.inputType;
        // Preserve ZiPlayer's direct PCM/Opus path (and its stream-type inference
        // for prism streams). These formats do not need an FFmpeg decoder here.
        if (annotatedType === StreamType.Raw || annotatedType === StreamType.Opus ||
            (!annotatedType && isTypedPrismStream(stream))) {
            return original(stream, track, inputType);
        }
        return createManagedResource(stream, track, ffmpegPath);
    };
}
function isTypedPrismStream(stream) {
    return stream instanceof prism.opus.Encoder || stream instanceof prism.opus.Decoder ||
        stream instanceof prism.opus.OggDemuxer || stream instanceof prism.opus.WebmDemuxer ||
        stream instanceof prism.VolumeTransformer;
}
function createManagedResource(stream, track, ffmpegPath) {
    const decoder = spawn(ffmpegPath ?? "ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-analyzeduration", "0", "-i", "pipe:0",
        "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let closed = false;
    let stderr = "";
    let resource;
    const cleanup = () => {
        if (closed)
            return;
        closed = true;
        stream.unpipe(decoder.stdin);
        if (!stream.destroyed)
            stream.destroy();
        decoder.stdin.destroy();
        decoder.stdout.destroy();
        decoder.stderr.destroy();
        if (decoder.exitCode === null && decoder.signalCode === null)
            decoder.kill("SIGKILL");
    };
    const fail = (error) => {
        if (!closed)
            resource?.playStream.destroy(error);
    };
    decoder.stderr.on("data", (chunk) => {
        if (stderr.length < 1_000)
            stderr += chunk.toString().slice(0, 1_000 - stderr.length);
    });
    decoder.on("error", fail);
    decoder.stdin.on("error", (error) => {
        // EPIPE is expected if FFmpeg exits or the resource is stopped.
        if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED")
            fail(error);
    });
    decoder.on("close", (code, signal) => {
        if (!closed && code !== 0) {
            const detail = stderr.trim().replace(/\s+/g, " ").slice(0, 220);
            fail(new Error(`FFmpeg không giải mã được âm thanh (${code ?? signal ?? "unknown"})${detail ? `: ${detail}` : ""}`));
        }
    });
    stream.on("error", fail);
    try {
        resource = createAudioResource(decoder.stdout, { inputType: StreamType.Raw, inlineVolume: true, metadata: track });
        resource.playStream.once("close", cleanup);
        stream.pipe(decoder.stdin);
        return resource;
    }
    catch (error) {
        cleanup();
        throw error;
    }
}
//# sourceMappingURL=managedAudioResource.js.map