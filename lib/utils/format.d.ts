import type { LoopMode } from "ziplayer";
import type { LavalinkNodeConfig, VoiceCommandAction } from "../types/bot.js";
/**
 * Truncates text safely to fit Discord embed & component character limits.
 */
export declare function truncate(text: string | undefined | null, maxLength: number): string;
/**
 * Normalizes duration values that plugins might report in either seconds or milliseconds.
 * Note: ZiPlayer plugins typically store duration in milliseconds, except occasional live/zero values.
 */
export declare function normalizeDurationMs(rawDuration: number | undefined | null): number;
/**
 * Formats milliseconds into `mm:ss` or `hh:mm:ss`, or `🔴 LIVE` for live streams.
 */
export declare function formatDuration(ms: number | undefined | null, isLive?: boolean): string;
/**
 * Parses human time expressions into milliseconds:
 * - `"90"` -> 90_000
 * - `"1:30"` -> 90_000
 * - `"01:02:03"` -> 3_723_000
 * - `"2m30s"` / `"1h5m"` / `"45s"` -> ms
 * Returns `null` if invalid or negative.
 */
export declare function parseTimeInput(raw: string): number | null;
/**
 * Returns a clean badge label for a ZiPlayer track source.
 */
export declare function formatSourceBadge(source?: string): string;
/**
 * Human-readable Vietnamese label for loop mode.
 */
export declare function formatLoopMode(mode: LoopMode): string;
/**
 * Cycles loop mode: off -> track -> queue -> off.
 */
export declare function nextLoopMode(current: LoopMode): LoopMode;
/**
 * Sanitizes a track title into a safe MP3 filename.
 */
export declare function sanitizeFilename(title: string): string;
/**
 * Parses `LAVALINK_NODES` environment string.
 * Supports either JSON array OR comma-separated `host:port:password[:secure]`.
 */
export declare function parseLavalinkNodes(raw?: string): LavalinkNodeConfig[];
/**
 * Parses Vietnamese & English spoken voice commands when prefixed by a configured wake word.
 * Example: "zi phát Sơn Tùng", "bot skip", "zi âm lượng 80", "bot tạm dừng".
 */
export declare function parseVoiceCommand(transcript: string, wakeWords: string[]): VoiceCommandAction | null;
