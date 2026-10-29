import { GuildMember, type ButtonInteraction, type ChatInputCommandInteraction, type Guild, type StringSelectMenuInteraction } from "discord.js";
import type { ZiMusicBotEngine } from "../core/musicEngine.js";
import { MusicCommandActions } from "./musicActions.js";
export type ResolvedGuildContext = {
    ok: true;
    guild: Guild;
    member: GuildMember;
} | {
    ok: false;
    kind: "not_in_guild" | "bot_not_in_guild" | "member_fetch_failed";
    message: string;
};
/**
 * Safely resolves `Guild` and `GuildMember` for Slash & Component interactions.
 *
 * Fixes two common Discord.js v14 pitfalls:
 * 1. `interaction.member` can be a raw `APIInteractionGuildMember` plain object (not `instanceof GuildMember`)
 *    when `GuildMemberManager` uses `Options.cacheWithLimits` or before member cache warms up.
 * 2. When a user installs the app via "User Install" or invites it with `applications.commands` only
 *    (missing `bot` scope), `interaction.inGuild()` is `true` (`guildId` exists), yet `interaction.guild`
 *    is `null` because the Bot user is not in the server.
 */
export declare function resolveInteractionGuildAndMember(interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction): Promise<ResolvedGuildContext>;
export declare function registerInteractionHandler(engine: ZiMusicBotEngine, actions: MusicCommandActions): void;
