export type GreetingKind = "welcome" | "goodbye";
export declare const MAX_GREETING_MESSAGE = 500;
export declare const DEFAULT_GREETING_MESSAGES: Record<GreetingKind, string>;
export interface GreetingSetting {
    guildId: string;
    kind: GreetingKind;
    channelId: string;
    enabled: boolean;
    message: string;
}
/** Per-guild welcome/goodbye settings. Writes are serialized and atomic, and a
 * corrupt file is never overwritten automatically. */
export declare class MemberGreetingStore {
    private readonly filePath;
    private settings;
    private readonly loadPromise;
    private loadError;
    private writeTail;
    constructor(filePath: string);
    ready(): Promise<void>;
    flush(): Promise<void>;
    get(guildId: string, kind: GreetingKind): Promise<GreetingSetting | undefined>;
    configure(guildId: string, kind: GreetingKind, channelId: string, message?: string): Promise<GreetingSetting>;
    disable(guildId: string, kind: GreetingKind): Promise<boolean>;
    private enqueue;
    private key;
    private validId;
    private validKind;
    private validSetting;
    private load;
    private write;
}
