export interface AutoReplyRule {
    guildId: string;
    trigger: string;
    reply: string;
}
export declare const MAX_AUTO_REPLY_RULES = 20;
export declare const MAX_AUTO_REPLY_TRIGGER = 100;
export declare const MAX_AUTO_REPLY_TEXT = 2000;
/** Whole-message matching, tolerant of surrounding whitespace and Vietnamese casing. */
export declare function normalizeAutoReplyTrigger(text: string): string;
/** Per-server auto-replies, kept independently from music and 24/7 sessions. */
export declare class AutoReplyStore {
    private readonly filePath;
    private rules;
    private readonly loadPromise;
    private loadError;
    private writeTail;
    constructor(filePath: string);
    ready(): Promise<void>;
    flush(): Promise<void>;
    find(guildId: string, message: string): Promise<string | undefined>;
    list(guildId: string): Promise<AutoReplyRule[]>;
    set(rule: AutoReplyRule): Promise<void>;
    remove(guildId: string, trigger: string): Promise<boolean>;
    private enqueue;
    private isValidRule;
    private load;
    private write;
}
