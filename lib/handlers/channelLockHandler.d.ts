import { ChannelLockStore } from "../core/channelLockStore.js";
import type { CommandContext } from "./musicActions.js";
type LockMode = "lock" | "unlock";
/** Applies and restores a deliberately small set of channel overwrites. */
export declare class ChannelLockActions {
    private readonly store;
    private readonly pending;
    private closed;
    constructor(store: ChannelLockStore);
    close(): Promise<void>;
    manage(ctx: CommandContext, mode: LockMode, selectedChannelId?: string): Promise<void>;
    private fetchChannel;
    private requireFreshChannel;
    private run;
    private lock;
    private restoreGroup;
    private unlock;
}
export {};
