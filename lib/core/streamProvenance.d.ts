import type { BasePlugin, Player, Track } from "ziplayer";
export interface PlaybackFallback {
    source: string;
    id: string;
    title: string;
}
/** Include the actual track in StreamInfo so ZiPlayer's fallback resolver does
 * not silently make a different recording look like the requested one. */
export declare function tracePluginStreams<T extends BasePlugin>(plugin: T): T;
/** Record only the final stream selected by ZiPlayer, not every attempted
 * fallback. Per-player weak maps avoid stale persisted state and cross-guild
 * interference when the search cache shares track objects. */
export declare function installStreamProvenance(player: Player): void;
export declare function getPlaybackFallback(player: Player, track: Track | null | undefined): PlaybackFallback | undefined;
