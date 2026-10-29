import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
export const MAX_AUTO_REPLY_RULES = 20;
export const MAX_AUTO_REPLY_TRIGGER = 100;
export const MAX_AUTO_REPLY_TEXT = 2_000;
/** Whole-message matching, tolerant of surrounding whitespace and Vietnamese casing. */
export function normalizeAutoReplyTrigger(text) {
    return text.trim().normalize("NFC").toLocaleLowerCase("vi");
}
/** Per-server auto-replies, kept independently from music and 24/7 sessions. */
export class AutoReplyStore {
    filePath;
    rules = new Map();
    loadPromise;
    loadError = null;
    writeTail = Promise.resolve();
    constructor(filePath) {
        this.filePath = path.resolve(filePath);
        // Capture the initial read failure immediately; never overwrite a bad file.
        this.loadPromise = this.load().catch((err) => {
            this.loadError = err instanceof Error ? err : new Error(String(err));
        });
    }
    async ready() {
        await this.loadPromise;
        if (this.loadError)
            throw new Error(`Không thể đọc cấu hình trả lời tự động: ${this.loadError.message}`);
    }
    async flush() {
        await this.writeTail;
        await this.ready();
    }
    async find(guildId, message) {
        await this.ready();
        const key = normalizeAutoReplyTrigger(message);
        if (!key)
            return undefined;
        return this.rules.get(guildId)?.get(key)?.reply;
    }
    async list(guildId) {
        await this.ready();
        return [...(this.rules.get(guildId)?.values() ?? [])]
            .map((rule) => ({ ...rule }))
            .sort((a, b) => a.trigger.localeCompare(b.trigger, "vi"));
    }
    async set(rule) {
        if (!rule || typeof rule.guildId !== "string" || typeof rule.trigger !== "string" || typeof rule.reply !== "string") {
            throw new Error("Cấu hình trả lời tự động không hợp lệ");
        }
        const clean = { guildId: rule.guildId, trigger: rule.trigger.trim().normalize("NFC"), reply: rule.reply };
        if (!this.isValidRule(clean)) {
            throw new Error(`Câu kích hoạt phải có 1–${MAX_AUTO_REPLY_TRIGGER} ký tự và câu trả lời phải có 1–${MAX_AUTO_REPLY_TEXT} ký tự`);
        }
        return this.enqueue(async () => {
            const key = normalizeAutoReplyTrigger(clean.trigger);
            const previousGuild = this.rules.get(clean.guildId);
            if (!previousGuild?.has(key) && (previousGuild?.size ?? 0) >= MAX_AUTO_REPLY_RULES) {
                throw new Error(`Mỗi server chỉ được lưu tối đa ${MAX_AUTO_REPLY_RULES} câu trả lời tự động`);
            }
            const next = new Map(this.rules);
            const guildRules = new Map(previousGuild);
            guildRules.set(key, { ...clean });
            next.set(clean.guildId, guildRules);
            await this.write(next);
            this.rules = next;
        });
    }
    async remove(guildId, trigger) {
        return this.enqueue(async () => {
            const key = normalizeAutoReplyTrigger(trigger);
            const previousGuild = this.rules.get(guildId);
            if (!key || !previousGuild?.has(key))
                return false;
            const next = new Map(this.rules);
            const guildRules = new Map(previousGuild);
            guildRules.delete(key);
            if (guildRules.size === 0)
                next.delete(guildId);
            else
                next.set(guildId, guildRules);
            await this.write(next);
            this.rules = next;
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
    isValidRule(value) {
        if (!value || typeof value !== "object")
            return false;
        const rule = value;
        return typeof rule.guildId === "string" && rule.guildId.trim().length > 0 &&
            typeof rule.trigger === "string" && rule.trigger.trim().length > 0 && rule.trigger.length <= MAX_AUTO_REPLY_TRIGGER &&
            typeof rule.reply === "string" && rule.reply.trim().length > 0 && rule.reply.length <= MAX_AUTO_REPLY_TEXT;
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
        if (!Array.isArray(parsed) || parsed.some((item) => !this.isValidRule(item))) {
            throw new Error("Tệp trả lời tự động không đúng định dạng");
        }
        const next = new Map();
        for (const item of parsed) {
            const rule = { guildId: item.guildId, trigger: item.trigger.trim().normalize("NFC"), reply: item.reply };
            const key = normalizeAutoReplyTrigger(rule.trigger);
            const guildRules = next.get(rule.guildId) ?? new Map();
            if (guildRules.has(key) || guildRules.size >= MAX_AUTO_REPLY_RULES) {
                throw new Error("Tệp trả lời tự động có câu trùng hoặc vượt giới hạn");
            }
            guildRules.set(key, rule);
            next.set(rule.guildId, guildRules);
        }
        this.rules = next;
    }
    async write(rules) {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
        try {
            const values = [...rules.values()].flatMap((guildRules) => [...guildRules.values()])
                .sort((a, b) => a.guildId.localeCompare(b.guildId) || a.trigger.localeCompare(b.trigger, "vi"));
            await fs.writeFile(tempPath, JSON.stringify(values, null, 2), { encoding: "utf8", mode: 0o600 });
            await fs.rename(tempPath, this.filePath);
        }
        finally {
            await fs.unlink(tempPath).catch(() => undefined);
        }
    }
}
//# sourceMappingURL=autoReplyStore.js.map