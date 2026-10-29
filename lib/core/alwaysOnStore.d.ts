export interface AlwaysOnVoiceTarget {
    guildId: string;
    voiceChannelId: string;
    textChannelId: string;
}
/** Persist 24/7 voice targets independently from the short-lived music queue. */
export declare class AlwaysOnVoiceStore {
    private readonly filePath;
    private entries;
    private readonly loadPromise;
    private loadError;
    private writeTail;
    constructor(filePath: string);
    ready(): Promise<void>;
    isEnabled(guildId: string): boolean;
    get(guildId: string): AlwaysOnVoiceTarget | undefined;
    list(): AlwaysOnVoiceTarget[];
    set(target: AlwaysOnVoiceTarget): Promise<void>;
    remove(guildId: string): Promise<boolean>;
    private enqueue;
    private isValidTarget;
    private load;
    private write;
}
