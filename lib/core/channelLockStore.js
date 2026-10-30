import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
/** Only these @everyone channel overwrites are changed by /lock. */
export const LOCKED_PERMISSIONS = ["SendMessages", "SendMessagesInThreads", "CreatePublicThreads", "CreatePrivateThreads"];
function cloneRecord(record) {
    return { ...record, everyone: { ...record.everyone, permissions: { ...record.everyone.permissions } }, bot: { ...record.bot } };
}
/** Durable write-ahead snapshots permit safe /unlock after restarts or partial Discord failures. */
export class ChannelLockStore {
    filePath;
    records = new Map();
    loadPromise;
    loadError = null;
    writeTail = Promise.resolve();
    constructor(filePath) {
        this.filePath = path.resolve(filePath);
        this.loadPromise = this.load().catch((err) => {
            this.loadError = err instanceof Error ? err : new Error(String(err));
        });
    }
    async ready() {
        await this.loadPromise;
        if (this.loadError)
            throw new Error(`Không thể đọc dữ liệu khóa kênh: ${this.loadError.message}`);
    }
    async flush() { await this.writeTail; await this.ready(); }
    async get(guildId, channelId) {
        await this.ready();
        const record = this.records.get(this.key(guildId, channelId));
        return record ? cloneRecord(record) : undefined;
    }
    async put(record) {
        if (!this.validRecord(record))
            throw new Error("Bản lưu khóa kênh không hợp lệ");
        const snapshot = cloneRecord(record);
        await this.enqueue(async () => {
            const next = new Map(this.records);
            next.set(this.key(snapshot.guildId, snapshot.channelId), snapshot);
            await this.write(next);
            this.records = next;
        });
    }
    async remove(guildId, channelId) {
        await this.enqueue(async () => {
            const next = new Map(this.records);
            next.delete(this.key(guildId, channelId));
            await this.write(next);
            this.records = next;
        });
    }
    enqueue(work) {
        const result = this.writeTail.then(async () => { await this.ready(); return work(); });
        this.writeTail = result.then(() => undefined, () => undefined);
        return result;
    }
    key(guildId, channelId) { return JSON.stringify([guildId, channelId]); }
    validId(value) {
        return typeof value === "string" && value.length > 0 && value.length <= 100 && value.trim() === value;
    }
    validState(value) { return value === null || typeof value === "boolean"; }
    validRecord(value) {
        if (!value || typeof value !== "object")
            return false;
        const entry = value;
        return this.validId(entry.guildId) && this.validId(entry.channelId) && this.validId(entry.botId) &&
            (entry.phase === "pending" || entry.phase === "locked") &&
            Boolean(entry.everyone && typeof entry.everyone.existed === "boolean" && entry.everyone.permissions &&
                LOCKED_PERMISSIONS.every((name) => this.validState(entry.everyone.permissions[name]))) &&
            Boolean(entry.bot && typeof entry.bot.existed === "boolean" && typeof entry.bot.changed === "boolean" &&
                this.validState(entry.bot.sendMessages));
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
        if (!Array.isArray(parsed) || parsed.some((entry) => !this.validRecord(entry)))
            throw new Error("Tệp dữ liệu khóa kênh không đúng định dạng");
        const next = new Map();
        for (const record of parsed) {
            const key = this.key(record.guildId, record.channelId);
            if (next.has(key))
                throw new Error("Tệp dữ liệu khóa kênh có mục trùng");
            next.set(key, cloneRecord(record));
        }
        this.records = next;
    }
    async write(records) {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const temp = `${this.filePath}.${randomUUID()}.tmp`;
        try {
            const sorted = [...records.values()].sort((a, b) => a.guildId.localeCompare(b.guildId) || a.channelId.localeCompare(b.channelId));
            await fs.writeFile(temp, JSON.stringify(sorted, null, 2), { encoding: "utf8", mode: 0o600 });
            await fs.rename(temp, this.filePath);
        }
        finally {
            await fs.unlink(temp).catch(() => undefined);
        }
    }
}
//# sourceMappingURL=channelLockStore.js.map