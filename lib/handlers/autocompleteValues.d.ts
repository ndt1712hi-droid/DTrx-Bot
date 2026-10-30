/** Discord limits autocomplete choice values to 100 characters, even though
 * users can enter longer string options. Keep long values intact in a small,
 * temporary, user- and guild-scoped cache instead of truncating their URLs. */
export interface AutocompleteScope {
    userId: string;
    guildId: string | null;
    commandName: string;
}
export declare class AutocompleteValueStore {
    private readonly ttlMs;
    private readonly maxEntries;
    private readonly now;
    private readonly entries;
    constructor(ttlMs?: number, maxEntries?: number, now?: () => number);
    encode(value: string, scope: AutocompleteScope): string;
    /** Returns null for an expired, foreign or unrecognized selection token. */
    resolve(value: string, scope: AutocompleteScope): string | null;
    private removeExpired;
}
