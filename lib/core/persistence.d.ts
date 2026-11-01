import type { PlayerManager } from "ziplayer";
import type { PersistedGuildSession } from "../types/bot.js";
export declare class SessionPersistence {
    private readonly filePath;
    private readonly enabled;
    private timer;
    private writing;
    constructor(filePath: string, enabled: boolean);
    startPeriodicSave(manager: PlayerManager, intervalMs?: number): void;
    stopPeriodicSave(): void;
    collectSnapshots(manager: PlayerManager): PersistedGuildSession[];
    saveAll(manager: PlayerManager): Promise<void>;
    /** Keep the last nonempty restore input as a manual recovery copy. Never
     * automatically replay this copy after a user has stopped or left. */
    backupForRecovery(sessions: PersistedGuildSession[]): Promise<void>;
    loadValidSessions(now?: number): Promise<PersistedGuildSession[]>;
    clearFile(): Promise<void>;
}
