import { SoundCloudPlugin } from "@ziplayer/plugin";
import type { SearchResult, StreamInfo, Track } from "ziplayer";
import { resolveSimilarMusic } from "./similarMusicFallback.js";

// The locked upstream version starts two promises during construction without
// handling their rejection. Its fields are TypeScript-private, not #private.
type SoundCloudInternals = {
	ready: Promise<void>;
	client: { init(): Promise<unknown>; _initPromise?: Promise<unknown> | null };
};

/** Keep direct SoundCloud playback unchanged, but select alternate recordings safely. */
export class ResilientSoundCloudPlugin extends SoundCloudPlugin {
	private nextInitializationRetry = 0;

	constructor(private readonly fallbackBudgetMs = 25_000) {
		super();
		const internals = this as unknown as SoundCloudInternals;
		// Attach rejection handlers immediately, including the client's separate
		// auto-init promise, so an offline host doesn't crash the entire bot.
		void internals.ready.catch(() => console.warn("[SoundCloud] Chưa khởi tạo được nguồn; sẽ thử lại khi cần."));
		void internals.client?._initPromise?.catch(() => undefined);
	}

	private async ensureReady(): Promise<void> {
		const internals = this as unknown as SoundCloudInternals;
		const previous = internals.ready;
		try { await previous; return; } catch { /* retry below, at most once per minute */ }
		if (internals.ready !== previous) return internals.ready;
		if (Date.now() < this.nextInitializationRetry) throw new Error("SoundCloud initialization is temporarily unavailable");
		this.nextInitializationRetry = Date.now() + 60_000;
		const retry = Promise.resolve().then(() => internals.client.init()).then(() => undefined);
		internals.ready = retry;
		void retry.catch(() => console.warn("[SoundCloud] Chưa kết nối được; tạm giãn lần thử tiếp theo."));
		await retry;
	}

	override async search(query: string, requestedBy: string): Promise<SearchResult> {
		await this.ensureReady();
		return super.search(query, requestedBy);
	}

	override async getStream(track: Track): Promise<StreamInfo> {
		await this.ensureReady();
		return super.getStream(track);
	}

	override async getFallback(track: Track, signal?: AbortSignal): Promise<StreamInfo> {
		return resolveSimilarMusic({
			requested: track, source: this.name, signal, budgetMs: this.fallbackBudgetMs,
			search: (query, requestedBy) => this.search(query, requestedBy),
			// The upstream SoundCloud extractor does not accept AbortSignal; the
			// bounded resolver still destroys a late-returning stream if it times out.
			open: (candidate) => this.getStream(candidate),
		});
	}
}
