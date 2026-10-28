import { type Client, type Message, type VoiceBasedChannel } from "discord.js";
import { PlayerManager, type Player } from "ziplayer";
import type { BotConfig } from "../types/bot.js";
import { SessionPersistence } from "./persistence.js";
export declare class ZiMusicBotEngine {
    readonly client: Client;
    readonly config: BotConfig;
    readonly manager: PlayerManager;
    readonly persistence: SessionPersistence;
    private readonly refreshTimers;
    private readonly emptyChannelTimers;
    constructor(client: Client, config: BotConfig);
    private getUserData;
    private resolveSendableChannel;
    /**
     * Creates isolated per-guild extension instances so multiple Discord servers
     * never overwrite each other's `extension.player` reference.
     */
    private buildGuildExtensions;
    /**
     * Retrieves an active guild player or creates a new one configured with all ZiPlayer 1.x features.
     */
    getOrCreatePlayer(opts: {
        guildId: string;
        voiceChannelId: string;
        textChannelId: string;
    }): Promise<Player>;
    /**
     * Connects the player to the target Discord voice/stage channel if not already connected there.
     */
    ensureConnected(player: Player, voiceChannel: VoiceBasedChannel): Promise<void>;
    /**
     * Schedules a coalesced in-place edit of the guild's Now Playing controller message.
     */
    scheduleControllerRefresh(player: Player, delayMs?: number): void;
    /**
     * Sends a brand-new Now Playing controller message (deleting the old one to keep chat tidy).
     */
    sendFreshController(player: Player): Promise<Message | null>;
    private updateControllerInPlace;
    private clearGuildTimers;
    private bindManagerEvents;
    private bindDiscordVoiceEvents;
    /**
     * Restores active sessions saved prior to a bot restart if human listeners are still in the voice channel.
     */
    restorePersistedSessions(): Promise<number>;
    shutdown(): Promise<void>;
}
