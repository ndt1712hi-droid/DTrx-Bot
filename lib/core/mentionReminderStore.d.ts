export declare const MIN_INTERVAL_SECONDS = 1;
export declare const MAX_INTERVAL_SECONDS = 100;
export declare const DEFAULT_INTERVAL_SECONDS = 30;
export declare const MAX_REMINDERS_PER_RUN = 100;
export declare const MAX_TRACKED_REMINDER_MESSAGES = 500;
export declare const MAX_REMINDER_TEXT = 200;
export declare const DEFAULT_REMINDER_TEXT = "C\u00F3 l\u1EDDi nh\u1EAFc d\u00E0nh cho b\u1EA1n.";
export interface MentionReminderConfig {
    guildId: string;
    channelId: string;
    targetId: string;
    intervalSeconds: number;
    count: number;
    text: string;
}
export interface ReminderMessageRef {
    channelId: string;
    messageId: string;
}
export interface MentionReminderRecord {
    guildId: string;
    config: MentionReminderConfig | null;
    messages: ReminderMessageRef[];
}
/** Durable configuration and a bounded ledger of bot-owned messages; running timers are never persisted. */
export declare class MentionReminderStore {
    private readonly filePath;
    private records;
    private readonly loadPromise;
    private loadError;
    private writeTail;
    constructor(filePath: string);
    ready(): Promise<void>;
    flush(): Promise<void>;
    get(guildId: string): Promise<MentionReminderRecord | undefined>;
    setConfig(config: MentionReminderConfig): Promise<void>;
    deleteConfig(guildId: string): Promise<boolean>;
    addMessage(guildId: string, ref: ReminderMessageRef): Promise<void>;
    removeMessages(guildId: string, refs: ReminderMessageRef[]): Promise<void>;
    private enqueue;
    private validId;
    private validRef;
    private validConfig;
    private validRecord;
    private load;
    private write;
}
