import { SoundCloudPlugin } from "@ziplayer/plugin";
import { firstBytesReady, resolveSimilarMusic } from "./similarMusicFallback.js";
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
    async getStream(track, signal) {
        await this.ensureReady();
        const info = await super.getStream(track);
        try {
            if (!info?.stream)
                throw new Error("SoundCloud returned no audio stream");
            const startTimeoutMs = Math.max(250, Math.min(8_000, this.fallbackBudgetMs - 750));
            await firstBytesReady(info.stream, startTimeoutMs, signal);
            return info;
        }
        catch (error) {
            info?.stream?.destroy();
            throw error;
        }
    }
    async getFallback(track, signal) {
        return resolveSimilarMusic({
            requested: track, source: this.name, signal, budgetMs: this.fallbackBudgetMs,
            search: (query, requestedBy) => this.search(query, requestedBy),
            // The upstream extractor itself does not accept AbortSignal; our
            // first-byte check and the bounded resolver still dispose late streams.
            open: (candidate, candidateSignal) => this.getStream(candidate, candidateSignal),
        });
    }
}
//# sourceMappingURL=resilientSoundCloudPlugin.js.map