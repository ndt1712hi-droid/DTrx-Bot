import { AudioPlayerStatus, VoiceConnectionStatus } from "@discordjs/voice";
/**
 * TRACK_STARTED means a resource was handed to the audio player, not that
 * packets reached a voice connection. Wait briefly for the local voice player
 * to advance, without claiming that Discord clients actually heard it.
 */
export async function waitForAudioDelivery(player, timeoutMs = 8_000) {
    if (player.playbackMode !== "native")
        return "external";
    const track = player.currentTrack;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
        if (player.destroyed)
            return "stopped";
        if (track && player.currentTrack && player.currentTrack.id !== track.id)
            return "replaced";
        if (player.volume <= 0)
            return "muted";
        const connection = player.connection;
        const audio = player.audioPlayer;
        const state = audio.state;
        const ready = connection?.state.status === VoiceConnectionStatus.Ready;
        const subscription = connection?.state.status === VoiceConnectionStatus.Ready ? connection.state.subscription : undefined;
        if (ready && subscription?.player === audio &&
            state.status === AudioPlayerStatus.Playing && state.resource.playbackDuration > 0) {
            return "delivering";
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            if (!ready)
                return "disconnected";
            const tts = player.runtimeGraph.ttsController.player;
            if (subscription?.player === tts && tts.state.status !== AudioPlayerStatus.Idle)
                return "tts";
            if (subscription?.player !== audio)
                return "no-subscription";
            if (state.status === AudioPlayerStatus.Paused || state.status === AudioPlayerStatus.AutoPaused)
                return "paused";
            if (state.status === AudioPlayerStatus.Idle)
                return "stopped";
            return "buffering";
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(150, remaining)));
    }
}
//# sourceMappingURL=playbackHealth.js.map