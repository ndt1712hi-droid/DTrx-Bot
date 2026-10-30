import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { GreetingKind } from "./memberGreetingStore.js";

const MAX_SAVED_BYTES = 1_000_000;

/** One optimized JPEG per guild and greeting kind. Atomic writes and hashed
 * filenames keep uploads isolated and avoid trusting IDs as filesystem paths. */
export class MemberBannerStore {
	private readonly directory: string;
	private writeTail: Promise<void> = Promise.resolve();

	constructor(directory: string) { this.directory = path.resolve(directory); }

	async flush(): Promise<void> { await this.writeTail; }

	async get(guildId: string, kind: GreetingKind): Promise<Buffer | undefined> {
		await this.writeTail;
		const file = this.fileFor(guildId, kind);
		try {
			const stat = await fs.stat(file);
			if (stat.size <= 0 || stat.size > MAX_SAVED_BYTES) throw new Error("Kích thước nền banner đã lưu không hợp lệ");
			return await fs.readFile(file);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw err;
		}
	}

	async has(guildId: string, kind: GreetingKind): Promise<boolean> {
		return Boolean(await this.get(guildId, kind));
	}

	async set(guildId: string, kind: GreetingKind, image: Buffer): Promise<void> {
		if (!image.length || image.length > MAX_SAVED_BYTES) throw new Error("Ảnh nền sau xử lý quá lớn");
		return this.enqueue(async () => {
			await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
			const file = this.fileFor(guildId, kind);
			const temporary = `${file}.${randomUUID()}.tmp`;
			try {
				await fs.writeFile(temporary, image, { mode: 0o600 });
				await fs.rename(temporary, file);
			} finally { await fs.unlink(temporary).catch(() => undefined); }
		});
	}

	async reset(guildId: string, kind: GreetingKind): Promise<boolean> {
		return this.enqueue(async () => {
			try { await fs.unlink(this.fileFor(guildId, kind)); return true; }
			catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
				throw err;
			}
		});
	}

	private fileFor(guildId: string, kind: GreetingKind): string {
		if (typeof guildId !== "string" || !guildId || guildId.length > 100 || (kind !== "welcome" && kind !== "goodbye")) {
			throw new Error("Server hoặc loại banner không hợp lệ");
		}
		const name = createHash("sha256").update(`${guildId}:${kind}`).digest("hex");
		return path.join(this.directory, `${name}.jpg`);
	}

	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const result = this.writeTail.then(work);
		this.writeTail = result.then(() => undefined, () => undefined);
		return result;
	}
}
