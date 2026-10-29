import path from "node:path";
import { VoiceConnectionStatus } from "@discordjs/voice";
import { ChannelType, EmbedBuilder, PermissionFlagsBits, } from "discord.js";
import { PlayerManager, } from "ziplayer";
import { AttachmentsPlugin, SoundCloudPlugin, SpotifyPlugin, TTSPlugin, YouTubePlugin } from "@ziplayer/plugin";
import { AiAutoplayExtension, lavalinkExt, lyricsExt, voiceExt } from "@ziplayer/extension";
import { buildLiveLyricsEmbed, buildNowPlayingPayload, COLORS, } from "../ui/embeds.js";
import { formatDuration, parseVoiceCommand, truncate } from "../utils/format.js";
import { SessionPersistence } from "./persistence.js";
import { AlwaysOnVoiceStore } from "./alwaysOnStore.js";
/** The dependency starts init() without awaiting it. Catch failures here so a
 * temporary Edge voice-list outage cannot cause an unhandled rejection; the
 * plugin retries on playback and falls back to its normal Google TTS path. */
class ResilientTTSPlugin extends TTSPlugin {
    async init() {
        try {
            await super.init();
        }
        catch (err) {
            console.warn("[TTS] Không tải được danh sách giọng Edge; sẽ thử lại khi phát:", err instanceof Error ? err.message : err);
        }
    }
}
/**
 * ZiPlayer searches several plugins in parallel and falls back across sources
 * when a stream fails. Do not let a TTS request be searched or replaced by a
 * music source; keep the plugins' normal routing for all other tracks and URLs.
 */
