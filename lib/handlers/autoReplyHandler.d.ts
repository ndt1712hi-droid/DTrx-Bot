import { type Client } from "discord.js";
import { AutoReplyStore } from "../core/autoReplyStore.js";
import type { CommandContext } from "./musicActions.js";
/** Reply only to a human message whose complete content matches a saved trigger. */
export declare function registerAutoReplyHandler(client: Client, store: AutoReplyStore, hasMessageContentIntent: boolean): void;
export declare class AutoReplyActions {
    private readonly store;
    private readonly hasMessageContentIntent;
    constructor(store: AutoReplyStore, hasMessageContentIntent: boolean);
    manage(ctx: CommandContext, mode: string, trigger?: string, reply?: string): Promise<void>;
}
