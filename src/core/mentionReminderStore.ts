import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const MIN_INTERVAL_SECONDS = 1;
export const MAX_INTERVAL_SECONDS = 100;
// Versions through 1.3.0 accepted longer intervals; load those records without silently changing them.
const LEGACY_MAX_INTERVAL_SECONDS = 3600;
export const DEFAULT_INTERVAL_SECONDS = 30;
export const MAX_REMINDERS_PER_RUN = 100;
export const MAX_TRACKED_REMINDER_MESSAGES = 500;
export const MAX_REMINDER_TEXT = 200;
export const DEFAULT_REMINDER_TEXT = "Có lời nhắc dành cho bạn.";

export interface MentionReminderConfig {
	guildId: string;
	channelId: string;
	targetId: string;
	intervalSeconds: number;
	count: number;
	text: string;
}
export interface ReminderMessageRef { channelId: string; messageId: string }
export interface MentionReminderRecord {
	guildId: string;
	config: MentionReminderConfig | null;
	messages: ReminderMessageRef[];
}

function copy(record: MentionReminderRecord): MentionReminderRecord {
	return { guildId: record.guildId, config: record.config ? { ...record.config } : null, messages: record.messages.map((ref) => ({ ...ref })) };
}

/** Durable configuration and a bounded ledger of bot-owned messages; running timers are never persisted. */
export class MentionReminderStore {
	private readonly filePath: string;
	private records = new Map<string, MentionReminderRecord>();
	private readonly loadPromise: Promise<void>;
	private loadError: Error | null = null;
	private writeTail: Promise<void> = Promise.resolve();

	constructor(filePath: string) {
		this.filePath = path.resolve(filePath);
		this.loadPromise = this.load().catch((err: unknown) => { this.loadError = err instanceof Error ? err : new Error(String(err)); });
	}

	async ready(): Promise<void> {
		await this.loadPromise;
		if (this.loadError) throw new Error(`Không thể đọc cấu hình nhắc tag: ${this.loadError.message}`);
	}
	async flush(): Promise<void> { await this.writeTail; await this.ready(); }

	async get(guildId: string): Promise<MentionReminderRecord | undefined> {
		await this.ready();
		const record = this.records.get(guildId);
		return record ? copy(record) : undefined;
	}

	async setConfig(config: MentionReminderConfig): Promise<void> {
		if (!this.validConfig(config)) throw new Error("Cấu hình nhắc tag không hợp lệ");
		const clean = { ...config, text: config.text.trim() };
		await this.enqueue(async () => {
			const next = new Map(this.records);
			const existing = next.get(clean.guildId);
			next.set(clean.guildId, { guildId: clean.guildId, config: clean, messages: existing?.messages.map((ref) => ({ ...ref })) ?? [] });
			await this.write(next); this.records = next;
		});
	}

	async deleteConfig(guildId: string): Promise<boolean> {
		return this.enqueue(async () => {
			const existing = this.records.get(guildId);
			if (!existing?.config) return false;
			const next = new Map(this.records);
			if (existing.messages.length) next.set(guildId, { guildId, config: null, messages: existing.messages.map((ref) => ({ ...ref })) });
			else next.delete(guildId);
			await this.write(next); this.records = next;
			return true;
		});
	}

	async addMessage(guildId: string, ref: ReminderMessageRef): Promise<void> {
		if (!this.validId(guildId) || !this.validRef(ref)) throw new Error("Thông tin tin nhắn không hợp lệ");
		await this.enqueue(async () => {
			const existing = this.records.get(guildId);
			if (!existing) throw new Error("Cấu hình nhắc tag không còn tồn tại");
			if (existing.messages.some((item) => item.channelId === ref.channelId && item.messageId === ref.messageId)) return;
			if (existing.messages.length >= MAX_TRACKED_REMINDER_MESSAGES) throw new Error("Đã đầy danh sách tin bot; hãy dùng /spam clear");
			const next = new Map(this.records);
			next.set(guildId, { ...copy(existing), messages: [...existing.messages.map((item) => ({ ...item })), { ...ref }] });
			await this.write(next); this.records = next;
		});
	}

