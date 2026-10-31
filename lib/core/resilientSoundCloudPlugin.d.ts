import { SoundCloudPlugin } from "@ziplayer/plugin";
import type { SearchResult, StreamInfo, Track } from "ziplayer";
/** Keep direct SoundCloud playback unchanged, but select alternate recordings safely. */
export declare class ResilientSoundCloudPlugin extends SoundCloudPlugin {
    private readonly fallbackBudgetMs;
    private nextInitializationRetry;
    constructor(fallbackBudgetMs?: number);
    private ensureReady;
    search(query: string, requestedBy: string): Promise<SearchResult>;
    getStream(track: Track): Promise<StreamInfo>;
    getFallback(track: Track, signal?: AbortSignal): Promise<StreamInfo>;
}
