import { spawn } from "node:child_process";
import { PREDEFINED_FILTERS } from "ziplayer";
const MAX_DISCORD_UPLOAD_BYTES = 23 * 1024 * 1024; // 23 MB safe margin under Discord's 25 MB default limit
/**
 * Exports a playing/queued track via `player.save(track)` and transcodes to a valid
 * playable `.mp3` buffer (`libmp3lame`), optionally applying a predefined FFmpeg filter.
 */
export async function exportTrackToMp3Buffer(player, track, options) {
    if (track.isLive) {
        throw new Error("Không thể xuất file MP3 cho luồng phát trực tiếp (LIVE stream).");
    }
    const durationSec = Math.floor((track.duration || 0) / 1000);
    if (durationSec > options.maxDurationSec) {
        throw new Error(`Bài hát dài ${durationSec}s, vượt quá giới hạn xuất file an toàn (${options.maxDurationSec}s).`);
    }
    if (!options.ffmpegPath) {
        throw new Error("Không tìm thấy thực thi FFmpeg để mã hóa MP3.");
    }
    let filterExpr = "";
    if (options.filterName) {
        const def = PREDEFINED_FILTERS[options.filterName];
        if (!def) {
            throw new Error(`Hiệu ứng "${options.filterName}" không tồn tại trong kho PREDEFINED_FILTERS.`);
        }
        filterExpr = def.ffmpegFilter;
    }
    else {
        const active = player.filter.getActiveFilters();
        if (active.length > 0) {
            filterExpr = active.map((f) => f.ffmpegFilter).join(",");
        }
    }
    const abortController = new AbortController();
    const timeoutMs = options.timeoutMs ?? 90_000;
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    let rawStream = null;
    try {
        rawStream = await player.save(track, {
            quality: "high",
            timeout: Math.min(timeoutMs, 45_000),
            signal: abortController.signal,
        });
        const ffmpegArgs = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-vn",
            ...(filterExpr ? ["-af", filterExpr] : []),
            "-c:a",
            "libmp3lame",
            "-b:a",
            "160k",
            "-f",
            "mp3",
            "pipe:1",
        ];
        return await new Promise((resolve, reject) => {
            const proc = spawn(options.ffmpegPath, ffmpegArgs, {
                stdio: ["pipe", "pipe", "pipe"],
            });
            const chunks = [];
            let totalBytes = 0;
            let stderrText = "";
            let settled = false;
            const finishWithError = (err) => {
                if (settled)
                    return;
                settled = true;
                try {
                    rawStream?.destroy();
                }
                catch {
                    // ignore
                }
                try {
                    proc.kill("SIGKILL");
                }
                catch {
                    // ignore
                }
                reject(err);
            };
            const onAbort = () => {
                finishWithError(new Error("Quá thời gian xử lý xuất file MP3."));
            };
            abortController.signal.addEventListener("abort", onAbort, { once: true });
            proc.stdin.on("error", () => {
                // Ignore EPIPE when ffmpeg exits early
            });
            rawStream.on("error", (err) => {
                finishWithError(new Error(`Lỗi đọc luồng nhạc nguồn: ${err.message}`));
            });
            proc.stderr.on("data", (d) => {
                if (stderrText.length < 2048)
                    stderrText += d.toString("utf8");
            });
            proc.stdout.on("data", (chunk) => {
                totalBytes += chunk.length;
                if (totalBytes > MAX_DISCORD_UPLOAD_BYTES) {
                    finishWithError(new Error("Kích thước file MP3 vượt quá giới hạn tải lên 25MB của Discord."));
                    return;
                }
                chunks.push(chunk);
            });
            proc.on("error", (err) => {
                finishWithError(new Error(`Không thể chạy FFmpeg: ${err.message}`));
            });
            proc.on("close", (code) => {
                abortController.signal.removeEventListener("abort", onAbort);
                if (settled)
                    return;
                settled = true;
                if (code !== 0 || totalBytes === 0) {
                    reject(new Error(stderrText.trim() || `FFmpeg kết thúc với mã lỗi ${code}`));
                    return;
                }
                resolve(Buffer.concat(chunks, totalBytes));
            });
            rawStream.pipe(proc.stdin);
        });
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=exporter.js.map