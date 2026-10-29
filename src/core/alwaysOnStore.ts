import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface AlwaysOnVoiceTarget {
	guildId: string;
	voiceChannelId: string;
	textChannelId: string;
}

/** Persist 24/7 voice targets independently from the short-lived music queue. */
export class AlwaysOnVoiceStore {
	private readonly filePath: string;
	private entries = new Map<string, AlwaysOnVoiceTarget>();
	private readonly loadPromise: Promise<void>;
	private loadError: Error | null = null;
	private writeTail: Promise<void> = Promise.resolve();

	constructor(filePath: string) {
		this.filePath = path.resolve(filePath);
		// Capture read errors immediately so constructing a bot never creates an
		// unhandled rejection. Mutations fail rather than overwrite corrupt data.
		this.loadPromise = this.load().catch((err: unknown) => {
			this.loadError = err instanceof Error ? err : new Error(String(err));
		});
	}

	async ready(): Promise<void> {
		await this.loadPromise;
		if (this.loadError) {
			throw new Error(`Không thể đọc cấu hình 24/7: ${this.loadError.message}`);
		}
	}

	isEnabled(guildId: string): boolean {
		return this.entries.has(guildId);
	}

	get(guildId: string): AlwaysOnVoiceTarget | undefined {
		const target = this.entries.get(guildId);
		return target ? { ...target } : undefined;
	}

	list(): AlwaysOnVoiceTarget[] {
		return [...this.entries.values()].map((target) => ({ ...target }));
	}

	async set(target: AlwaysOnVoiceTarget): Promise<void> {
		if (!this.isValidTarget(target)) throw new Error("Cấu hình kênh thoại 24/7 không hợp lệ");
		return this.enqueue(async () => {
			const next = new Map(this.entries);
			next.set(target.guildId, { ...target });
			await this.write(next);
			this.entries = next;
		});
	}

	async remove(guildId: string): Promise<boolean> {
		return this.enqueue(async () => {
			if (!this.entries.has(guildId)) return false;
			const next = new Map(this.entries);
			next.delete(guildId);
			await this.write(next);
			this.entries = next;
			return true;
		});
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.writeTail.then(async () => {
			await this.ready();
			return operation();
		});
		this.writeTail = result.then(() => undefined, () => undefined);
		return result;
	}

	private isValidTarget(value: unknown): value is AlwaysOnVoiceTarget {
		if (!value || typeof value !== "object") return false;
		const entry = value as Partial<AlwaysOnVoiceTarget>;
		return typeof entry.guildId === "string" && entry.guildId.trim().length > 0 &&
			typeof entry.voiceChannelId === "string" && entry.voiceChannelId.trim().length > 0 &&
			typeof entry.textChannelId === "string";
	}

	private async load(): Promise<void> {
		let raw: string;
		try {
			raw = await fs.readFile(this.filePath, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
			throw err;
		}
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed) || parsed.some((item) => !this.isValidTarget(item))) {
			throw new Error("Tệp cấu hình 24/7 không đúng định dạng");
		}
		this.entries = new Map(parsed.map((item: AlwaysOnVoiceTarget) => [item.guildId, { ...item }]));
	}

	private async write(entries: Map<string, AlwaysOnVoiceTarget>): Promise<void> {
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
		try {
			const values = [...entries.values()].sort((a, b) => a.guildId.localeCompare(b.guildId));
			await fs.writeFile(tempPath, JSON.stringify(values, null, 2), { encoding: "utf8", mode: 0o600 });
			await fs.rename(tempPath, this.filePath);
		} finally {
			await fs.unlink(tempPath).catch(() => undefined);
		}
	}
}
