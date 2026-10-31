import type { Readable } from "node:stream";
import type { SearchResult, StreamInfo, Track } from "ziplayer";

const MAX_SEARCHES = 3;
const MAX_STREAM_ATTEMPTS = 3;
const MAX_RESULTS_PER_SEARCH = 10;
const DEFAULT_BUDGET_MS = 25_000;
const SEARCH_TIMEOUT_MS = 7_000;
const STREAM_TIMEOUT_MS = 10_000;
const FIRST_BYTE_TIMEOUT_MS = 5_000;
const GENERIC_WORDS = new Set([
	"a", "the", "and", "va", "x", "ft", "feat", "featuring", "official", "video", "audio", "mv", "lyrics", "lyric",
	"visualizer", "version", "ver", "hd", "hq", "full", "prod", "by", "music", "mp3", "m4a", "webm",
]);
const VERSION_WORDS = new Set(["live", "stage", "remix", "karaoke", "instrumental", "cover", "remaster", "remastered"]);

class FallbackTimeoutError extends Error {}

function words(value: string): Set<string> {
	const normalized = value.slice(0, 300).normalize("NFKD").replace(/\p{M}/gu, "").replace(/[đĐ]/g, "d")
		.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
	return new Set(normalized.split(/\s+/u).filter((word) => word && !GENERIC_WORDS.has(word)).slice(0, 32));
}

function header(value: string): string {
	return value.slice(0, 300).split(/[|｜]/u, 1)[0].replace(/\s+/gu, " ").trim();
}

function identityHeader(value: string): string {
	const left = header(value);
	const right = value.slice(0, 300).split(/[|｜]/u)[1]?.replace(/\s+/gu, " ").trim();
	// A short "artist | song" or "song | artist" is identity, not a tagline.
	// When the left side already identifies both parts, keep only that side.
	if (!right || /\s+[-–—]\s+|[–—]/u.test(left)) return left;
	const rightWords = words(right);
	const promo = /\b(?:official|video|audio|mv|lyrics|lyric|live|stage|remix|karaoke|visualizer|trailer|full)\b/iu.test(right);
	return rightWords.size > 0 && rightWords.size <= 5 && !promo ? `${left} – ${right}` : left;
}

/** Bounded search variants avoid over-specific video descriptions without changing URLs or track titles. */
export function similarSearchQueries(title: string, artist = ""): string[] {
	const original = title.slice(0, 200).replace(/\s+/gu, " ").trim();
	const concise = identityHeader(title).slice(0, 200);
	const simplified = concise.replace(/[()[\]{}]/gu, " ").replace(/\b(?:feat|ft|x)\b/giu, " ")
		.replace(/[-–—_]+/gu, " ").replace(/\s+/gu, " ").trim();
	const withArtist = artist.trim() ? `${concise} ${artist.slice(0, 80).trim()}`.trim() : "";
	return [...new Set([withArtist, original, concise, simplified].filter(Boolean))].slice(0, MAX_SEARCHES);
}

function searchArtist(track: Track): string {
	// Spotify explicitly provides the artist. YouTube's uploader is often a
	// television channel, so do not append that less reliable value to queries.
	const artist = track.source?.toLowerCase() === "spotify" ? track.metadata?.artist : track.author;
	return typeof artist === "string" ? artist : "";
}

function requestedArtist(track: Track): string {
	// An uploader can still be a useful hint; a candidate need not have the same uploader.
	const known = searchArtist(track);
	const uploader = track.metadata?.author;
	return known || (typeof uploader === "string" ? uploader : "");
}

function coverage(required: Set<string>, available: Set<string>): number {
	if (!required.size) return 0;
	let shared = 0;
	for (const word of required) if (available.has(word)) shared++;
	return shared / required.size;
}

