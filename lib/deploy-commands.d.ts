import { REST } from "discord.js";
import type { BotConfig } from "./types/bot.js";
/** Global-only fields must not be included when targeting a single guild. */
export declare function buildDeploymentCommands(guildScoped: boolean): {
    type?: import("discord.js").ApplicationCommandType.ChatInput | undefined;
    description: string;
    options?: import("discord.js").APIApplicationCommandOption[] | undefined;
    name: string;
    name_localizations?: import("discord.js")._AddUndefinedToPossiblyUndefinedPropertiesOfInterface<Partial<Record<import("discord.js").Locale, string | null>> | null | undefined>;
    description_localizations?: import("discord.js")._AddUndefinedToPossiblyUndefinedPropertiesOfInterface<Partial<Record<import("discord.js").Locale, string | null>> | null | undefined>;
    default_permission?: boolean | undefined;
    nsfw?: boolean | undefined;
    default_member_permissions?: import("discord.js")._AddUndefinedToPossiblyUndefinedPropertiesOfInterface<string | null | undefined>;
}[];
export declare function deploySlashCommands(config: BotConfig, loggedInClientId?: string, restClient?: Pick<REST, "put">): Promise<number>;
