import { SoundCloudPlugin } from "@ziplayer/plugin";
import { resolveSimilarMusic } from "./similarMusicFallback.js";
/** Keep direct SoundCloud playback unchanged, but select alternate recordings safely. */
export class ResilientSoundCloudPlugin extends SoundCloudPlugin {
    fallbackBudgetMs;
    nextInitializationRetry = 0;
    constructor(fallbackBudgetMs = 25_000) {
        super();
        this.fallbackBudgetMs = fallbackBudgetMs;
        const internals = this;
        // Attach rejection handlers immediately, including the client's separate
        // auto-init promise, so an offline host doesn't crash the entire bot.
        void internals.ready.catch(() => console.warn("[SoundCloud] Chưa khởi tạo được nguồn; sẽ thử lại khi cần."));
        void internals.client?._initPromise?.catch(() => undefined);
    }
    async ensureReady() {
        const internals = this;
        const previous = internals.ready;
        try {
            await previous;
            return;
        }
        catch { /* retry below, at most once per minute */ }
        if (internals.ready !== previous)
            return internals.ready;
        if (Date.now() < this.nextInitializationRetry)
            throw new Error("SoundCloud initialization is temporarily unavailable");
        this.nextInitializationRetry = Date.now() + 60_000;
        const retry = Promise.resolve().then(() => internals.client.init()).then(() => undefined);
        internals.ready = retry;
        void retry.catch(() => console.warn("[SoundCloud] Chưa kết nối được; tạm giãn lần thử tiếp theo."));
        await retry;
    }
    async search(query, requestedBy) {
        await this.ensureReady();
        return super.search(query, requestedBy);
    }
    async getStream(track) {
        await this.ensureReady();
        return super.getStream(track);
    }
    async getFallback(track, signal) {
        return resolveSimilarMusic({
            requested: track, source: this.name, signal, budgetMs: this.fallbackBudgetMs,
            search: (query, requestedBy) => this.search(query, requestedBy),
            // The upstream SoundCloud extractor does not accept AbortSignal; the
            // bounded resolver still destroys a late-returning stream if it times out.
            open: (candidate) => this.getStream(candidate),
        });
    }
}
//# sourceMappingURL=resilientSoundCloudPlugin.js.map