/** Conservative, accent-insensitive title matching. It is a heuristic, not proof of the same recording. */
export function scoreSimilarMusic(requested: Track, candidate: Track): number {
	if (!requested?.title || !candidate?.title || !candidate?.id || !candidate?.url) return 0;
	const cleanRequested = identityHeader(requested.title);
	const expected = words(cleanRequested), actual = words(candidate.title);
	if (!expected.size || !actual.size) return 0;
	const titleCoverage = coverage(expected, actual);
	const rawSegments = cleanRequested.split(/\s+[-–—]\s+|\s*[–—]\s*/u).filter((part) => words(part).size);
	const segments = rawSegments.map(words);
	let artistSegment = -1;
	if (segments.length === 2) {
		const artist = words(requestedArtist(requested));
		if (artist.size) artistSegment = segments.findIndex((part) => coverage(artist, part) >= 0.75);
		if (artistSegment < 0) {
			const collaborations = rawSegments.map((part) => /\b(?:x|feat|ft|featuring)\b/iu.test(part));
			if (collaborations[0] !== collaborations[1]) artistSegment = collaborations[0] ? 0 : 1;
		}
	}
	if (artistSegment >= 0) {
		// If the performer is identifiable, require the *song* segment but
		// allow another performer when no closer recording is available.
		const song = new Set([...segments[1 - artistSegment]].filter((word) => !VERSION_WORDS.has(word)));
		if (!song.size || coverage(song, actual) < 0.8) return 0;
	} else {
		if (titleCoverage < (expected.size <= 2 ? 1 : 0.55)) return 0;
		// Ambiguous "artist – song" / "song – artist": match both parts so a
		// different song from the same artist is not silently substituted.
		if (segments.length >= 2 && segments.slice(0, 2).some((part) => coverage(part, actual) < 0.5)) return 0;
		const candidateSegments = identityHeader(candidate.title).split(/\s+[-–—]\s+|\s*[–—]\s*/u).map(words).filter((part) => part.size);
		if (segments.length === 2 && candidateSegments.length >= 2) {
			const isPartMatch = (expectedPart: Set<string>, actualPart: Set<string>): boolean => {
				if (coverage(expectedPart, actualPart) < 0.8) return false;
				const meaningful = [...actualPart].filter((word) => !VERSION_WORDS.has(word));
				return expectedPart.size > 1 || meaningful.length === 1;
			};
			const forward = isPartMatch(segments[0], candidateSegments[0]) && isPartMatch(segments[1], candidateSegments[1]);
			const reverse = isPartMatch(segments[0], candidateSegments[1]) && isPartMatch(segments[1], candidateSegments[0]);
			if (!forward && !reverse) return 0;
		} else if (segments.length === 1 && expected.size <= 2) {
			// A one-word song must not match an unrelated longer title merely
			// because it contains that common word. Allow artist/version labels.
			const artist = words(requestedArtist(requested));
			const exactTitleSegment = candidateSegments.some((part) => {
				const meaningful = new Set([...part].filter((word) => !VERSION_WORDS.has(word) && !artist.has(word)));
				return meaningful.size === expected.size && coverage(expected, meaningful) === 1;
			});
			if (!exactTitleSegment) return 0;
		}
	}

	// Avoid short previews and extremely long mixes when useful durations are
	// available. A long concert may name one song, so do not reject a normal
	// song-length version merely because the requested video lasts hours.
	const originalDuration = Number(requested.duration), alternateDuration = Number(candidate.duration);
	if (Number.isFinite(originalDuration) && Number.isFinite(alternateDuration) && originalDuration >= 60_000 && alternateDuration > 0) {
		const minimum = originalDuration <= 20 * 60_000 ? Math.max(45_000, originalDuration * 0.4) : 45_000;
		if (alternateDuration < minimum || alternateDuration > originalDuration * 3) return 0;
	}

	const precision = coverage(actual, expected);
	const requestedVersion = words(requested.title), candidateVersion = words(candidate.title);
	let versionPenalty = 0;
	for (const version of ["remix", "karaoke", "instrumental", "cover"]) {
		if (!requestedVersion.has(version) && candidateVersion.has(version)) versionPenalty += 0.04;
	}
	const artist = words(requestedArtist(requested));
	const candidateArtistText = [candidate.title, candidate.author, candidate.metadata?.author, candidate.metadata?.artist]
		.filter((value): value is string => typeof value === "string").join(" ");
	const artistBonus = artist.size ? 0.2 * coverage(artist, words(candidateArtistText)) : 0;
	const exactTrackBonus = requested.source?.toLowerCase() === candidate.source?.toLowerCase() && requested.id === candidate.id ? 0.3 : 0;
	const durationRatio = originalDuration > 0 && alternateDuration > 0
		? Math.min(originalDuration, alternateDuration) / Math.max(originalDuration, alternateDuration) : 0;
	const durationBonus = durationRatio >= 0.75 ? 0.05 : durationRatio >= 0.5 ? 0.025 : 0;
	return Math.max(0, 0.75 * titleCoverage + 0.25 * precision + artistBonus + exactTrackBonus + durationBonus - versionPenalty);
}

function abortReason(signal?: AbortSignal): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	return new Error("Music fallback aborted");
}

function bounded<T>(
	promise: Promise<T>, milliseconds: number, signal?: AbortSignal,
	onTimeout?: () => void, disposeLate?: (value: T) => void,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let finished = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error) => {
			if (finished) return;
			finished = true; cleanup(); onTimeout?.(); reject(error);
		};
		const onAbort = () => fail(abortReason(signal));
		if (signal?.aborted) onAbort();
		else {
			signal?.addEventListener("abort", onAbort, { once: true });
			timer = setTimeout(() => fail(new FallbackTimeoutError("Music fallback timed out")), Math.max(1, milliseconds));
		}
		promise.then((value) => {
			if (finished) {
				try { disposeLate?.(value); } catch { /* already abandoned */ }
				return;
			}
			finished = true; cleanup(); resolve(value);
		}, (error: unknown) => {
			if (finished) return;
			finished = true; cleanup(); reject(error);
		});
	});
}

