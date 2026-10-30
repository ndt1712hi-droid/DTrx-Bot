import { Client } from "discord.js";
import { ZiMusicBotEngine } from "./core/musicEngine.js";
import { AutoReplyStore } from "./core/autoReplyStore.js";
import { MemberGreetingStore } from "./core/memberGreetingStore.js";
import { MemberBannerStore } from "./core/memberBannerStore.js";
import { AutoReplyActions } from "./handlers/autoReplyHandler.js";
import { MusicCommandActions } from "./handlers/musicActions.js";
import { MemberGreetingActions, MemberGreetingService } from "./handlers/memberGreetingHandler.js";
export interface CreateBotOptions {
    includeMessageContentIntent?: boolean;
    includeGuildMembersIntent?: boolean;
}
export declare function createBotInstance(customEnv?: NodeJS.ProcessEnv, options?: CreateBotOptions): {
    client: Client<boolean>;
    config: import("./types/bot.js").BotConfig;
    engine: ZiMusicBotEngine;
    actions: MusicCommandActions;
    autoReplyStore: AutoReplyStore;
    autoReplyActions: AutoReplyActions;
    greetingStore: MemberGreetingStore;
    bannerStore: MemberBannerStore;
    greetingService: MemberGreetingService;
    greetingActions: MemberGreetingActions;
};
/** Clean up an instance that failed before login without erasing saved music. */
export declare function disposeFailedLogin(bot: ReturnType<typeof createBotInstance>): Promise<void>;
/** Discord's 4014 error does not identify which privileged intent is missing.
 * Try all combinations, preserving Message Content first so adding welcome
 * cannot accidentally disable an already-working auto-reply bot. */
export declare function loginWithIntentFallback<T>(create: (options: Required<CreateBotOptions>) => T, login: (instance: T) => Promise<unknown>, dispose: (instance: T) => Promise<void>): Promise<T>;
export declare function supportsVoiceRuntime(version?: string): boolean;