function excludeTtsFromMusicSources(plugin) {
    const isTtsTrack = (track) => track.source?.toLowerCase() === "tts" ||
        track.id?.toLowerCase().startsWith("tts-") ||
        Boolean(track.metadata?.tts);
    const originalSearch = plugin.search.bind(plugin);
    plugin.search = async (query, requestedBy, signal) => {
        if (query.trim().toLowerCase().startsWith("tts:")) {
            return { tracks: [] };
        }
        return originalSearch(query, requestedBy, signal);
    };
    const originalStream = plugin.getStream.bind(plugin);
    plugin.getStream = async (track, signal) => {
        if (isTtsTrack(track))
            throw new Error("Cannot use a music source for a TTS track");
        return originalStream(track, signal);
    };
    if (plugin.getFallback) {
        const originalFallback = plugin.getFallback.bind(plugin);
        plugin.getFallback = async (track, signal) => {
            if (isTtsTrack(track))
                throw new Error("Cannot fall back to music for a TTS track");
            return originalFallback(track, signal);
        };
    }
    return plugin;
}
export class ZiMusicBotEngine {
    client;
    config;
    manager;
    persistence;
    ttsPlugin;
    refreshTimers = new Map();
    emptyChannelTimers = new Map();
    alwaysOnStore;
    guardedPlayers = new WeakSet();
    voiceModeLocks = new Map();
    reconnectPending = new Set();
    suppressedSessionRestores = new Set();
    reconnectBackoff = new Map();
    alwaysOnTimer = null;
    shuttingDown = false;
    constructor(client, config) {
        this.client = client;
        this.config = config;
        this.persistence = new SessionPersistence(config.persistenceFile, config.enablePersistence);
        const voiceFile = path.resolve(path.dirname(config.persistenceFile), "voice-24-7.json");
        // Never let a custom playback-session filename collide with the 24/7 store.
        this.alwaysOnStore = new AlwaysOnVoiceStore(voiceFile === path.resolve(config.persistenceFile) ? `${voiceFile}.rooms.json` : voiceFile);
        const globalExtensions = [];
        if (config.lavalinkNodes.length > 0) {
            globalExtensions.push(new lavalinkExt(null, {
                client,
                nodes: config.lavalinkNodes,
                debug: config.debugLevel !== "off",
            }));
        }
        this.ttsPlugin = new ResilientTTSPlugin({ defaultLang: config.ttsLang });
        this.manager = new PlayerManager({
            plugins: [
                excludeTtsFromMusicSources(new YouTubePlugin()),
                excludeTtsFromMusicSources(new SoundCloudPlugin()),
                excludeTtsFromMusicSources(new SpotifyPlugin()),
                this.ttsPlugin,
                excludeTtsFromMusicSources(new AttachmentsPlugin({ maxFileSize: 25 * 1024 * 1024 })),
            ],
            extensions: globalExtensions,
            extractorTimeout: config.extractorTimeoutMs,
            autoCleanup: true,
            cleanupInterval: 90_000,
            enableSearchCache: true,
            enableStatsCollection: !config.lowPerformance,
            debugLevel: config.debugLevel,
        });
        this.bindManagerEvents();
        this.bindDiscordVoiceEvents();
    }
    /** Guard ZiPlayer's own idle timers while 24/7 is enabled, without changing
     * its normal leave policy for other servers. The lifecycle method is public. */
    guardPlayerLifecycle(player) {
        if (this.guardedPlayers.has(player))
            return;
        const lifecycle = player.runtimeGraph.lifecycleController;
        const scheduleLeave = lifecycle.scheduleLeave.bind(lifecycle);
        lifecycle.scheduleLeave = (reason) => {
            if (this.alwaysOnStore.isEnabled(player.guildId) && (reason === "track-end" || reason === "queue-empty")) {
                lifecycle.clearLeaveTimeout();
                return;
            }
            scheduleLeave(reason);
        };
        this.guardedPlayers.add(player);
    }
    clearEmptyChannelTimer(guildId) {
        const timer = this.emptyChannelTimers.get(guildId);
        if (timer)
            clearTimeout(timer);
        this.emptyChannelTimers.delete(guildId);
    }
    updateEmptyChannelTimer(player, guild) {
        const guildId = guild.id;
        if (!this.config.leaveOnEmpty || this.alwaysOnStore.isEnabled(guildId)) {
            this.clearEmptyChannelTimer(guildId);
            return;
        }
        const botVoiceId = this.getUserData(player).voiceChannelId || player.connection?.joinConfig?.channelId;
        const channel = botVoiceId ? guild.channels.cache.get(botVoiceId) : undefined;
        if (!botVoiceId || !channel?.isVoiceBased()) {
            this.clearEmptyChannelTimer(guildId);
            return;
        }
        if (channel.members.filter((m) => !m.user.bot).size > 0) {
            this.clearEmptyChannelTimer(guildId);
            return;
        }
        if (this.emptyChannelTimers.has(guildId))
            return;
        const timer = setTimeout(() => {
            this.emptyChannelTimers.delete(guildId);
            const activePlayer = this.manager.get(guildId);
            if (!activePlayer || activePlayer.destroyed || this.alwaysOnStore.isEnabled(guildId))
                return;
            const currentVoiceId = this.getUserData(activePlayer).voiceChannelId || activePlayer.connection?.joinConfig?.channelId;
            if (currentVoiceId !== botVoiceId)
                return;
            const currentCh = guild.channels.cache.get(botVoiceId);
            if (currentCh?.isVoiceBased() && currentCh.members.filter((m) => !m.user.bot).size === 0) {
                const textChannel = this.resolveSendableChannel(this.getUserData(activePlayer).textChannelId);
                activePlayer.destroy();
                if (textChannel) {
                    const embed = new EmbedBuilder()
                        .setColor(COLORS.WARNING)
                        .setDescription(`👋 Không còn ai trong kênh thoại sau \`${formatDuration(this.config.leaveTimeoutMs)}\` nên mình rời phòng nhé!`);
                    void textChannel.send({ embeds: [embed] }).catch(() => undefined);
                }
            }
        }, this.config.leaveTimeoutMs);
        timer.unref?.();
        this.emptyChannelTimers.set(guildId, timer);
    }
    withVoiceModeLock(guildId, operation) {
        const previous = this.voiceModeLocks.get(guildId) ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(operation);
        this.voiceModeLocks.set(guildId, current);
        return current.finally(() => {
            if (this.voiceModeLocks.get(guildId) === current)
                this.voiceModeLocks.delete(guildId);
        });
    }
    async getAlwaysOnVoiceTarget(guildId) {
        await this.alwaysOnStore.ready();
        return this.alwaysOnStore.get(guildId);
    }
    /** Save the selected room before connecting, so the watchdog can retry a failed join. */
    async enableAlwaysOnVoice(target, voiceChannel) {
        if (voiceChannel.id !== target.voiceChannelId || voiceChannel.guildId !== target.guildId) {
            throw new Error("Kênh thoại không thuộc server đã chọn");
        }
        await this.withVoiceModeLock(target.guildId, async () => {
            if (this.shuttingDown)
                throw new Error("Bot đang tắt");
            await this.alwaysOnStore.set(target);
            this.reconnectBackoff.delete(target.guildId);
            this.clearEmptyChannelTimer(target.guildId);
            const player = await this.getOrCreatePlayer(target);
            this.guardPlayerLifecycle(player);
            player.runtimeGraph.lifecycleController.clearLeaveTimeout();
            await this.ensureConnected(player, voiceChannel);
        });
    }
    /** Disable persistence first; a concurrent watchdog cannot reconnect after this returns. */
    async disableAlwaysOnVoice(guildId) {
        return this.withVoiceModeLock(guildId, async () => {
            const removed = await this.alwaysOnStore.remove(guildId);
            this.reconnectBackoff.delete(guildId);
            const player = this.manager.get(guildId);
            if (removed && player && !player.destroyed) {
                if (this.config.leaveOnEnd && !player.currentTrack && player.queueSize === 0 && !player.isPlaying && !player.isPaused) {
                    player.runtimeGraph.lifecycleController.scheduleLeave("queue-empty");
                }
                const guild = this.client.guilds.cache.get(guildId);
                if (guild)
                    this.updateEmptyChannelTimer(player, guild);
            }
            return removed;
        });
    }
    /** Atomically disable 24/7 and disconnect for an explicit /leave command. */
    async leaveVoice(guildId) {
        return this.withVoiceModeLock(guildId, async () => {
            const disabled = await this.alwaysOnStore.remove(guildId);
            this.reconnectBackoff.delete(guildId);
            this.suppressedSessionRestores.add(guildId);
            const player = this.manager.get(guildId);
            const left = Boolean(player && !player.destroyed);
            if (player && !player.destroyed)
                player.destroy();
            return { disabled, left };
        });
    }
    /** Load configured rooms on ready and periodically repair lost connections. */
    async startAlwaysOnVoice() {
        await this.alwaysOnStore.ready();
        if (this.shuttingDown)
            return 0;
        if (!this.alwaysOnTimer) {
            this.alwaysOnTimer = setInterval(() => {
                void this.refreshAlwaysOnVoice().catch((err) => console.warn("[24/7] Lỗi kiểm tra kết nối:", err));
            }, 15_000);
            this.alwaysOnTimer.unref?.();
        }
        await this.refreshAlwaysOnVoice();
        return this.alwaysOnStore.list().length;
    }
    async refreshAlwaysOnVoice() {
        await this.alwaysOnStore.ready();
        if (this.shuttingDown || !this.client.isReady())
            return;
        await Promise.all(this.alwaysOnStore.list().map(async ({ guildId }) => {
            if (this.reconnectPending.has(guildId))
                return;
            const retry = this.reconnectBackoff.get(guildId);
            if (retry && Date.now() < retry.retryAt)
                return;
            this.reconnectPending.add(guildId);
            try {
                await this.withVoiceModeLock(guildId, async () => {
                    const target = this.alwaysOnStore.get(guildId);
                    if (!target || this.shuttingDown)
                        return;
                    try {
                        await this.reconnectAlwaysOnTarget(target);
                        this.reconnectBackoff.delete(guildId);
                    }
                    catch (err) {
                        const failures = (this.reconnectBackoff.get(guildId)?.failures ?? 0) + 1;
                        const delay = Math.min(300_000, 15_000 * 2 ** Math.min(failures - 1, 5));
                        this.reconnectBackoff.set(guildId, { failures, retryAt: Date.now() + delay });
                        console.warn(`[24/7] Không thể vào lại server ${guildId}; sẽ thử lại:`, err instanceof Error ? err.message : err);
                    }
                });
            }
            finally {
                this.reconnectPending.delete(guildId);
            }
        }));
    }
    async reconnectAlwaysOnTarget(target) {
        const existing = this.manager.get(target.guildId);
        const connection = existing?.connection;
        const cachedGuild = this.client.guilds.cache.get(target.guildId);
        const actualChannelId = cachedGuild?.members.me?.voice?.channelId;
        if (existing && !existing.destroyed && connection?.joinConfig.channelId === target.voiceChannelId &&
            connection.state.status === VoiceConnectionStatus.Ready && (!actualChannelId || actualChannelId === target.voiceChannelId)) {
            this.guardPlayerLifecycle(existing);
            existing.runtimeGraph.lifecycleController.clearLeaveTimeout();
            this.clearEmptyChannelTimer(target.guildId);
            return;
        }
        const guild = cachedGuild ?? await this.client.guilds.fetch(target.guildId);
        const channel = guild.channels.cache.get(target.voiceChannelId) ?? await guild.channels.fetch(target.voiceChannelId);
        if (!channel || !channel.isVoiceBased())
            throw new Error("Kênh thoại không còn tồn tại hoặc bot không có quyền xem");
        const me = guild.members.me;
        if (me && !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) {
            throw new Error("Bot không có quyền Xem kênh hoặc Kết nối vào phòng 24/7");
        }
        const player = await this.getOrCreatePlayer(target);
        this.guardPlayerLifecycle(player);
        player.runtimeGraph.lifecycleController.clearLeaveTimeout();
        this.clearEmptyChannelTimer(target.guildId);
        await this.ensureConnected(player, channel);
    }
    getUserData(player) {
        if (!player.userdata) {
            player.userdata = {
                textChannelId: "",
                voiceChannelId: "",
            };
        }
        return player.userdata;
    }
    resolveSendableChannel(channelId) {
        if (!channelId)
            return null;
        const ch = this.client.channels.cache.get(channelId);
        if (ch && ch.isSendable()) {
            return ch;
        }
        return null;
    }
    /**
     * Creates isolated per-guild extension instances so multiple Discord servers
     * never overwrite each other's `extension.player` reference.
     */
    buildGuildExtensions() {
        const extensions = [];
        let lyricsInstance;
        if (this.config.enableLyrics) {
            lyricsInstance = new lyricsExt(null, {
                provider: "lrclib",
                includeSynced: true,
                autoFetchOnTrackStart: true,
                sanitizeTitle: true,
            });
            extensions.push(lyricsInstance);
        }
        if (this.config.enableVoiceCommands) {
            extensions.push(new voiceExt(null, {
                lang: this.config.voiceLang,
                ignoreBots: true,
                minimalVoiceMessageDuration: 1,
                client: this.client,
            }));
        }
        if (this.config.geminiApiKey) {
            extensions.push(new AiAutoplayExtension(this.config.geminiApiKey));
        }
        return { extensions, lyricsInstance };
    }
    /**
     * Retrieves an active guild player or creates a new one configured with all ZiPlayer 1.x features.
     */
    async getOrCreatePlayer(opts) {
        // Load the 24/7 state before installing lifecycle guards. A corrupt 24/7
        // file must not prevent unrelated playback from working.
        await this.alwaysOnStore.ready().catch(() => undefined);
        const existing = this.manager.get(opts.guildId);
        if (existing && !existing.destroyed) {
            this.guardPlayerLifecycle(existing);
            const ud = this.getUserData(existing);
            if (opts.textChannelId)
                ud.textChannelId = opts.textChannelId;
            if (opts.voiceChannelId)
                ud.voiceChannelId = opts.voiceChannelId;
            return existing;
        }
        const { extensions, lyricsInstance } = this.buildGuildExtensions();
        const initialUserData = {
            textChannelId: opts.textChannelId,
            voiceChannelId: opts.voiceChannelId,
            liveLyricsEnabled: this.config.autoLiveLyrics,
            lyricsExtInstance: lyricsInstance,
            voiceCommandsEnabled: this.config.enableVoiceCommands,
        };
        const player = await this.manager.create(opts.guildId, {
            volume: this.config.defaultVolume,
            quality: "high",
            selfDeaf: !this.config.enableVoiceCommands,
            selfMute: false,
            leaveOnEnd: this.config.leaveOnEnd,
            leaveOnEmpty: this.config.leaveOnEmpty,
            leaveTimeout: this.config.leaveTimeoutMs,
            extractorTimeout: this.config.extractorTimeoutMs,
            ffmpegPath: this.config.ffmpegPath,
            lowPerformance: this.config.lowPerformance,
            maxStreamStore: this.config.lowPerformance ? 2 : 6,
            extensions,
            tts: {
                createPlayer: true,
                interrupt: true,
                volume: 100,
                maxTimeTts: this.config.ttsMaxTimeMs,
            },
            preload: {
                enabled: !this.config.lowPerformance,
                autoDisableInLowPerformance: true,
            },
            crossfade: {
                enabled: this.config.lowPerformance ? false : undefined,
                autoEnable: !this.config.lowPerformance,
                autoDisableInLowPerformance: true,
                durationMs: this.config.crossfadeDurationMs,
            },
            smartTransition: {
                enabled: !this.config.lowPerformance,
                genreAware: true,
                beatAlign: true,
                baseDurationMs: this.config.crossfadeDurationMs,
                minDurationMs: 1_200,
                maxDurationMs: 8_000,
                genreDurations: { chill: 7_000, edm: 2_200 },
                beatAlignMaxWaitMs: 1_200,
            },
            antiStuck: {
                enabled: true,
                maxRetries: 2,
                retryDelayMs: 900,
                reusePreloadFirst: true,
                reduceQualityOnRetry: true,
                controlledSkipThreshold: 3,
            },
            loudnessNormalization: {
                enabled: true,
                targetLUFS: -14,
                maxBoostDb: 8,
                maxCutDb: 10,
                limiterCeiling: 0.95,
            },
            userdata: initialUserData,
        });
        this.guardPlayerLifecycle(player);
        return player;
    }
    /**
     * Connects the player to the target Discord voice/stage channel if not already connected there.
     */
    async ensureConnected(player, voiceChannel) {
        const ud = this.getUserData(player);
        const connection = player.connection;
        const currentChannelId = connection?.joinConfig?.channelId;
        const state = connection?.state?.status;
        const actualChannelId = voiceChannel.guild.members.me?.voice?.channelId;
        const moved = Boolean(actualChannelId && actualChannelId !== voiceChannel.id);
        const disconnected = state === VoiceConnectionStatus.Disconnected || state === VoiceConnectionStatus.Destroyed;
        let joined = false;
        if (connection && state === VoiceConnectionStatus.Ready && (currentChannelId !== voiceChannel.id || moved)) {
            // ZiPlayer can reuse a ready connection without moving it. Send a voice
            // rejoin directly when the chosen room differs from the current room.
            const sent = connection.rejoin({
                channelId: voiceChannel.id,
                selfDeaf: connection.joinConfig.selfDeaf,
                selfMute: connection.joinConfig.selfMute,
            });
            if (!sent)
                throw new Error("Không thể gửi yêu cầu chuyển kênh thoại");
            joined = true;
        }
        else if (!connection || currentChannelId !== voiceChannel.id || disconnected) {
            await player.connect(voiceChannel);
            if (player.destroyed)
                throw new Error("Trình phát đã bị ngắt trong lúc kết nối voice");
            joined = true;
        }
        if (joined) {
            ud.voiceChannelId = voiceChannel.id;
            // If joining a Stage Channel and the bot is a speaker/moderator, unsuppress automatically
            if (voiceChannel.type === ChannelType.GuildStageVoice) {
                const me = voiceChannel.guild.members.me;
                if (me?.voice?.suppress) {
                    await me.voice.setSuppressed(false).catch(() => undefined);
                }
            }
        }
    }
    /**
     * Schedules a coalesced in-place edit of the guild's Now Playing controller message.
     */
    scheduleControllerRefresh(player, delayMs = 300) {
        const guildId = player.guildId;
        const existingTimer = this.refreshTimers.get(guildId);
        if (existingTimer)
            clearTimeout(existingTimer);
        const timer = setTimeout(() => {
            this.refreshTimers.delete(guildId);
            if (player.destroyed)
                return;
            void this.updateControllerInPlace(player).catch(() => undefined);
        }, delayMs);
        timer.unref?.();
        this.refreshTimers.set(guildId, timer);
    }
    /**
     * Sends a brand-new Now Playing controller message (deleting the old one to keep chat tidy).
     */
    async sendFreshController(player) {
        const ud = this.getUserData(player);
        const channel = this.resolveSendableChannel(ud.textChannelId);
        if (!channel)
            return null;
        if (ud.controllerMessageId) {
            const oldId = ud.controllerMessageId;
            ud.controllerMessageId = undefined;
            await channel.messages
                .fetch(oldId)
                .then((m) => m.delete())
                .catch(() => undefined);
        }
        const payload = buildNowPlayingPayload(player, false);
        const sent = await channel.send(payload).catch(() => null);
        if (sent) {
            ud.controllerMessageId = sent.id;
        }
        return sent;
    }
    async updateControllerInPlace(player, disabled = false) {
        const ud = this.getUserData(player);
        if (!ud.controllerMessageId)
            return;
        const channel = this.resolveSendableChannel(ud.textChannelId);
        if (!channel)
            return;
        const payload = buildNowPlayingPayload(player, disabled);
        await channel.messages
            .fetch(ud.controllerMessageId)
            .then((msg) => msg.edit(payload))
            .catch(() => {
            if (disabled)
                ud.controllerMessageId = undefined;
        });
        if (disabled) {
            ud.controllerMessageId = undefined;
        }
    }
    clearGuildTimers(guildId) {
        const rt = this.refreshTimers.get(guildId);
        if (rt) {
            clearTimeout(rt);
            this.refreshTimers.delete(guildId);
        }
        const et = this.emptyChannelTimers.get(guildId);
        if (et) {
            clearTimeout(et);
            this.emptyChannelTimers.delete(guildId);
        }
    }
    bindManagerEvents() {
        this.manager.on("debug", (msg, ...args) => {
            if (this.config.debugLevel !== "off") {
                console.debug(`[ZiPlayer] ${msg}`, ...args);
            }
        });
        this.manager.on("trackStart", (player, track) => {
            const ud = this.getUserData(player);
            ud.cachedLyrics = null;
            ud.lyricsTrackId = track.id || track.url;
            ud.lyricsMessageId = undefined;
            void this.sendFreshController(player);
        });
        this.manager.on("queueAdd", (player, track) => {
            // If a song is already playing, notify softly & refresh controller queue counter
            if (player.currentTrack && player.currentTrack.id !== track.id) {
                this.scheduleControllerRefresh(player, 350);
            }
        });
        this.manager.on("queueAddList", (player, tracks) => {
            const ud = this.getUserData(player);
            const channel = this.resolveSendableChannel(ud.textChannelId);
            if (channel && tracks.length > 1) {
                const embed = new EmbedBuilder()
                    .setColor(COLORS.PRIMARY)
                    .setDescription(`📚 Đã thêm danh sách phát gồm **${tracks.length}** bài hát vào hàng đợi!`);
                void channel.send({ embeds: [embed] }).catch(() => undefined);
            }
            this.scheduleControllerRefresh(player, 400);
        });
        for (const evt of [
            "playerPause",
            "playerResume",
            "volumeChange",
            "filterApplied",
            "filterRemoved",
            "filtersCleared",
            "queueRemove",
        ]) {
            this.manager.on(evt, (player, ..._args) => {
                this.scheduleControllerRefresh(player, 250);
            });
        }
        this.manager.on("queueEnd", (player) => {
            const ud = this.getUserData(player);
            void this.updateControllerInPlace(player, true);
            const channel = this.resolveSendableChannel(ud.textChannelId);
            if (channel) {
                const embed = new EmbedBuilder()
                    .setColor(COLORS.INFO)
                    .setDescription("🏁 Đã phát hết hàng đợi! Dùng `/play` để tiếp tục nghe nhạc nhé.");
                void channel.send({ embeds: [embed] }).catch(() => undefined);
            }
        });
        this.manager.on("playerStop", (player) => {
            void this.updateControllerInPlace(player, true);
        });
        this.manager.on("playerDestroy", (player) => {
            this.clearGuildTimers(player.guildId);
            void this.updateControllerInPlace(player, true);
        });
        this.manager.on("lyricsCreate", (player, track, result) => {
            const ud = this.getUserData(player);
            ud.cachedLyrics = result;
            ud.lyricsTrackId = track.id || track.url;
        });
        this.manager.on("lyricsChange", async (player, track, result) => {
            const ud = this.getUserData(player);
            ud.cachedLyrics = result;
            if (!ud.liveLyricsEnabled || !result?.current)
                return;
            const now = Date.now();
            if (ud.lastLyricsEditAt && now - ud.lastLyricsEditAt < 1_800) {
                return; // Guard against Discord per-message edit rate limits
            }
            ud.lastLyricsEditAt = now;
            const channel = this.resolveSendableChannel(ud.textChannelId);
            if (!channel)
                return;
            const embed = buildLiveLyricsEmbed(track, result);
            if (ud.lyricsMessageId) {
                const edited = await channel.messages
                    .fetch(ud.lyricsMessageId)
                    .then((m) => m.edit({ embeds: [embed] }))
                    .catch(() => null);
                if (edited)
                    return;
            }
            const sent = await channel.send({ embeds: [embed] }).catch(() => null);
            if (sent) {
                ud.lyricsMessageId = sent.id;
            }
        });
        this.manager.on("voiceCreate", async (player, payload) => {
            const ud = this.getUserData(player);
            if (!ud.voiceCommandsEnabled)
                return;
            const action = parseVoiceCommand(payload.content, this.config.voiceWakeWords);
            if (!action)
                return;
            const channel = this.resolveSendableChannel(ud.textChannelId);
            try {
                switch (action.type) {
                    case "play":
                        await player.play(action.query, payload.userId);
                        await channel?.send(`🎙️ <@${payload.userId}> gọi giọng nói: **Phát** \`${truncate(action.query, 80)}\``);
                        break;
                    case "skip":
                        player.skip();
                        await channel?.send(`🎙️ <@${payload.userId}> gọi giọng nói: **Bỏ qua bài hiện tại**`);
                        break;
                    case "previous":
                        await player.previous();
                        await channel?.send(`🎙️ <@${payload.userId}> gọi giọng nói: **Quay lại bài trước**`);
                        break;
                    case "pause":
                        player.pause();
                        await channel?.send(`🎙️ <@${payload.userId}> gọi giọng nói: **Tạm dừng nhạc**`);
                        break;
                    case "resume":
                        player.resume();
                        await channel?.send(`🎙️ <@${payload.userId}> gọi giọng nói: **Tiếp tục phát**`);
                        break;
                    case "stop":
                        player.stop();
                        await channel?.send(`🎙️ <@${payload.userId}> gọi giọng nói: **Dừng phát nhạc**`);
                        break;
                    case "shuffle":
                        player.shuffle();
                        await channel?.send(`🎙️ <@${payload.userId}> gọi giọng nói: **Trộn hàng đợi**`);
                        break;
                    case "autoplay": {
                        const nextState = !player.autoPlay();
                        player.autoPlay(nextState);
                        await channel?.send(`🎙️ <@${payload.userId}> gọi giọng nói: **Autoplay ${nextState ? "Bật" : "Tắt"}**`);
                        break;
                    }
                    case "volume":
                        player.setVolume(action.level);
                        await channel?.send(`🎙️ <@${payload.userId}> gọi giọng nói: **Âm lượng ${action.level}%**`);
                        break;
                    case "loop":
                        player.loop(action.mode);
                        await channel?.send(`🎙️ <@${payload.userId}> gọi giọng nói: **Chế độ lặp ${action.mode}**`);
                        break;
                }
                this.scheduleControllerRefresh(player, 200);
            }
            catch (err) {
                console.error(`[VoiceCommand] Error in guild ${player.guildId}:`, err);
            }
        });
        this.manager.on("trackStuck", (player, track) => {
            console.warn(`[ZiPlayer] Track stuck in guild ${player.guildId}: ${track?.title ?? "unknown"} (Anti-Stuck recovering...)`);
        });
        this.manager.on("playerError", (player, error, track) => {
            console.error(`[ZiPlayer] Player error in guild ${player.guildId}:`, error.message);
            const ud = this.getUserData(player);
            const channel = this.resolveSendableChannel(ud.textChannelId);
            if (channel) {
                const embed = new EmbedBuilder()
                    .setColor(COLORS.ERROR)
                    .setDescription(`⚠️ Không thể phát ${track ? `**${truncate(track.title, 80)}**` : "bài hát"}: \`${truncate(error.message, 140)}\``);
                void channel.send({ embeds: [embed] }).catch(() => undefined);
            }
        });
        this.manager.on("connectionError", (player, error) => {
            console.error(`[ZiPlayer] Voice connection error in guild ${player.guildId}:`, error.message);
        });
    }
    bindDiscordVoiceEvents() {
        this.client.on("voiceStateUpdate", (oldState, newState) => {
            const guildId = newState.guild.id;
            const player = this.manager.get(guildId);
            if (!player || player.destroyed)
                return;
            const botId = this.client.user?.id;
            if (botId && newState.id === botId) {
                // Bot was forcibly kicked from voice channel by an admin
                if (oldState.channelId && !newState.channelId) {
                    player.destroy();
                    return;
                }
                // Bot was moved to another voice channel
                if (newState.channelId && oldState.channelId !== newState.channelId) {
                    this.clearEmptyChannelTimer(guildId);
                    const ud = this.getUserData(player);
                    ud.voiceChannelId = newState.channelId;
                }
            }
            this.updateEmptyChannelTimer(player, newState.guild);
        });
    }
    /**
     * Restores active sessions saved prior to a bot restart if human listeners are still in the voice channel.
     */
    async restorePersistedSessions() {
        if (!this.config.enablePersistence)
            return 0;
        await this.alwaysOnStore.ready().catch(() => undefined);
        const sessions = await this.persistence.loadValidSessions();
        let restoredCount = 0;
        for (const session of sessions) {
            try {
                await this.withVoiceModeLock(session.guildId, async () => {
                    if (this.shuttingDown || this.suppressedSessionRestores.has(session.guildId))
                        return;
                    const alwaysOn = this.alwaysOnStore.get(session.guildId);
                    if (alwaysOn && alwaysOn.voiceChannelId !== session.voiceChannelId)
                        return;
                    const guild = this.client.guilds.cache.get(session.guildId);
                    if (!guild)
                        return;
                    const voiceCh = guild.channels.cache.get(session.voiceChannelId);
                    if (!voiceCh || !voiceCh.isVoiceBased())
                        return;
                    const humans = voiceCh.members.filter((m) => !m.user.bot).size;
                    if (humans === 0)
                        return;
                    const player = await this.getOrCreatePlayer({
                        guildId: session.guildId,
                        voiceChannelId: session.voiceChannelId,
                        textChannelId: session.textChannelId,
                    });
                    await this.ensureConnected(player, voiceCh);
                    player.setVolume(session.volume);
                    player.loop(session.loopMode);
                    player.autoPlay(session.autoPlay);
                    if (session.activeFilters.length > 0) {
                        await player.filter.applyFilters(session.activeFilters).catch(() => undefined);
                    }
                    const tracksToRestore = [
                        ...(session.currentTrack ? [session.currentTrack] : []),
                        ...session.upcomingTracks,
                    ];
                    if (tracksToRestore.length > 0) {
                        const [first, ...rest] = tracksToRestore;
                        if (rest.length > 0) {
                            player.queue.addMultiple(rest);
                        }
                        await player.play(first, first.requestedBy);
                        restoredCount++;
                        const textChannel = this.resolveSendableChannel(session.textChannelId);
                        if (textChannel) {
                            const embed = new EmbedBuilder()
                                .setColor(COLORS.PLAYING)
                                .setDescription(`🔄 Đã tự động khôi phục phiên phát nhạc (**${tracksToRestore.length}** bài) sau khi khởi động lại!`);
                            await textChannel.send({ embeds: [embed] }).catch(() => undefined);
                        }
                    }
                });
            }
            catch (err) {
                console.warn(`[Persistence] Could not restore session for guild ${session.guildId}:`, err);
            }
        }
        await this.persistence.clearFile();
        return restoredCount;
    }
    async shutdown() {
        this.shuttingDown = true;
        if (this.alwaysOnTimer)
            clearInterval(this.alwaysOnTimer);
        this.alwaysOnTimer = null;
        await Promise.allSettled([...this.voiceModeLocks.values()]);
        this.persistence.stopPeriodicSave();
        await this.persistence.saveAll(this.manager).catch(() => undefined);
        for (const guildId of [...this.refreshTimers.keys(), ...this.emptyChannelTimers.keys()]) {
            this.clearGuildTimers(guildId);
        }
        this.manager.destroy();
    }
}
//# sourceMappingURL=musicEngine.js.map