import { type Client, type Message, type VoiceBasedChannel } from "discord.js";
import { PlayerManager, type Player } from "ziplayer";
import { TTSPlugin } from "@ziplayer/plugin";
import type { BotConfig } from "../types/bot.js";
import { SessionPersistence } from "./persistence.js";
import { type AlwaysOnVoiceTarget } from "./alwaysOnStore.js";
export declare class ZiMusicBotEngine {
    readonly client: Client;
    readonly config: BotConfig;
    readonly manager: PlayerManager;
    readonly persistence: SessionPersistence;
    readonly ttsPlugin: TTSPlugin;
    private readonly refreshTimers;
    private readonly emptyChannelTimers;
    private readonly alwaysOnStore;
    private readonly guardedPlayers;
    private readonly monitoredConnections;
    private readonly voiceModeLocks;
    private readonly reconnectPending;
    private readonly suppressedSessionRestores;
    private readonly reconnectBackoff;
    private alwaysOnTimer;
    private shuttingDown;
    constructor(client: Client, config: BotConfig);
    /** Guard ZiPlayer's own idle timers while 24/7 is enabled, without changing
     * its normal leave policy for other servers. The lifecycle method is public. */
    private guardPlayerLifecycle;
    private clearEmptyChannelTimer;
    private updateEmptyChannelTimer;
    private withVoiceModeLock;
    getAlwaysOnVoiceTarget(guildId: string): Promise<AlwaysOnVoiceTarget | undefined>;
    /** Save the selected room before connecting, so the watchdog can retry a failed join. */
    enableAlwaysOnVoice(target: AlwaysOnVoiceTarget, voiceChannel: VoiceBasedChannel): Promise<void>;
    /** Disable persistence first; a concurrent watchdog cannot reconnect after this returns. */
    disableAlwaysOnVoice(guildId: string): Promise<boolean>;
    /** Atomically disable 24/7 and disconnect for an explicit /leave command. */
    leaveVoice(guildId: string): Promise<{
        disabled: boolean;
        left: boolean;
    }>;
    /** Load configured rooms on ready and periodically repair lost connections. */
    startAlwaysOnVoice(): Promise<number>;
    refreshAlwaysOnVoice(): Promise<void>;
    private reconnectAlwaysOnTarget;
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
    /** A ready voice connection can still be detached from the music player. */
    private ensureAudioSubscription;
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
