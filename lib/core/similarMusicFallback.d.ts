import type { SearchResult, StreamInfo, Track } from "ziplayer";
/** Bounded search variants avoid over-specific video descriptions without changing URLs or track titles. */
export declare function similarSearchQueries(title: string, artist?: string): string[];
/** Conservative, accent-insensitive title matching. It is a heuristic, not proof of the same recording. */
export declare function scoreSimilarMusic(requested: Track, candidate: Track): number;
export interface SimilarFallbackOptions {
    requested: Track;
    source: string;
    search: (query: string, requestedBy: string) => Promise<SearchResult>;
    open: (track: Track, signal: AbortSignal) => Promise<StreamInfo>;
    signal?: AbortSignal;
    budgetMs?: number;
}
/** Try a few related recordings after the original source fails; never claim a different recording is the original. */
export declare function resolveSimilarMusic(options: SimilarFallbackOptions): Promise<StreamInfo>;