/** Check that data arrives without consuming the first chunk needed by the player. */
function firstBytesReady(stream: Readable, milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let finished = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			stream.removeListener("readable", onReadable);
			stream.removeListener("end", onEnd);
			stream.removeListener("close", onClose);
			stream.removeListener("error", onError);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (error?: Error) => {
			if (finished) return;
			finished = true; cleanup(); error ? reject(error) : resolve();
		};
		const onReadable = () => {
			if (stream.readableLength > 0) finish();
			else stream.read(0); // Enables 'end' for an empty stream without consuming bytes.
		};
		const onEnd = () => finish(new Error("Fallback stream ended without data"));
		const onClose = () => finish(new Error("Fallback stream closed without data"));
		const onError = (error: Error) => finish(error);
		const onAbort = () => finish(abortReason(signal));
		if (signal?.aborted) { onAbort(); return; }
		if (stream.destroyed || stream.readableEnded) { onEnd(); return; }
		if (stream.readableLength > 0) { finish(); return; }
		stream.on("readable", onReadable);
		stream.once("end", onEnd);
		stream.once("close", onClose);
		stream.once("error", onError);
		signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(() => finish(new FallbackTimeoutError("Fallback stream produced no data in time")), Math.max(1, milliseconds));
		onReadable();
	});
}

export interface SimilarFallbackOptions {
	requested: Track;
	source: string;
	search: (query: string, requestedBy: string) => Promise<SearchResult>;
	open: (track: Track, signal: AbortSignal) => Promise<StreamInfo>;
	signal?: AbortSignal;
	budgetMs?: number;
}

/** Try a few related recordings after the original source fails; never claim a different recording is the original. */
export async function resolveSimilarMusic(options: SimilarFallbackOptions): Promise<StreamInfo> {
	const { requested, source, search, open, signal } = options;
	const budgetMs = Math.max(1_000, Math.min(options.budgetMs ?? DEFAULT_BUDGET_MS, DEFAULT_BUDGET_MS));
	const deadline = Date.now() + budgetMs;
	const remaining = () => Math.max(0, deadline - Date.now());
	const found = new Map<string, { track: Track; score: number }>();
	let searches = 0, searchErrors = 0, attempts = 0;
	// Save part of the time budget to actually open a candidate after searching.
	const reserveMs = Math.min(5_000, Math.floor(budgetMs * 0.4));
	for (const query of similarSearchQueries(requested.title ?? "", searchArtist(requested))) {
		if (signal?.aborted) throw abortReason(signal);
		if (remaining() <= reserveMs) break;
		let result: SearchResult;
		searches++;
		try {
			result = await bounded(Promise.resolve().then(() => search(query, requested.requestedBy || "fallback")),
				Math.min(SEARCH_TIMEOUT_MS, remaining() - reserveMs), signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			searchErrors++;
			// A search that ignored cancellation may still be running: do not start
			// another search concurrently, but use any candidates already obtained.
			if (error instanceof FallbackTimeoutError) break;
			continue;
		}
		for (const track of (result.tracks ?? []).slice(0, MAX_RESULTS_PER_SEARCH)) {
			if (track.source?.toLowerCase() !== source.toLowerCase()) continue;
			const score = scoreSimilarMusic(requested, track);
			if (!score) continue;
			const key = `${track.source}\u0000${track.id}`;
			if (!found.has(key) || found.get(key)!.score < score) found.set(key, { track, score });
		}
	}

	const ranked = [...found.values()].sort((a, b) => b.score - a.score).slice(0, MAX_STREAM_ATTEMPTS);
	for (const { track } of ranked) {
		if (signal?.aborted) throw abortReason(signal);
		if (!remaining()) throw new FallbackTimeoutError("Music fallback timed out");
		attempts++;
		const controller = new AbortController();
		const forwardAbort = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", forwardAbort, { once: true });
		let info: StreamInfo | undefined;
		try {
			info = await bounded<StreamInfo>(Promise.resolve().then(() => open(track, controller.signal)), Math.min(STREAM_TIMEOUT_MS, remaining()), signal,
				() => controller.abort(), (late) => { late?.stream?.destroy(); });
			if (!info.stream) throw new Error("Fallback did not return an audio stream");
			await firstBytesReady(info.stream, Math.min(FIRST_BYTE_TIMEOUT_MS, remaining()), signal);
			return { ...info, metadata: { ...info.metadata, title: track.title, originalTitle: requested.title, fallbackSource: source } };
		} catch (error) {
			controller.abort();
			info?.stream?.destroy();
			if (signal?.aborted || (error instanceof FallbackTimeoutError && !info)) throw error;
		} finally {
			signal?.removeEventListener("abort", forwardAbort);
		}
	}
	// Counts help diagnose hosting/provider failures without logging URLs, tokens,
	// signed media addresses or user search text.
	console.warn(`[MusicFallback] source=${source} searches=${searches} searchErrors=${searchErrors} matches=${found.size} attempts=${attempts} noStream`);
	throw new Error(`No suitable ${source} fallback stream`);
}
