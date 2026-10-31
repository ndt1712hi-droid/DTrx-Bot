import { type ButtonInteraction, type Client } from "discord.js";
import { MentionReminderStore } from "../core/mentionReminderStore.js";
import type { CommandContext } from "./musicActions.js";
type Mode = "set" | "on" | "off" | "delete" | "clear" | "status";
type Schedule = (task: () => void | Promise<void>, milliseconds: number) => () => void;
export interface MentionReminderInput {
    targetId?: string;
    channelId?: string;
    intervalSeconds?: number;
    count?: number;
    text?: string;
}
/** One bounded reminder run per guild; nothing resumes after a restart. */
export declare class MentionReminderService {
    private readonly client;
    private readonly store;
    private readonly schedule;
    private readonly active;
    private readonly reserved;
    private readonly lastSent;
    private readonly queues;
    private closed;
    constructor(client: Client, store: MentionReminderStore, schedule?: Schedule);
    close(): Promise<void>;
    private queue;
    manage(ctx: CommandContext, mode: Mode, input?: MentionReminderInput): Promise<void>;
    private channelFor;
    private validateTarget;
    private configure;
    private startRun;
    handleButton(interaction: ButtonInteraction): Promise<void>;
    private scheduleTick;
    private isRunning;
    private tick;
    private sendOne;
    private stop;
    private clearMessages;
}
export declare function isMentionReminderButton(customId: string): boolean;
export {};
