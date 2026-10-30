import type { GreetingKind } from "./memberGreetingStore.js";
/** One optimized JPEG per guild and greeting kind. Atomic writes and hashed
 * filenames keep uploads isolated and avoid trusting IDs as filesystem paths. */
export declare class MemberBannerStore {
    private readonly directory;
    private writeTail;
    constructor(directory: string);
    flush(): Promise<void>;
    get(guildId: string, kind: GreetingKind): Promise<Buffer | undefined>;
    has(guildId: string, kind: GreetingKind): Promise<boolean>;
    set(guildId: string, kind: GreetingKind, image: Buffer): Promise<void>;
    reset(guildId: string, kind: GreetingKind): Promise<boolean>;
    private fileFor;
    private enqueue;
}
