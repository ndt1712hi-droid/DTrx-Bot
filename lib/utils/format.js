/**
 * Truncates text safely to fit Discord embed & component character limits.
 */
export function truncate(text, maxLength) {
    if (!text)
        return "";
    if (maxLength <= 3)
        return text.slice(0, Math.max(0, maxLength));
    return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}
/**
 * Normalizes duration values that plugins might report in either seconds or milliseconds.
 * Note: ZiPlayer plugins typically store duration in milliseconds, except occasional live/zero values.
 */
export function normalizeDurationMs(rawDuration) {
    if (!rawDuration || !Number.isFinite(rawDuration) || rawDuration <= 0)
        return 0;
    // Heuristic: tracks under 1000 that aren't ms are rare; ZiPlayer standardizes on ms,
    // but guard against tiny fractional inputs.
    return Math.round(rawDuration);
}
/**
 * Formats milliseconds into `mm:ss` or `hh:mm:ss`, or `🔴 LIVE` for live streams.
 */
export function formatDuration(ms, isLive = false) {
    if (isLive)
        return "🔴 LIVE";
    const safeMs = normalizeDurationMs(ms);
    if (safeMs <= 0)
        return "00:00";
    const totalSeconds = Math.floor(safeMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (n) => String(n).padStart(2, "0");
    if (hours > 0) {
        return `${hours}:${pad(minutes)}:${pad(seconds)}`;
    }
    return `${pad(minutes)}:${pad(seconds)}`;
}
/**
 * Parses human time expressions into milliseconds:
 * - `"90"` -> 90_000
 * - `"1:30"` -> 90_000
 * - `"01:02:03"` -> 3_723_000
 * - `"2m30s"` / `"1h5m"` / `"45s"` -> ms
 * Returns `null` if invalid or negative.
 */
export function parseTimeInput(raw) {
    const input = raw.trim().toLowerCase();
    if (!input)
        return null;
    // Pure seconds number: "90"
    if (/^\d+(\.\d+)?$/.test(input)) {
        const sec = Number(input);
        if (!Number.isFinite(sec) || sec < 0 || sec > 86_400)
            return null;
        return Math.round(sec * 1000);
    }
    // Colon format: mm:ss or hh:mm:ss
    if (/^\d{1,2}:\d{1,2}(:\d{1,2})?$/.test(input)) {
        const parts = input.split(":").map(Number);
        if (parts.some((p) => !Number.isFinite(p) || p < 0))
            return null;
        let totalSec = 0;
        if (parts.length === 2) {
            const [m, s] = parts;
            if (s >= 60)
                return null;
            totalSec = m * 60 + s;
        }
        else if (parts.length === 3) {
            const [h, m, s] = parts;
            if (m >= 60 || s >= 60)
                return null;
            totalSec = h * 3600 + m * 60 + s;
        }
        if (totalSec > 86_400)
            return null;
        return totalSec * 1000;
    }
    // Unit format: 1h2m3s / 2m30s / 45s / 3m
    const unitRegex = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?$/;
    const match = input.match(unitRegex);
    if (match && (match[1] || match[2] || match[3])) {
        const h = Number(match[1] ?? 0);
        const m = Number(match[2] ?? 0);
        const s = Number(match[3] ?? 0);
        const totalSec = h * 3600 + m * 60 + s;
        if (!Number.isFinite(totalSec) || totalSec < 0 || totalSec > 86_400)
            return null;
        return Math.round(totalSec * 1000);
    }
    return null;
}
/**
 * Returns a clean badge label for a ZiPlayer track source.
 */
export function formatSourceBadge(source) {
    const key = (source ?? "").toLowerCase();
    if (key.includes("youtube") || key === "yt")
        return "🔴 YouTube";
    if (key.includes("soundcloud") || key === "sc")
        return "🟠 SoundCloud";
    if (key.includes("spotify") || key === "sp")
        return "🟢 Spotify";
    if (key.includes("tts"))
        return "🗣️ TTS";
    if (key.includes("attachment") || key.includes("file"))
        return "📎 File đính kèm";
    if (key.includes("lavalink"))
        return "⚡ Lavalink";
    return source ? `🎵 ${source}` : "🎵 Audio";
}
/**
 * Human-readable Vietnamese label for loop mode.
 */
export function formatLoopMode(mode) {
    switch (mode) {
        case "track":
            return "🔂 Lặp 1 bài";
        case "queue":
            return "🔁 Lặp hàng đợi";
        default:
            return "➡️ Tắt";
    }
}
/**
 * Cycles loop mode: off -> track -> queue -> off.
 */
export function nextLoopMode(current) {
    if (current === "off")
        return "track";
    if (current === "track")
        return "queue";
    return "off";
}
/**
 * Sanitizes a track title into a safe MP3 filename.
 */
export function sanitizeFilename(title) {
    const cleaned = title
        .normalize("NFKD")
        .replace(/[^\w\s.-]/g, "")
        .trim()
        .replace(/\s+/g, "_")
        .slice(0, 64);
    return `${cleaned || "ziplayer_track"}.mp3`;
}
/**
 * Parses `LAVALINK_NODES` environment string.
 * Supports either JSON array OR comma-separated `host:port:password[:secure]`.
 */
export function parseLavalinkNodes(raw) {
    if (!raw || !raw.trim())
        return [];
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
        try {
            const parsed = JSON.parse(trimmed);
            if (!Array.isArray(parsed))
                return [];
            return parsed
                .filter((n) => n && typeof n.host === "string" && Number.isFinite(Number(n.port)) && typeof n.password === "string")
                .map((n, idx) => ({
                identifier: typeof n.identifier === "string" ? n.identifier : `node-${idx + 1}`,
                host: n.host.trim(),
                port: Number(n.port),
                password: n.password,
                secure: Boolean(n.secure),
            }));
        }
        catch {
            return [];
        }
    }
    const nodes = [];
    for (const [idx, entry] of trimmed.split(",").entries()) {
        const parts = entry.trim().split(":");
        if (parts.length < 3)
            continue;
        const [host, portStr, password, secureStr] = parts;
        const port = Number(portStr);
        if (!host || !Number.isFinite(port) || port <= 0 || port > 65535 || !password)
            continue;
        nodes.push({
            identifier: `node-${idx + 1}`,
            host: host.trim(),
            port,
            password,
            secure: secureStr === "true" || secureStr === "1",
        });
    }
    return nodes;
}
/**
 * Parses Vietnamese & English spoken voice commands when prefixed by a configured wake word.
 * Example: "zi phát Sơn Tùng", "bot skip", "zi âm lượng 80", "bot tạm dừng".
 */
