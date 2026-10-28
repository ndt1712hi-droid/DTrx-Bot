import fs from "node:fs";
import dotenv from "dotenv";
import ffmpegStatic from "ffmpeg-static";
import { parseLavalinkNodes } from "./utils/format.js";
dotenv.config();
/**
 * Resolves a working FFmpeg binary path and binds `FFMPEG_BIN` + `FFMPEG_PATH`
 * in `process.env` BEFORE `ziplayer` initializes its Filter/Save controllers.
 *
 * Why this matters: `ziplayer` bundles `ffmpeg-static/index.js` inside its dist bundle,
 * so without `FFMPEG_BIN` set, its internal `__dirname` lookup would point to
 * `node_modules/ziplayer/dist/ffmpeg` instead of `node_modules/ffmpeg-static/ffmpeg`.
 */
export function resolveAndBindFfmpeg() {
    const candidates = [
        process.env.FFMPEG_PATH,
        process.env.FFMPEG_BIN,
        typeof ffmpegStatic === "string" ? ffmpegStatic : null,
    ].filter((v) => Boolean(v && v.trim()));
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            process.env.FFMPEG_BIN = candidate;
            process.env.FFMPEG_PATH = candidate;
            return candidate;
        }
    }
    return null;
}
function parseBool(value, fallback) {
    if (value === undefined || value.trim() === "")
        return fallback;
    const v = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(v))
        return true;
    if (["false", "0", "no", "off"].includes(v))
        return false;
    return fallback;
}
function parseIntClamped(value, fallback, min, max) {
    if (value === undefined || value.trim() === "")
        return fallback;
    const parsed = Number.parseInt(value.trim(), 10);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.min(max, Math.max(min, parsed));
}
function parseDebugLevel(raw) {
    const allowed = ["off", "error", "warn", "info", "debug", "verbose", "time"];
    const normalized = (raw ?? "off").trim().toLowerCase();
    return allowed.includes(normalized) ? normalized : "off";
}
export function loadConfig(env = process.env) {
    const ffmpegPath = resolveAndBindFfmpeg();
    const wakeWordsRaw = env.VOICE_WAKE_WORDS ?? "zi,bot";
    return {
        discordToken: (env.DISCORD_TOKEN ?? env.TOKEN ?? "").trim(),
        clientId: (env.DISCORD_CLIENT_ID ?? env.CLIENT_ID ?? "").trim(),
        guildId: env.DISCORD_GUILD_ID?.trim() || undefined,
        prefix: (env.BOT_PREFIX ?? "!").trim() || "!",
        autoDeployCommands: parseBool(env.AUTO_DEPLOY_COMMANDS, true),
        defaultVolume: parseIntClamped(env.DEFAULT_VOLUME, 80, 0, 100),
        leaveOnEnd: parseBool(env.LEAVE_ON_END, true),
        leaveOnEmpty: parseBool(env.LEAVE_ON_EMPTY, true),
        leaveTimeoutMs: parseIntClamped(env.LEAVE_TIMEOUT_MS, 60_000, 5_000, 3_600_000),
        lowPerformance: parseBool(env.LOW_PERFORMANCE, false),
        crossfadeDurationMs: parseIntClamped(env.CROSSFADE_DURATION_MS, 4_000, 0, 15_000),
        extractorTimeoutMs: parseIntClamped(env.EXTRACTOR_TIMEOUT_MS, 35_000, 5_000, 120_000),
        enablePersistence: parseBool(env.ENABLE_PERSISTENCE, true),
        persistenceFile: (env.PERSISTENCE_FILE ?? "./data/sessions.json").trim(),
        maxSaveDurationSec: parseIntClamped(env.MAX_SAVE_DURATION_SEC, 600, 30, 3_600),
        ttsLang: (env.TTS_LANG ?? "vi").trim() || "vi",
        ttsMaxTimeMs: parseIntClamped(env.TTS_MAX_TIME_MS, 60_000, 5_000, 300_000),
        enableLyrics: parseBool(env.ENABLE_LYRICS, true),
        autoLiveLyrics: parseBool(env.AUTO_LIVE_LYRICS, false),
        enableVoiceCommands: parseBool(env.ENABLE_VOICE_COMMANDS, false),
        voiceLang: (env.VOICE_LANG ?? "vi-VN").trim() || "vi-VN",
        voiceWakeWords: wakeWordsRaw
            .split(",")
            .map((w) => w.trim().toLowerCase())
            .filter(Boolean),
        geminiApiKey: env.GEMINI_API_KEY?.trim() || undefined,
        lavalinkNodes: parseLavalinkNodes(env.LAVALINK_NODES),
        debugLevel: parseDebugLevel(env.ZIPLAYER_DEBUG_LEVEL),
        ffmpegPath,
    };
}
export function assertBotCredentials(config) {
    if (!config.discordToken || config.discordToken === "your_discord_bot_token_here") {
        throw new Error("Thiếu DISCORD_TOKEN hợp lệ trong file .env! Hãy sao chép .env.example sang .env và điền Bot Token từ Discord Developer Portal.");
    }
}
//# sourceMappingURL=config.js.map