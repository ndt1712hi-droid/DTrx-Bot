import type { BotConfig } from "./types/bot.js";
/**
 * Resolves a working FFmpeg binary path (from env, ffmpeg-static, or system PATH)
 * and binds `FFMPEG_BIN` + `FFMPEG_PATH` in `process.env` BEFORE `ziplayer` initializes.
 */
export declare function resolveAndBindFfmpeg(): string | null;
/**
 * If hosting environments (such as Botkeep's npm allowScripts policy) skipped running
 * `ffmpeg-static/install.js` during `npm install`, run it once on startup so FFmpeg works.
 */
export declare function ensureFfmpegInstalled(): string | null;
export declare function loadConfig(env?: NodeJS.ProcessEnv): BotConfig;
export declare function assertBotCredentials(config: BotConfig): void;
