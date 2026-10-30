/**
 * Normalize only common shared-link forms that the upstream extractors cannot
 * parse. Ordinary HTTP URLs (especially signed audio-file links) and their
 * query parameters are otherwise left byte-for-byte intact after trimming.
 */
export declare function normalizeMusicQuery(input: string): string;
export declare function isDirectMusicQuery(input: string): boolean;
