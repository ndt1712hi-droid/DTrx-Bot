import { ChannelType, type Client, type GuildMember, type PartialGuildMember } from "discord.js";
import { type MemberBannerData } from "../core/memberBanner.js";
import { MemberBannerStore } from "../core/memberBannerStore.js";
import { MemberGreetingStore, type GreetingKind, type GreetingSetting } from "../core/memberGreetingStore.js";
import type { CommandContext } from "./musicActions.js";
type Member = GuildMember | PartialGuildMember;
export type GreetingDelivery = "banner" | "text-only" | "not-enabled" | "unavailable";
export interface BannerAttachment {
    url: string;
    size: number;
}
/** A bounded, single-worker queue protects music playback during join bursts. */
export declare class GreetingWorkQueue {
    private readonly limit;
    private tail;
    private pending;
    constructor(limit?: number);
    tryRun<T>(work: () => Promise<T>): Promise<T> | null;
}
/** Only the joining member may be mentioned; custom text never pings roles or everyone. */
export declare function formatGreeting(setting: GreetingSetting, member: Member, preview?: boolean): {
    content: string;
    allowedMentions: {
        parse: [];
        users: string[];
        repliedUser: boolean;
    };
};
/** Handles member events and test sends; failures fall back to a text message. */
export declare class MemberGreetingService {
    private readonly client;
    private readonly store;
    private readonly hasMemberIntent;
    private readonly render;
    private readonly backgrounds?;
    private readonly work;
    private readonly lastEvents;
    private closed;
    constructor(client: Client, store: MemberGreetingStore, hasMemberIntent: boolean, render?: (data: MemberBannerData) => Promise<Buffer>, backgrounds?: MemberBannerStore | undefined);
    register(): void;
    close(): void;
    handleEvent(kind: GreetingKind, member: Member): Promise<void>;
    sendTest(kind: GreetingKind, member: Member): Promise<GreetingDelivery>;
    setBackground(guildId: string, kind: GreetingKind, attachment: BannerAttachment | null | undefined): Promise<void>;
    resetBackground(guildId: string, kind: GreetingKind): Promise<boolean>;
    hasBackground(guildId: string, kind: GreetingKind): Promise<boolean>;
    private acceptEvent;
    private deliver;
}
export declare class MemberGreetingActions {
    private readonly store;
    private readonly service;
    private readonly hasMemberIntent;
    constructor(store: MemberGreetingStore, service: MemberGreetingService, hasMemberIntent: boolean);
    manage(ctx: CommandContext, kind: GreetingKind, mode: string, channel?: {
        id: string;
        guildId: string | null;
        type: ChannelType;
    } | null, message?: string, attachment?: BannerAttachment | null): Promise<void>;
}
export {};
