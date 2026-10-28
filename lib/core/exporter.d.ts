import { type Player, type Track } from "ziplayer";
export interface ExportMp3Options {
    ffmpegPath: string | null;
    filterName?: string;
    maxDurationSec: number;
    timeoutMs?: number;
}
/**
 * Exports a playing/queued track via `player.save(track)` and transcodes to a valid
 * playable `.mp3` buffer (`libmp3lame`), optionally applying a predefined FFmpeg filter.
 */
export declare function exportTrackToMp3Buffer(player: Player, track: Track, options: ExportMp3Options): Promise<Buffer>;