	async removeMessages(guildId: string, refs: ReminderMessageRef[]): Promise<void> {
		if (refs.some((ref) => !this.validRef(ref))) throw new Error("Thông tin tin nhắn không hợp lệ");
		await this.enqueue(async () => {
			const existing = this.records.get(guildId);
			if (!existing || !refs.length) return;
			const keys = new Set(refs.map((ref) => JSON.stringify([ref.channelId, ref.messageId])));
			const remaining = existing.messages.filter((ref) => !keys.has(JSON.stringify([ref.channelId, ref.messageId])));
			const next = new Map(this.records);
			if (!existing.config && remaining.length === 0) next.delete(guildId);
			else next.set(guildId, { ...copy(existing), messages: remaining.map((ref) => ({ ...ref })) });
			await this.write(next); this.records = next;
		});
	}

	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const result = this.writeTail.then(async () => { await this.ready(); return work(); });
		this.writeTail = result.then(() => undefined, () => undefined);
		return result;
	}
	private validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 100 && value.trim() === value; }
	private validRef(value: unknown): value is ReminderMessageRef {
		if (!value || typeof value !== "object") return false;
		const ref = value as Partial<ReminderMessageRef>;
		return this.validId(ref.channelId) && this.validId(ref.messageId);
	}
	private validConfig(value: unknown, maxIntervalSeconds = MAX_INTERVAL_SECONDS): value is MentionReminderConfig {
		if (!value || typeof value !== "object") return false;
		const config = value as Partial<MentionReminderConfig>;
		return this.validId(config.guildId) && this.validId(config.channelId) && this.validId(config.targetId) &&
			Number.isInteger(config.intervalSeconds) && config.intervalSeconds! >= MIN_INTERVAL_SECONDS && config.intervalSeconds! <= maxIntervalSeconds &&
			Number.isInteger(config.count) && config.count! >= 1 && config.count! <= MAX_REMINDERS_PER_RUN &&
			typeof config.text === "string" && Boolean(config.text.trim()) && config.text.length <= MAX_REMINDER_TEXT;
	}
	private validRecord(value: unknown): value is MentionReminderRecord {
		if (!value || typeof value !== "object") return false;
		const record = value as Partial<MentionReminderRecord>;
		if (!this.validId(record.guildId) || !(record.config === null || this.validConfig(record.config, LEGACY_MAX_INTERVAL_SECONDS)) ||
			(record.config && record.config.guildId !== record.guildId) || !Array.isArray(record.messages) ||
			record.messages.length > MAX_TRACKED_REMINDER_MESSAGES || record.messages.some((ref) => !this.validRef(ref))) return false;
		const keys = record.messages.map((ref) => JSON.stringify([ref.channelId, ref.messageId]));
		return new Set(keys).size === keys.length;
	}

	private async load(): Promise<void> {
		let raw: string;
		try { raw = await fs.readFile(this.filePath, "utf8"); }
		catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed) || parsed.some((item) => !this.validRecord(item))) throw new Error("Tệp nhắc tag không đúng định dạng");
		const next = new Map<string, MentionReminderRecord>();
		for (const record of parsed as MentionReminderRecord[]) {
			if (next.has(record.guildId)) throw new Error("Tệp nhắc tag có server trùng");
			next.set(record.guildId, copy(record));
		}
		this.records = next;
	}
	private async write(records: Map<string, MentionReminderRecord>): Promise<void> {
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		const temp = `${this.filePath}.${randomUUID()}.tmp`;
		try {
			const values = [...records.values()].sort((a, b) => a.guildId.localeCompare(b.guildId));
			await fs.writeFile(temp, JSON.stringify(values, null, 2), { encoding: "utf8", mode: 0o600 });
			await fs.rename(temp, this.filePath);
		} finally { await fs.unlink(temp).catch(() => undefined); }
	}
}
