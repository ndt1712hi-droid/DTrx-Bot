import fs from "node:fs/promises";
import path from "node:path";
import type { PlayerManager } from "ziplayer";
import type { PersistedGuildSession, PlayerUserData } from "../types/bot.js";

const MAX_SESSION_AGE_MS = 1000 * 60 * 60 * 6; // 6 hours

export class SessionPersistence {
	private readonly filePath: string;
	private readonly enabled: boolean;
	private timer: NodeJS.Timeout | null = null;
	private writing = false;

	constructor(filePath: string, enabled: boolean) {
		this.filePath = path.resolve(filePath);
		this.enabled = enabled;
	}

	startPeriodicSave(manager: PlayerManager, intervalMs = 30_000): void {
		if (!this.enabled || this.timer) return;
		this.timer = setInterval(() => {
			void this.saveAll(manager).catch(() => undefined);
		}, intervalMs);
		this.timer.unref?.();
	}

	stopPeriodicSave(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	collectSnapshots(manager: PlayerManager): PersistedGuildSession[] {
		const snapshots: PersistedGuildSession[] = [];
		const now = Date.now();

		for (const player of manager.getAll()) {
			if (player.destroyed) continue;
			const userdata = (player.userdata ?? {}) as Partial<PlayerUserData>;
			const voiceChannelId = userdata.voiceChannelId || player.connection?.joinConfig?.channelId || "";
			const textChannelId = userdata.textChannelId || "";
			const currentTrack = player.currentTrack;
			const upcomingTracks = player.upcomingTracks.slice(0, 100);

			if (!voiceChannelId || (!currentTrack && upcomingTracks.length === 0)) {
				continue;
			}

			snapshots.push({
				guildId: player.guildId,
				voiceChannelId: String(voiceChannelId),
				textChannelId: String(textChannelId),
				currentTrack,
				upcomingTracks,
				volume: player.volume,
				loopMode: player.queue.getLoopMode(),
				autoPlay: player.autoPlay(),
				activeFilters: player.filter.getActiveFilters().map((f) => f.name),
				savedAt: now,
			});
		}

		return snapshots;
	}

	async saveAll(manager: PlayerManager): Promise<void> {
		if (!this.enabled || this.writing) return;
		this.writing = true;
		try {
			const snapshots = this.collectSnapshots(manager);
			const dir = path.dirname(this.filePath);
			await fs.mkdir(dir, { recursive: true });
			const tmpPath = `${this.filePath}.tmp`;
			await fs.writeFile(tmpPath, JSON.stringify(snapshots, null, 2), "utf8");
			await fs.rename(tmpPath, this.filePath);
		} finally {
			this.writing = false;
		}
	}

	/** Keep the last nonempty restore input as a manual recovery copy. Never
	 * automatically replay this copy after a user has stopped or left. */
	async backupForRecovery(sessions: PersistedGuildSession[]): Promise<void> {
		if (!this.enabled || sessions.length === 0) return;
		const backupPath = `${this.filePath}.recovery.json`;
		await fs.mkdir(path.dirname(backupPath), { recursive: true });
		await fs.writeFile(`${backupPath}.tmp`, JSON.stringify(sessions, null, 2), "utf8");
		await fs.rename(`${backupPath}.tmp`, backupPath);
	}

	async loadValidSessions(now = Date.now()): Promise<PersistedGuildSession[]> {
		if (!this.enabled) return [];
		let raw: string;
		try {
			raw = await fs.readFile(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw new Error("Không thể đọc tệp phiên nhạc; giữ nguyên tệp cũ", { cause: error });
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new Error("Tệp phiên nhạc không hợp lệ; giữ nguyên tệp cũ", { cause: error });
		}
		if (!Array.isArray(parsed)) throw new Error("Tệp phiên nhạc không hợp lệ; giữ nguyên tệp cũ");
		return parsed.filter((item): item is PersistedGuildSession => {
			if (!item || typeof item.guildId !== "string" || typeof item.voiceChannelId !== "string") {
				return false;
			}
			const age = now - Number(item.savedAt || 0);
			return age >= 0 && age <= MAX_SESSION_AGE_MS;
		});
	}

	async clearFile(): Promise<void> {
		if (!this.enabled) return;
		try {
			await fs.unlink(this.filePath);
		} catch {
			// Ignore if file doesn't exist
		}
	}
}
