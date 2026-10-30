import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type GreetingKind = "welcome" | "goodbye";
export const MAX_GREETING_MESSAGE = 500;
export const DEFAULT_GREETING_MESSAGES: Record<GreetingKind, string> = {
	welcome: "🎉 Chào mừng {user} đến với **{server}**!",
	goodbye: "👋 Tạm biệt **{name}**! Cảm ơn bạn đã đồng hành cùng **{server}**.",
};

export interface GreetingSetting {
	guildId: string;
	kind: GreetingKind;
	channelId: string;
	enabled: boolean;
	message: string;
}

/** Per-guild welcome/goodbye settings. Writes are serialized and atomic, and a
 * corrupt file is never overwritten automatically. */
export class MemberGreetingStore {
	private readonly filePath: string;
	private settings = new Map<string, GreetingSetting>();
	private readonly loadPromise: Promise<void>;
	private loadError: Error | null = null;
	private writeTail: Promise<void> = Promise.resolve();

	constructor(filePath: string) {
		this.filePath = path.resolve(filePath);
		this.loadPromise = this.load().catch((err: unknown) => {
			this.loadError = err instanceof Error ? err : new Error(String(err));
		});
	}

	async ready(): Promise<void> {
		await this.loadPromise;
		if (this.loadError) throw new Error(`Không thể đọc cấu hình welcome/goodbye: ${this.loadError.message}`);
	}

	async flush(): Promise<void> {
		await this.writeTail;
		await this.ready();
	}

	async get(guildId: string, kind: GreetingKind): Promise<GreetingSetting | undefined> {
		await this.ready();
		const value = this.settings.get(this.key(guildId, kind));
		return value ? { ...value } : undefined;
	}

	async configure(guildId: string, kind: GreetingKind, channelId: string, message?: string): Promise<GreetingSetting> {
		if (!this.validId(guildId) || !this.validId(channelId) || !this.validKind(kind)) throw new Error("Server hoặc kênh không hợp lệ");
		if (message !== undefined && (typeof message !== "string" || !message.trim() || message.length > MAX_GREETING_MESSAGE)) {
			throw new Error(`Nội dung phải có từ 1 đến ${MAX_GREETING_MESSAGE} ký tự`);
		}
		return this.enqueue(async () => {
			const key = this.key(guildId, kind);
			const current = this.settings.get(key);
			const setting: GreetingSetting = {
				guildId, kind, channelId, enabled: true,
				message: message?.trim() ?? current?.message ?? DEFAULT_GREETING_MESSAGES[kind],
			};
			const next = new Map(this.settings);
			next.set(key, setting);
			await this.write(next);
			this.settings = next;
			return { ...setting };
		});
	}

	async disable(guildId: string, kind: GreetingKind): Promise<boolean> {
		if (!this.validId(guildId) || !this.validKind(kind)) throw new Error("Server không hợp lệ");
		return this.enqueue(async () => {
			const key = this.key(guildId, kind);
			const current = this.settings.get(key);
			if (!current?.enabled) return false;
			const next = new Map(this.settings);
			next.set(key, { ...current, enabled: false });
			await this.write(next);
			this.settings = next;
			return true;
		});
	}

	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const result = this.writeTail.then(async () => { await this.ready(); return work(); });
		this.writeTail = result.then(() => undefined, () => undefined);
		return result;
	}

	private key(guildId: string, kind: GreetingKind): string { return `${guildId}:${kind}`; }
	private validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 100 && value.trim() === value; }
	private validKind(value: unknown): value is GreetingKind { return value === "welcome" || value === "goodbye"; }
	private validSetting(value: unknown): value is GreetingSetting {
		if (!value || typeof value !== "object") return false;
		const item = value as Partial<GreetingSetting>;
		return this.validId(item.guildId) && this.validId(item.channelId) && this.validKind(item.kind) &&
			typeof item.enabled === "boolean" && typeof item.message === "string" &&
			Boolean(item.message.trim()) && item.message.length <= MAX_GREETING_MESSAGE;
	}

	private async load(): Promise<void> {
		let raw: string;
		try { raw = await fs.readFile(this.filePath, "utf8"); }
		catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed) || parsed.some((item) => !this.validSetting(item))) throw new Error("Tệp cấu hình không đúng định dạng");
		const next = new Map<string, GreetingSetting>();
		for (const item of parsed as GreetingSetting[]) {
			const key = this.key(item.guildId, item.kind);
			if (next.has(key)) throw new Error("Tệp cấu hình có mục trùng");
			next.set(key, { ...item });
		}
		this.settings = next;
	}

	private async write(settings: Map<string, GreetingSetting>): Promise<void> {
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		const temp = `${this.filePath}.${randomUUID()}.tmp`;
		try {
			const sorted = [...settings.values()].sort((a, b) => a.guildId.localeCompare(b.guildId) || a.kind.localeCompare(b.kind));
			await fs.writeFile(temp, JSON.stringify(sorted, null, 2), { encoding: "utf8", mode: 0o600 });
			await fs.rename(temp, this.filePath);
		} finally {
			await fs.unlink(temp).catch(() => undefined);
		}
	}
}
