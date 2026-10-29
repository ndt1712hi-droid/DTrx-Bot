import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import dotenv from "dotenv";
import ffmpegStatic from "ffmpeg-static";
import { parseLavalinkNodes } from "./utils/format.js";
dotenv.config();
/**
 * Resolves a working FFmpeg binary path (from env, ffmpeg-static, or system PATH)
 * and binds `FFMPEG_BIN` + `FFMPEG_PATH` in `process.env` BEFORE `ziplayer` initializes.
 */
export function resolveAndBindFfmpeg() {
    const candidates = [
        process.env.FFMPEG_PATH,
        process.env.FFMPEG_BIN,
        typeof ffmpegStatic === "string" ? ffmpegStatic : null,
        "/usr/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/bin/ffmpeg",
    ].filter((v) => Boolean(v && v.trim()));
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            process.env.FFMPEG_BIN = candidate;
            process.env.FFMPEG_PATH = candidate;
            return candidate;
        }
    }
    const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    if (probe.status === 0) {
        process.env.FFMPEG_BIN = "ffmpeg";
        process.env.FFMPEG_PATH = "ffmpeg";
        return "ffmpeg";
    }
    return null;
}
/**
 * If hosting environments (such as Botkeep's npm allowScripts policy) skipped running
 * `ffmpeg-static/install.js` during `npm install`, run it once on startup so FFmpeg works.
 */
export function ensureFfmpegInstalled() {
    const existing = resolveAndBindFfmpeg();
    if (existing)
        return existing;
    try {
        const req = createRequire(import.meta.url);
        const pkgJsonPath = req.resolve("ffmpeg-static/package.json");
        const installScript = path.join(path.dirname(pkgJsonPath), "install.js");
        if (fs.existsSync(installScript)) {
            console.log("📦 Đang tải tự động binary FFmpeg cho môi trường host...");
            spawnSync(process.execPath, [installScript], { stdio: "inherit", timeout: 120_000 });
        }
    }
    catch {
        // Ignore and fall back to resolve check
    }
    return resolveAndBindFfmpeg();
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
        lowPerformance: parseBool(env.LOW_PERFORMANCE, true),
        crossfadeDurationMs: parseIntClamped(env.CROSSFADE_DURATION_MS, 4_000, 0, 15_000),
        extractorTimeoutMs: parseIntClamped(env.EXTRACTOR_TIMEOUT_MS, 35_000, 5_000, 120_000),
        enablePersistence: parseBool(env.ENABLE_PERSISTENCE, true),
        persistenceFile: (env.PERSISTENCE_FILE ?? "./data/sessions.json").trim(),
        maxSaveDurationSec: parseIntClamped(env.MAX_SAVE_DURATION_SEC, 300, 30, 3_600),
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