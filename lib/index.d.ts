import { Client } from "discord.js";
import { ZiMusicBotEngine } from "./core/musicEngine.js";
import { AutoReplyStore } from "./core/autoReplyStore.js";
import { AutoReplyActions } from "./handlers/autoReplyHandler.js";
import { MusicCommandActions } from "./handlers/musicActions.js";
export interface CreateBotOptions {
    includeMessageContentIntent?: boolean;
}
export declare function createBotInstance(customEnv?: NodeJS.ProcessEnv, options?: CreateBotOptions): {
    client: Client<boolean>;
    config: import("./types/bot.js").BotConfig;
    engine: ZiMusicBotEngine;
    actions: MusicCommandActions;
    autoReplyStore: AutoReplyStore;
    autoReplyActions: AutoReplyActions;
};
export declare function supportsVoiceRuntime(version?: string): boolean;
