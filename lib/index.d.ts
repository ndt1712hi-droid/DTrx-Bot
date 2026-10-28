import { Client } from "discord.js";
import { ZiMusicBotEngine } from "./core/musicEngine.js";
import { MusicCommandActions } from "./handlers/musicActions.js";
export declare function createBotInstance(customEnv?: NodeJS.ProcessEnv): {
    client: Client<boolean>;
    config: import("./types/bot.js").BotConfig;
    engine: ZiMusicBotEngine;
    actions: MusicCommandActions;
};
