import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
/** Persist 24/7 voice targets independently from the short-lived music queue. */
export class AlwaysOnVoiceStore {
    filePath;
    entries = new Map();
    loadPromise;
    loadError = null;
    writeTail = Promise.resolve();
    constructor(filePath) {
        this.filePath = path.resolve(filePath);
        // Capture read errors immediately so constructing a bot never creates an
        // unhandled rejection. Mutations fail rather than overwrite corrupt data.
        this.loadPromise = this.load().catch((err) => {
            this.loadError = err instanceof Error ? err : new Error(String(err));
        });
    }
    async ready() {
        await this.loadPromise;
        if (this.loadError) {
            throw new Error(`Không thể đọc cấu hình 24/7: ${this.loadError.message}`);
        }
    }
    isEnabled(guildId) {
        return this.entries.has(guildId);
    }
    get(guildId) {
        const target = this.entries.get(guildId);
        return target ? { ...target } : undefined;
    }
    list() {
        return [...this.entries.values()].map((target) => ({ ...target }));
    }
    async set(target) {
        if (!this.isValidTarget(target))
            throw new Error("Cấu hình kênh thoại 24/7 không hợp lệ");
        return this.enqueue(async () => {
            const next = new Map(this.entries);
            next.set(target.guildId, { ...target });
            await this.write(next);
            this.entries = next;
        });
    }
    async remove(guildId) {
        return this.enqueue(async () => {
            if (!this.entries.has(guildId))
                return false;
            const next = new Map(this.entries);
            next.delete(guildId);
            await this.write(next);
            this.entries = next;
            return true;
        });
    }
    enqueue(operation) {
        const result = this.writeTail.then(async () => {
            await this.ready();
            return operation();
        });
        this.writeTail = result.then(() => undefined, () => undefined);
        return result;
    }
    isValidTarget(value) {
        if (!value || typeof value !== "object")
            return false;
        const entry = value;
        return typeof entry.guildId === "string" && entry.guildId.trim().length > 0 &&
            typeof entry.voiceChannelId === "string" && entry.voiceChannelId.trim().length > 0 &&
            typeof entry.textChannelId === "string";
    }
    async load() {
        let raw;
        try {
            raw = await fs.readFile(this.filePath, "utf8");
        }
        catch (err) {
            if (err.code === "ENOENT")
                return;
            throw err;
        }
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.some((item) => !this.isValidTarget(item))) {
            throw new Error("Tệp cấu hình 24/7 không đúng định dạng");
        }
        this.entries = new Map(parsed.map((item) => [item.guildId, { ...item }]));
    }
    async write(entries) {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
        try {
            const values = [...entries.values()].sort((a, b) => a.guildId.localeCompare(b.guildId));
            await fs.writeFile(tempPath, JSON.stringify(values, null, 2), { encoding: "utf8", mode: 0o600 });
            await fs.rename(tempPath, this.filePath);
        }
        finally {
            await fs.unlink(tempPath).catch(() => undefined);
        }
    }
}
//# sourceMappingURL=alwaysOnStore.js.map