export function parseVoiceCommand(transcript, wakeWords) {
    const normalized = transcript.trim().replace(/\s+/g, " ");
    if (!normalized)
        return null;
    const lower = normalized.toLowerCase();
    let commandBody = null;
    const effectiveWakeWords = wakeWords.map((w) => w.trim().toLowerCase()).filter(Boolean);
    if (effectiveWakeWords.length === 0) {
        commandBody = normalized;
    }
    else {
        for (const wake of effectiveWakeWords) {
            const escaped = wake.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const match = lower.match(new RegExp(`^(?:hey\\s+|ơi\\s+)?${escaped}[,\\s]+(.+)$`, "i"));
            if (match) {
                commandBody = normalized.slice(normalized.length - match[1].length).trim();
                break;
            }
        }
    }
    if (!commandBody)
        return null;
    const bodyLower = commandBody.toLowerCase();
    // Play
    const playMatch = commandBody.match(/^(?:phát(?:\s+bài|\s+nhạc)?|mở(?:\s+bài|\s+nhạc)?|bật(?:\s+bài|\s+nhạc)?|play)\s+(.+)$/i);
    if (playMatch?.[1]?.trim()) {
        return { type: "play", query: playMatch[1].trim() };
    }
    // Volume
    const volMatch = bodyLower.match(/^(?:âm lượng|am luong|volume|vol)\s+(\d{1,3})%?$/i);
    if (volMatch) {
        const level = Math.min(100, Math.max(0, Number(volMatch[1])));
        return { type: "volume", level };
    }
    // Skip / Next
    if (/^(?:bỏ qua|bo qua|qua bài|bài tiếp|next|skip)$/i.test(bodyLower)) {
        return { type: "skip" };
    }
    // Previous
    if (/^(?:bài trước|quay lại|previous|prev|back)$/i.test(bodyLower)) {
        return { type: "previous" };
    }
    // Pause
    if (/^(?:tạm dừng|tam dung|pause)$/i.test(bodyLower)) {
        return { type: "pause" };
    }
    // Resume
    if (/^(?:tiếp tục|tiep tuc|resume|unpause)$/i.test(bodyLower)) {
        return { type: "resume" };
    }
    // Stop
    if (/^(?:dừng(?:\s+lại|\s+nhạc)?|tắt nhạc|stop)$/i.test(bodyLower)) {
        return { type: "stop" };
    }
    // Shuffle
    if (/^(?:trộn(?:\s+bài)?|xáo bài|shuffle)$/i.test(bodyLower)) {
        return { type: "shuffle" };
    }
    // Autoplay
    if (/^(?:tự động phát|autoplay|auto play)$/i.test(bodyLower)) {
        return { type: "autoplay" };
    }
    // Loop
    if (/^(?:lặp bài|loop track|repeat track)$/i.test(bodyLower)) {
        return { type: "loop", mode: "track" };
    }
    if (/^(?:lặp hàng đợi|loop queue)$/i.test(bodyLower)) {
        return { type: "loop", mode: "queue" };
    }
    if (/^(?:tắt lặp|loop off)$/i.test(bodyLower)) {
        return { type: "loop", mode: "off" };
    }
    return null;
}
//# sourceMappingURL=format.js.map