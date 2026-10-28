import type { BotConfig } from "./types/bot.js";
/**
 * Resolves a working FFmpeg binary path and binds `FFMPEG_BIN` + `FFMPEG_PATH`
 * in `process.env` BEFORE `ziplayer` initializes its Filter/Save controllers.
 *
 * Why this matters: `ziplayer` bundles `ffmpeg-static/index.js` inside its dist bundle,
 * so without `FFMPEG_BIN` set, its internal `__dirname` lookup would point to
 * `node_modules/ziplayer/dist/ffmpeg` instead of `node_modules/ffmpeg-static/ffmpeg`.
 */
export declare function resolveAndBindFfmpeg(): string | null;
export declare function loadConfig(env?: NodeJS.ProcessEnv): BotConfig;
export declare function assertBotCredentials(config: BotConfig): void;
