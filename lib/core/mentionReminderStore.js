import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
export const MIN_INTERVAL_SECONDS = 5;
export const MAX_INTERVAL_SECONDS = 100;
// Versions through 1.3.0 accepted longer intervals; load those records without silently changing them.
const LEGACY_MAX_INTERVAL_SECONDS = 3600;
export const DEFAULT_INTERVAL_SECONDS = 30;
export const MAX_REMINDERS_PER_RUN = 100;
export const MAX_TRACKED_REMINDER_MESSAGES = 500;
export const MAX_REMINDER_TEXT = 200;
export const DEFAULT_REMINDER_TEXT = "Có lời nhắc dành cho bạn.";
function copy(record) {
    return { guildId: record.guildId, config: record.config ? { ...record.config } : null, messages: record.messages.map((ref) => ({ ...ref })) };
}
/** Durable configuration and a bounded ledger of bot-owned messages; running timers are never persisted. */
export class MentionReminderStore {
    filePath;
    records = new Map();
    loadPromise;
    loadError = null;
    writeTail = Promise.resolve();
    constructor(filePath) {
        this.filePath = path.resolve(filePath);
        this.loadPromise = this.load().catch((err) => { this.loadError = err instanceof Error ? err : new Error(String(err)); });
    }
    async ready() {
        await this.loadPromise;
        if (this.loadError)
            throw new Error(`Không thể đọc cấu hình nhắc tag: ${this.loadError.message}`);
    }
    async flush() { await this.writeTail; await this.ready(); }
    async get(guildId) {
        await this.ready();
        const record = this.records.get(guildId);
        return record ? copy(record) : undefined;
    }
    async setConfig(config) {
        if (!this.validConfig(config))
            throw new Error("Cấu hình nhắc tag không hợp lệ");
        const clean = { ...config, text: config.text.trim() };
        await this.enqueue(async () => {
            const next = new Map(this.records);
            const existing = next.get(clean.guildId);
            next.set(clean.guildId, { guildId: clean.guildId, config: clean, messages: existing?.messages.map((ref) => ({ ...ref })) ?? [] });
            await this.write(next);
            this.records = next;
        });
    }
    async deleteConfig(guildId) {
        return this.enqueue(async () => {
            const existing = this.records.get(guildId);
            if (!existing?.config)
                return false;
            const next = new Map(this.records);
            if (existing.messages.length)
                next.set(guildId, { guildId, config: null, messages: existing.messages.map((ref) => ({ ...ref })) });
            else
                next.delete(guildId);
            await this.write(next);
            this.records = next;
            return true;
        });
    }
    async addMessage(guildId, ref) {
        if (!this.validId(guildId) || !this.validRef(ref))
            throw new Error("Thông tin tin nhắn không hợp lệ");
        await this.enqueue(async () => {
            const existing = this.records.get(guildId);
            if (!existing)
                throw new Error("Cấu hình nhắc tag không còn tồn tại");
            if (existing.messages.some((item) => item.channelId === ref.channelId && item.messageId === ref.messageId))
                return;
            if (existing.messages.length >= MAX_TRACKED_REMINDER_MESSAGES)
                throw new Error("Đã đầy danh sách tin bot; hãy dùng /spam clear");
            const next = new Map(this.records);
            next.set(guildId, { ...copy(existing), messages: [...existing.messages.map((item) => ({ ...item })), { ...ref }] });
            await this.write(next);
            this.records = next;
        });
    }
    async removeMessages(guildId, refs) {
        if (refs.some((ref) => !this.validRef(ref)))
            throw new Error("Thông tin tin nhắn không hợp lệ");
        await this.enqueue(async () => {
            const existing = this.records.get(guildId);
            if (!existing || !refs.length)
                return;
            const keys = new Set(refs.map((ref) => JSON.stringify([ref.channelId, ref.messageId])));
            const remaining = existing.messages.filter((ref) => !keys.has(JSON.stringify([ref.channelId, ref.messageId])));
            const next = new Map(this.records);
            if (!existing.config && remaining.length === 0)
                next.delete(guildId);
            else
                next.set(guildId, { ...copy(existing), messages: remaining.map((ref) => ({ ...ref })) });
            await this.write(next);
            this.records = next;
        });
    }
    enqueue(work) {
        const result = this.writeTail.then(async () => { await this.ready(); return work(); });
        this.writeTail = result.then(() => undefined, () => undefined);
        return result;
    }
    validId(value) { return typeof value === "string" && value.length > 0 && value.length <= 100 && value.trim() === value; }
    validRef(value) {
        if (!value || typeof value !== "object")
            return false;
        const ref = value;
        return this.validId(ref.channelId) && this.validId(ref.messageId);
    }
    validConfig(value, maxIntervalSeconds = MAX_INTERVAL_SECONDS) {
        if (!value || typeof value !== "object")
            return false;
        const config = value;
        return this.validId(config.guildId) && this.validId(config.channelId) && this.validId(config.targetId) &&
            Number.isInteger(config.intervalSeconds) && config.intervalSeconds >= MIN_INTERVAL_SECONDS && config.intervalSeconds <= maxIntervalSeconds &&
            Number.isInteger(config.count) && config.count >= 1 && config.count <= MAX_REMINDERS_PER_RUN &&
            typeof config.text === "string" && Boolean(config.text.trim()) && config.text.length <= MAX_REMINDER_TEXT;
    }
    validRecord(value) {
        if (!value || typeof value !== "object")
            return false;
        const record = value;
        if (!this.validId(record.guildId) || !(record.config === null || this.validConfig(record.config, LEGACY_MAX_INTERVAL_SECONDS)) ||
            (record.config && record.config.guildId !== record.guildId) || !Array.isArray(record.messages) ||
            record.messages.length > MAX_TRACKED_REMINDER_MESSAGES || record.messages.some((ref) => !this.validRef(ref)))
            return false;
        const keys = record.messages.map((ref) => JSON.stringify([ref.channelId, ref.messageId]));
        return new Set(keys).size === keys.length;
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
        if (!Array.isArray(parsed) || parsed.some((item) => !this.validRecord(item)))
            throw new Error("Tệp nhắc tag không đúng định dạng");
        const next = new Map();
        for (const record of parsed) {
            if (next.has(record.guildId))
                throw new Error("Tệp nhắc tag có server trùng");
            next.set(record.guildId, copy(record));
        }
        this.records = next;
    }
    async write(records) {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const temp = `${this.filePath}.${randomUUID()}.tmp`;
        try {
            const values = [...records.values()].sort((a, b) => a.guildId.localeCompare(b.guildId));
            await fs.writeFile(temp, JSON.stringify(values, null, 2), { encoding: "utf8", mode: 0o600 });
            await fs.rename(temp, this.filePath);
        }
        finally {
            await fs.unlink(temp).catch(() => undefined);
        }
    }
}
//# sourceMappingURL=mentionReminderStore.js.map