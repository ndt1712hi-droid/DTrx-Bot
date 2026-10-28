import { ActionRowBuilder, ButtonBuilder, EmbedBuilder, StringSelectMenuBuilder, type Client } from "discord.js";
import { type Player, type PlayerManager, type Track } from "ziplayer";
import type { LyricsResult } from "../types/bot.js";
export declare const COLORS: {
    readonly PRIMARY: 5793266;
    readonly PLAYING: 5763719;
    readonly PAUSED: 16705372;
    readonly LYRICS: 15418782;
    readonly WARNING: 16426522;
    readonly ERROR: 15548997;
    readonly INFO: 45300;
};
export declare const CONTROL_IDS: {
    readonly PREV: "zi:prev";
    readonly TOGGLE: "zi:toggle";
    readonly SKIP: "zi:skip";
    readonly STOP: "zi:stop";
    readonly LOOP: "zi:loop";
    readonly SHUFFLE: "zi:shuffle";
    readonly AUTOPLAY: "zi:autoplay";
    readonly VOLDOWN: "zi:voldown";
    readonly VOLUP: "zi:volup";
    readonly LYRICS: "zi:lyrics";
    readonly FILTER_SELECT: "zi:filter_select";
};
/**
 * Builds the interactive "Now Playing" controller message payload (Embed + 3 ActionRows).
 */
export declare function buildNowPlayingPayload(player: Player, disabled?: boolean): {
    embeds: EmbedBuilder[];
    components: (ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>)[];
};
/**
 * Builds a paginated queue Embed.
 */
export declare function buildQueueEmbed(player: Player, requestedPage?: number): EmbedBuilder;
/**
 * Builds full static lyrics Embed.
 */
export declare function buildFullLyricsEmbed(track: Track, lyrics: LyricsResult): EmbedBuilder;
/**
 * Builds real-time karaoke synced 3-line lyrics Embed.
 */
export declare function buildLiveLyricsEmbed(track: Track, lyrics: LyricsResult): EmbedBuilder;
/**
 * Builds bot & ZiPlayer telemetry Embed.
 */
export declare function buildStatsEmbed(manager: PlayerManager, client: Client): EmbedBuilder;
/**
 * Builds the comprehensive Help Embed covering Slash, Prefix, TTS, Filters, and Buttons.
 */
export declare function buildHelpEmbed(prefix: string): EmbedBuilder;
