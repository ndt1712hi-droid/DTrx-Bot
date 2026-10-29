import { AttachmentBuilder, EmbedBuilder, type Guild, type GuildMember, type MessageCreateOptions, type MessagePayload, type VoiceBasedChannel } from "discord.js";
import { type Player } from "ziplayer";
import type { ZiMusicBotEngine } from "../core/musicEngine.js";
export interface ReplyPayload {
    content?: string;
    embeds?: EmbedBuilder[];
    files?: AttachmentBuilder[];
    ephemeral?: boolean;
}
export interface CommandContext {
    guild: Guild;
    member: GuildMember;
    userId: string;
    textChannelId: string;
    defer: (ephemeral?: boolean) => Promise<void>;
    reply: (payload: ReplyPayload) => Promise<void>;
}
/**
 * Validates that the member is in a voice channel, and if a guild player is already
 * connected, ensures the member is in the SAME voice channel as the bot.
 */
export declare function validateMemberVoiceAccess(member: GuildMember, existingPlayer?: Player): {
    ok: true;
    voiceChannel: VoiceBasedChannel;
} | {
    ok: false;
    reason: string;
};
export declare class MusicCommandActions {
    private readonly engine;
    constructor(engine: ZiMusicBotEngine);
    private getActivePlayerOrReply;
    play(ctx: CommandContext, query?: string, attachmentUrl?: string): Promise<void>;
    playNext(ctx: CommandContext, query: string): Promise<void>;
    tts(ctx: CommandContext, text: string): Promise<void>;
    alwaysOnVoice(ctx: CommandContext, modeInput?: string): Promise<void>;
    pause(ctx: CommandContext): Promise<void>;
    resume(ctx: CommandContext): Promise<void>;
    skip(ctx: CommandContext, toPosition?: number): Promise<void>;
    previous(ctx: CommandContext): Promise<void>;
    stop(ctx: CommandContext): Promise<void>;
    leave(ctx: CommandContext): Promise<void>;
    nowPlaying(ctx: CommandContext): Promise<void>;
    queue(ctx: CommandContext, page?: number): Promise<void>;
    shuffle(ctx: CommandContext): Promise<void>;
    loop(ctx: CommandContext, modeInput?: string): Promise<void>;
    autoPlay(ctx: CommandContext): Promise<void>;
    seek(ctx: CommandContext, timeStr: string): Promise<void>;
    volume(ctx: CommandContext, level?: number): Promise<void>;
    move(ctx: CommandContext, fromPos: number, toPos: number): Promise<void>;
    swap(ctx: CommandContext, posA: number, posB: number): Promise<void>;
    remove(ctx: CommandContext, pos: number): Promise<void>;
    clear(ctx: CommandContext): Promise<void>;
    filter(ctx: CommandContext, action: string, filterName?: string): Promise<void>;
    lyrics(ctx: CommandContext, mode?: string): Promise<void>;
    save(ctx: CommandContext, filterName?: string): Promise<void>;
    mirror(ctx: CommandContext, leaderGuildIdOrOff: string): Promise<void>;
    stats(ctx: CommandContext): Promise<void>;
    help(ctx: CommandContext): Promise<void>;
}
export declare function toMessageOptions(payload: ReplyPayload): string | MessagePayload | MessageCreateOptions;
