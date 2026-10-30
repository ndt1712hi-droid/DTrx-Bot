import { randomBytes } from "node:crypto";
const TOKEN_PREFIX = "dtrx-ac-";
const TOKEN_PATTERN = /^dtrx-ac-[0-9a-f]{32}$/;
const DISCORD_CHOICE_LIMIT = 100;
export class AutocompleteValueStore {
    ttlMs;
    maxEntries;
    now;
    entries = new Map();
    constructor(ttlMs = 5 * 60_000, maxEntries = 500, now = Date.now) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.now = now;
        if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) {
            throw new RangeError("Autocomplete cache limits must be positive");
        }
    }
    encode(value, scope) {
        if (value.length <= DISCORD_CHOICE_LIMIT)
            return value;
        this.removeExpired();
        while (this.entries.size >= this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (!oldest)
                break;
            this.entries.delete(oldest);
        }
        let token;
        do {
            token = `${TOKEN_PREFIX}${randomBytes(16).toString("hex")}`;
        } while (this.entries.has(token));
        this.entries.set(token, { value, scope: { ...scope }, expiresAt: this.now() + this.ttlMs });
        return token;
    }
    /** Returns null for an expired, foreign or unrecognized selection token. */
    resolve(value, scope) {
        if (!TOKEN_PATTERN.test(value))
            return value;
        this.removeExpired();
        const saved = this.entries.get(value);
        if (!saved || saved.scope.userId !== scope.userId || saved.scope.guildId !== scope.guildId ||
            saved.scope.commandName !== scope.commandName)
            return null;
        return saved.value;
    }
    removeExpired() {
        const now = this.now();
        for (const [token, entry] of this.entries) {
            if (entry.expiresAt <= now)
                this.entries.delete(token);
        }
    }
}
//# sourceMappingURL=autocompleteValues.js.map