import { YouTubePlugin, type PluginOptions } from "@ziplayer/plugin";
import type { SearchResult, StreamInfo, Track } from "ziplayer";
/**
 * The installed YouTube plugin treats an empty `basic_info` object as a valid
 * video when YouTube returns LOGIN_REQUIRED. It can then queue `id: undefined`
 * and search for "Unknown title" as a fallback. Repair exact video metadata via
 * the public text-search method, and never return malformed tracks.
 */
export declare class ResilientYouTubePlugin extends YouTubePlugin {
    private readonly fallbackBudgetMs;
    constructor(options?: PluginOptions, fallbackBudgetMs?: number);
    getFallback(track: Track, signal?: AbortSignal): Promise<StreamInfo>;
    search(query: string, requestedBy: string): Promise<SearchResult>;
    private findExactById;
    /**
     * ZiPlayer's current Mix helper tries full info per recommendation. If the
     * full response has an empty basic_info, it never falls back to the valid
     * lightweight feed item. This guarded adapter uses that existing builder;
     * it is deliberately isolated because those two helper names are private
     * dependency internals and may change when @ziplayer/plugin is upgraded.
     */
    private repairMixFeedFallback;
}
