import { YouTubePlugin } from "@ziplayer/plugin";
import { resolveSimilarMusic } from "./similarMusicFallback.js";
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
function usableTrack(track) {
    return Boolean(track && typeof track.id === "string" && VIDEO_ID.test(track.id) &&
        typeof track.title === "string" && track.title.trim() &&
        track.title !== "Unknown title" && track.title !== "undefined" &&
        typeof track.url === "string" && /^https?:\/\//i.test(track.url));
}
function youtubeTarget(query) {
    let url;
    try {
        url = new URL(query);
    }
    catch {
        return null;
    }
    const host = url.hostname.toLowerCase();
    if (!["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"].includes(host))
        return null;
    const listId = url.searchParams.get("list") ?? "";
    const pathId = host.endsWith("youtu.be")
        ? url.pathname.split("/").filter(Boolean)[0]
        : url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/]+)/)?.[1];
    let id = url.searchParams.get("v") || pathId || null;
    if (!id && /^RD[A-Za-z0-9_-]{11}$/.test(listId))
        id = listId.slice(2);
    return { id: id && VIDEO_ID.test(id) ? id : null, isMix: listId.toUpperCase().startsWith("RD") };
}
/**
 * The installed YouTube plugin treats an empty `basic_info` object as a valid
 * video when YouTube returns LOGIN_REQUIRED. It can then queue `id: undefined`
 * and search for "Unknown title" as a fallback. Repair exact video metadata via
 * the public text-search method, and never return malformed tracks.
 */
export class ResilientYouTubePlugin extends YouTubePlugin {
    fallbackBudgetMs;
    constructor(options, fallbackBudgetMs = 25_000) {
        super(options);
        this.fallbackBudgetMs = fallbackBudgetMs;
        this.repairMixFeedFallback();
    }
    async getFallback(track, signal) {
        return resolveSimilarMusic({
            requested: track, source: this.name, signal, budgetMs: this.fallbackBudgetMs,
            search: (query, requestedBy) => this.search(query, requestedBy),
            open: (candidate, candidateSignal) => this.getStream(candidate, candidateSignal),
        });
    }
    async search(query, requestedBy) {
        const result = await super.search(query, requestedBy);
        const original = result.tracks ?? [];
        const tracks = original.filter(usableTrack);
        const target = youtubeTarget(query);
        if (target?.id && !result.playlist) {
            // The plugin may fall back to a text search containing other videos.
            // A URL must resolve to the exact ID, never the first unrelated result.
            let exact = tracks.find((track) => track.id === target.id);
            if (!exact)
                exact = await this.findExactById(target.id, requestedBy);
            if (!exact && original.length)
                console.warn(`[YouTube] Không lấy được thông tin video ${target.id}; bỏ qua kết quả không hợp lệ.`);
            return { ...result, tracks: exact ? [exact] : [] };
        }
        if (result.playlist && target?.isMix && target.id && (!usableTrack(original[0]) || original[0].id !== target.id)) {
            const feedTracks = original.slice(1).filter(usableTrack);
            const anchor = feedTracks.find((track) => track.id === target.id) ?? await this.findExactById(target.id, requestedBy);
            if (!anchor) {
                console.warn(`[YouTube] Không lấy được video đầu của Mix ${target.id}; không thay bằng bài khác.`);
                return { ...result, tracks: [] };
            }
            // The same anchor can appear in the recommendation feed.
            const seen = new Set();
            return {
                ...result,
                tracks: [anchor, ...feedTracks].filter((track) => {
                    if (seen.has(track.id))
                        return false;
                    seen.add(track.id);
                    return true;
                }),
            };
        }
        if (tracks.length !== original.length) {
            console.warn(`[YouTube] Bỏ qua ${original.length - tracks.length} mục thiếu thông tin trong kết quả.`);
        }
        return { ...result, tracks };
    }
    async findExactById(id, requestedBy) {
        try {
            const fallback = await super.search(id, requestedBy);
            return fallback.tracks?.find((track) => usableTrack(track) && track.id === id);
        }
        catch {
            return undefined;
        }
    }
    /**
     * ZiPlayer's current Mix helper tries full info per recommendation. If the
     * full response has an empty basic_info, it never falls back to the valid
     * lightweight feed item. This guarded adapter uses that existing builder;
     * it is deliberately isolated because those two helper names are private
     * dependency internals and may change when @ziplayer/plugin is upgraded.
     */
    repairMixFeedFallback() {
        const compat = this;
        if (typeof compat.resolveFeedTrackViaFullInfo !== "function" || typeof compat.buildTrack !== "function")
            return;
        const resolve = compat.resolveFeedTrackViaFullInfo.bind(this);
        const build = compat.buildTrack.bind(this);
        compat.resolveFeedTrackViaFullInfo = async (item, requestedBy, options) => {
            const track = await resolve(item, requestedBy, options);
            if (usableTrack(track) || options?.fallbackToLightweight === false)
                return track;
            const lightweight = build(item, requestedBy, { playlist: options?.listId });
            return usableTrack(lightweight) ? lightweight : null;
        };
    }
}
//# sourceMappingURL=resilientYouTubePlugin.js.map