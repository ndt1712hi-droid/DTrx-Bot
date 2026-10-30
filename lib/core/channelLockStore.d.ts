/** Only these @everyone channel overwrites are changed by /lock. */
export declare const LOCKED_PERMISSIONS: readonly ["SendMessages", "SendMessagesInThreads", "CreatePublicThreads", "CreatePrivateThreads"];
export type LockPermission = (typeof LOCKED_PERMISSIONS)[number];
export type PermissionState = boolean | null;
export interface ChannelLockRecord {
    guildId: string;
    channelId: string;
    botId: string;
    phase: "pending" | "locked";
    everyone: {
        existed: boolean;
        permissions: Record<LockPermission, PermissionState>;
    };
    bot: {
        existed: boolean;
        sendMessages: PermissionState;
        changed: boolean;
    };
}
/** Durable write-ahead snapshots permit safe /unlock after restarts or partial Discord failures. */
export declare class ChannelLockStore {
    private readonly filePath;
    private records;
    private readonly loadPromise;
    private loadError;
    private writeTail;
    constructor(filePath: string);
    ready(): Promise<void>;
    flush(): Promise<void>;
    get(guildId: string, channelId: string): Promise<ChannelLockRecord | undefined>;
    put(record: ChannelLockRecord): Promise<void>;
    remove(guildId: string, channelId: string): Promise<void>;
    private enqueue;
    private key;
    private validId;
    private validState;
    private validRecord;
    private load;
    private write;
}
