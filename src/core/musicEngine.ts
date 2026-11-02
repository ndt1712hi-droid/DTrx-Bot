import path from "node:path";
import { once } from "node:events";
import { AudioPlayerStatus, VoiceConnectionDisconnectReason, VoiceConnectionStatus } from "@discordjs/voice";
import {
	ChannelType,
	EmbedBuilder,
	PermissionFlagsBits,
	type Client,
	type Guild,
	type Message,
	type SendableChannels,
	type VoiceBasedChannel,
} from "discord.js";
import {
	PlayerManager,
	type BaseExtension,
	type BasePlugin,
	type Player,
	type Track,
} from "ziplayer";
import { AttachmentsPlugin, SpotifyPlugin, TTSPlugin } from "@ziplayer/plugin";
import { AiAutoplayExtension, lavalinkExt, lyricsExt, voiceExt } from "@ziplayer/extension";
import type { BotConfig, LyricsResult, PlayerUserData } from "../types/bot.js";
import {
	buildLiveLyricsEmbed,
	buildNowPlayingPayload,
	COLORS,
} from "../ui/embeds.js";
import { formatDuration, parseVoiceCommand, truncate } from "../utils/format.js";
import { SessionPersistence } from "./persistence.js";
import { AlwaysOnVoiceStore, type AlwaysOnVoiceTarget } from "./alwaysOnStore.js";
import { installManagedAudioResources } from "./managedAudioResource.js";
import { ResilientYouTubePlugin } from "./resilientYouTubePlugin.js";
import { ResilientSoundCloudPlugin } from "./resilientSoundCloudPlugin.js";
import { installStreamProvenance, tracePluginStreams } from "./streamProvenance.js";

/** The dependency starts init() without awaiting it. Catch failures here so a
 * temporary Edge voice-list outage cannot cause an unhandled rejection; the
 * plugin retries on playback and falls back to its normal Google TTS path. */
class ResilientTTSPlugin extends TTSPlugin {
	override async init(): Promise<void> {
		try {
			await super.init();
		} catch (err) {
			console.warn("[TTS] Không tải được danh sách giọng Edge; sẽ thử lại khi phát:", err instanceof Error ? err.message : err);
		}
	}
}

/**
 * ZiPlayer searches several plugins in parallel and falls back across sources
 * when a stream fails. Do not let a TTS request be searched or replaced by a
 * music source; keep the plugins' normal routing for all other tracks and URLs.
 */
function excludeTtsFromMusicSources<T extends BasePlugin>(plugin: T): T {
	const isTtsTrack = (track: Track): boolean =>
		track.source?.toLowerCase() === "tts" ||
		track.id?.toLowerCase().startsWith("tts-") ||
		Boolean(track.metadata?.tts);

	const originalSearch = plugin.search.bind(plugin);
	plugin.search = async (query: string, requestedBy: string, signal?: AbortSignal) => {
		if (query.trim().toLowerCase().startsWith("tts:")) {
			return { tracks: [] };
		}
		return originalSearch(query, requestedBy, signal);
	};

	const originalStream = plugin.getStream.bind(plugin);
	plugin.getStream = async (track: Track, signal?: AbortSignal) => {
		if (isTtsTrack(track)) throw new Error("Cannot use a music source for a TTS track");
		return originalStream(track, signal);
	};

	if (plugin.getFallback) {
		const originalFallback = plugin.getFallback.bind(plugin);
		plugin.getFallback = async (track: Track, signal?: AbortSignal) => {
			if (isTtsTrack(track)) throw new Error("Cannot fall back to music for a TTS track");
			return originalFallback(track, signal);
		};
	}
	return tracePluginStreams(plugin);
}

export class ZiMusicBotEngine {
	public readonly client: Client;
	public readonly config: BotConfig;
	public readonly manager: PlayerManager;
	public readonly persistence: SessionPersistence;
	public readonly ttsPlugin: TTSPlugin;

	private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
	private readonly emptyChannelTimers = new Map<string, NodeJS.Timeout>();
	private readonly alwaysOnStore: AlwaysOnVoiceStore;
	private readonly guardedPlayers = new WeakSet<Player>();
	private readonly monitoredConnections = new WeakSet<NonNullable<Player["connection"]>>();
	private readonly voiceRecoveryTargets = new WeakMap<NonNullable<Player["connection"]>, { player: Player; channel: VoiceBasedChannel; recoverableDisconnect: boolean }>();
	private readonly proactiveVoiceRecoveries = new Map<string, Promise<void>>();
	private readonly voiceModeLocks = new Map<string, Promise<unknown>>();
	private readonly voiceConnectionLocks = new Map<string, Promise<void>>();
	private readonly expectedVoiceLeaves = new Map<string, { player: Player; fromChannelId: string; timer: NodeJS.Timeout }>();
	private readonly reconnectPending = new Set<string>();
	private readonly suppressedSessionRestores = new Set<string>();
	private readonly reconnectBackoff = new Map<string, { failures: number; retryAt: number }>();
	private readonly subscriptionWarnings = new Map<string, number>();
	private musicSubscriptionTimer: NodeJS.Timeout | null = null;
	private alwaysOnTimer: NodeJS.Timeout | null = null;
	private readonly shutdownSignal = new AbortController();
	private sessionRestoreComplete = false;
	private shuttingDown = false;

	constructor(client: Client, config: BotConfig) {
		this.client = client;
		this.config = config;
		this.persistence = new SessionPersistence(config.persistenceFile, config.enablePersistence);
		const voiceFile = path.resolve(path.dirname(config.persistenceFile), "voice-24-7.json");
		// Never let a custom playback-session filename collide with the 24/7 store.
		this.alwaysOnStore = new AlwaysOnVoiceStore(
			voiceFile === path.resolve(config.persistenceFile) ? `${voiceFile}.rooms.json` : voiceFile,
		);

		const globalExtensions: BaseExtension[] = [];
		if (config.lavalinkNodes.length > 0) {
			globalExtensions.push(
				new lavalinkExt(null, {
					client,
					nodes: config.lavalinkNodes,
					debug: config.debugLevel !== "off",
				}),
			);
		}

		this.ttsPlugin = new ResilientTTSPlugin({ defaultLang: config.ttsLang });
		// Keep the resolver's own deadline below ZiPlayer's non-cancelling
		// extractor timeout so abandoned searches/streams do not keep piling up.
		const fallbackBudgetMs = Math.max(1_000, Math.min(25_000, config.extractorTimeoutMs - 750));
		this.manager = new PlayerManager({
			plugins: [
				excludeTtsFromMusicSources(new ResilientYouTubePlugin(undefined, fallbackBudgetMs)),
				excludeTtsFromMusicSources(new ResilientSoundCloudPlugin(fallbackBudgetMs)),
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
		// A Ready voice connection can lose its music subscription after setup.
		// Repair only that small state; never restart tracks or mutate the queue.
		this.musicSubscriptionTimer = setInterval(() => this.recoverMusicSubscriptions(), 2_000);
		this.musicSubscriptionTimer.unref?.();
	}

	/** Guard ZiPlayer's own idle timers while 24/7 is enabled, without changing
	 * its normal leave policy for other servers. The lifecycle method is public. */
	private guardPlayerLifecycle(player: Player): void {
		if (this.guardedPlayers.has(player)) return;
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

	private clearExpectedVoiceLeave(guildId: string): void {
		const expected = this.expectedVoiceLeaves.get(guildId);
		if (expected) clearTimeout(expected.timer);
		this.expectedVoiceLeaves.delete(guildId);
	}

	/** ZiPlayer replaces a connection by sending a leave before joining again.
	 * The corresponding gateway event must not be mistaken for a moderator kick. */
	private expectReplacementLeave(player: Player, fromChannelId: string, lifetimeMs = 20_000): void {
		this.clearExpectedVoiceLeave(player.guildId);
		const timer = setTimeout(() => {
			const expected = this.expectedVoiceLeaves.get(player.guildId);
			if (expected?.timer === timer) this.expectedVoiceLeaves.delete(player.guildId);
		}, lifetimeMs);
		timer.unref?.();
		this.expectedVoiceLeaves.set(player.guildId, { player, fromChannelId, timer });
	}

	private finishReplacementLeave(player: Player): void {
		const expected = this.expectedVoiceLeaves.get(player.guildId);
		if (expected?.player === player) {
			// The gateway can report our leave shortly after the new join is ready.
			this.expectReplacementLeave(player, expected.fromChannelId, 3_000);
		}
	}

	private clearEmptyChannelTimer(guildId: string): void {
		const timer = this.emptyChannelTimers.get(guildId);
		if (timer) clearTimeout(timer);
		this.emptyChannelTimers.delete(guildId);
	}

	private updateEmptyChannelTimer(player: Player, guild: Guild): void {
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
		if (this.emptyChannelTimers.has(guildId)) return;
		const timer = setTimeout(() => {
			this.emptyChannelTimers.delete(guildId);
			const activePlayer = this.manager.get(guildId);
			if (!activePlayer || activePlayer.destroyed || this.alwaysOnStore.isEnabled(guildId)) return;
			const currentVoiceId = this.getUserData(activePlayer).voiceChannelId || activePlayer.connection?.joinConfig?.channelId;
			if (currentVoiceId !== botVoiceId) return;
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

	private withVoiceModeLock<T>(guildId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.voiceModeLocks.get(guildId) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(operation);
		this.voiceModeLocks.set(guildId, current);
		return current.finally(() => {
			if (this.voiceModeLocks.get(guildId) === current) this.voiceModeLocks.delete(guildId);
		});
	}

	async getAlwaysOnVoiceTarget(guildId: string): Promise<AlwaysOnVoiceTarget | undefined> {
		await this.alwaysOnStore.ready();
		return this.alwaysOnStore.get(guildId);
	}

	/** Save the selected room before connecting, so the watchdog can retry a failed join. */
	async enableAlwaysOnVoice(target: AlwaysOnVoiceTarget, voiceChannel: VoiceBasedChannel): Promise<void> {
		if (voiceChannel.id !== target.voiceChannelId || voiceChannel.guildId !== target.guildId) {
			throw new Error("Kênh thoại không thuộc server đã chọn");
		}
		await this.withVoiceModeLock(target.guildId, async () => {
			if (this.shuttingDown) throw new Error("Bot đang tắt");
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
	async disableAlwaysOnVoice(guildId: string): Promise<boolean> {
		return this.withVoiceModeLock(guildId, async () => {
			const removed = await this.alwaysOnStore.remove(guildId);
			this.reconnectBackoff.delete(guildId);
			const player = this.manager.get(guildId);
			if (removed && player && !player.destroyed) {
				if (this.config.leaveOnEnd && !player.currentTrack && player.queueSize === 0 && !player.isPlaying && !player.isPaused) {
					player.runtimeGraph.lifecycleController.scheduleLeave("queue-empty");
				}
				const guild = this.client.guilds.cache.get(guildId);
				if (guild) this.updateEmptyChannelTimer(player, guild);
			}
			return removed;
		});
	}

	/** Atomically disable 24/7 and disconnect for an explicit /leave command. */
	async leaveVoice(guildId: string): Promise<{ disabled: boolean; left: boolean }> {
		return this.withVoiceModeLock(guildId, async () => {
			const disabled = await this.alwaysOnStore.remove(guildId);
			this.reconnectBackoff.delete(guildId);
			this.suppressedSessionRestores.add(guildId);
			const player = this.manager.get(guildId);
			const left = Boolean(player && !player.destroyed);
			if (player && !player.destroyed) player.destroy();
			return { disabled, left };
		});
	}

	/** Load configured rooms on ready and periodically repair lost connections. */
	async startAlwaysOnVoice(): Promise<number> {
		await this.alwaysOnStore.ready();
		if (this.shuttingDown) return 0;
		if (!this.alwaysOnTimer) {
			this.alwaysOnTimer = setInterval(() => {
				void this.refreshAlwaysOnVoice().catch((err) => console.warn("[24/7] Lỗi kiểm tra kết nối:", err));
			}, 15_000);
			this.alwaysOnTimer.unref?.();
		}
		await this.refreshAlwaysOnVoice();
		return this.alwaysOnStore.list().length;
	}

	async refreshAlwaysOnVoice(): Promise<void> {
		await this.alwaysOnStore.ready();
		if (this.shuttingDown || !this.client.isReady()) return;
		await Promise.all(this.alwaysOnStore.list().map(async ({ guildId }) => {
			if (this.reconnectPending.has(guildId)) return;
			const retry = this.reconnectBackoff.get(guildId);
			if (retry && Date.now() < retry.retryAt) return;
			this.reconnectPending.add(guildId);
			try {
				await this.withVoiceModeLock(guildId, async () => {
					const target = this.alwaysOnStore.get(guildId);
					if (!target || this.shuttingDown) return;
					try {
						await this.reconnectAlwaysOnTarget(target);
						this.reconnectBackoff.delete(guildId);
					} catch (err) {
						const failures = (this.reconnectBackoff.get(guildId)?.failures ?? 0) + 1;
						const delay = Math.min(300_000, 15_000 * 2 ** Math.min(failures - 1, 5));
						this.reconnectBackoff.set(guildId, { failures, retryAt: Date.now() + delay });
						console.warn(`[24/7] Không thể vào lại server ${guildId}; sẽ thử lại:`, err instanceof Error ? err.message : err);
					}
				});
			} finally {
				this.reconnectPending.delete(guildId);
			}
		}));
	}

	private async reconnectAlwaysOnTarget(target: AlwaysOnVoiceTarget): Promise<void> {
		const existing = this.manager.get(target.guildId);
		const connection = existing?.connection;
		const cachedGuild = this.client.guilds.cache.get(target.guildId);
		const actualChannelId = cachedGuild?.members.me?.voice?.channelId;
		if (
			existing && !existing.destroyed && connection?.joinConfig.channelId === target.voiceChannelId &&
			connection.state.status === VoiceConnectionStatus.Ready && (!actualChannelId || actualChannelId === target.voiceChannelId)
		) {
			this.guardPlayerLifecycle(existing);
			existing.runtimeGraph.lifecycleController.clearLeaveTimeout();
			this.clearEmptyChannelTimer(target.guildId);
			this.ensureAudioSubscription(existing);
			return;
		}

		const guild = cachedGuild ?? await this.client.guilds.fetch(target.guildId);
		const channel = guild.channels.cache.get(target.voiceChannelId) ?? await guild.channels.fetch(target.voiceChannelId);
		if (!channel || !channel.isVoiceBased()) throw new Error("Kênh thoại không còn tồn tại hoặc bot không có quyền xem");
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

	private getUserData(player: Player): PlayerUserData {
		if (!player.userdata) {
			player.userdata = {
				textChannelId: "",
				voiceChannelId: "",
			};
		}
		return player.userdata as PlayerUserData;
	}

	private resolveSendableChannel(channelId?: string): SendableChannels | null {
		if (!channelId) return null;
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
	private buildGuildExtensions(): { extensions: BaseExtension[]; lyricsInstance?: lyricsExt } {
		const extensions: BaseExtension[] = [];
		let lyricsInstance: lyricsExt | undefined;

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
			extensions.push(
				new voiceExt(null, {
					lang: this.config.voiceLang,
					ignoreBots: true,
					minimalVoiceMessageDuration: 1,
					client: this.client,
				}),
			);
		}

		if (this.config.geminiApiKey) {
			extensions.push(new AiAutoplayExtension(this.config.geminiApiKey));
		}

		return { extensions, lyricsInstance };
	}

	/**
	 * Retrieves an active guild player or creates a new one configured with all ZiPlayer 1.x features.
	 */
	async getOrCreatePlayer(opts: {
		guildId: string;
		voiceChannelId: string;
		textChannelId: string;
	}): Promise<Player> {
		// Load the 24/7 state before installing lifecycle guards. A corrupt 24/7
		// file must not prevent unrelated playback from working.
		await this.alwaysOnStore.ready().catch(() => undefined);
		const existing = this.manager.get(opts.guildId);
		if (existing && !existing.destroyed) {
			this.guardPlayerLifecycle(existing);
			const ud = this.getUserData(existing);
			if (opts.textChannelId) ud.textChannelId = opts.textChannelId;
			if (opts.voiceChannelId) ud.voiceChannelId = opts.voiceChannelId;
			return existing;
		}

		const { extensions, lyricsInstance } = this.buildGuildExtensions();
		const initialUserData: PlayerUserData = {
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
		installManagedAudioResources(player, this.config.ffmpegPath);
		installStreamProvenance(player);
		return player;
	}

	/** Restore a missing music subscription without interfering with TTS or pause. */
	private recoverMusicSubscriptions(): void {
		if (this.shuttingDown) return;
		for (const player of this.manager.getAll()) {
			if (player.destroyed || !player.currentTrack || player.playbackMode !== "native") continue;
			// A remote extension can report "native" mode while it plays elsewhere.
			// Only repair when the local AudioPlayer actually has a live resource.
			if (player.audioPlayer.state.status === AudioPlayerStatus.Idle) continue;
			const connection = player.connection;
			if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) continue;
			const ttsPlayer = player.runtimeGraph.ttsController.player;
			// Do not steal voice from a TTS that is buffering, speaking, or paused,
			// even if its own connection subscription has just been displaced.
			if (ttsPlayer.state.status !== AudioPlayerStatus.Idle) continue;
			if (connection.state.subscription?.player === player.audioPlayer) continue;
			try {
				this.ensureAudioSubscription(player);
				this.subscriptionWarnings.delete(player.guildId);
			} catch (error) {
				const now = Date.now();
				if (now - (this.subscriptionWarnings.get(player.guildId) ?? 0) >= 60_000) {
					this.subscriptionWarnings.set(player.guildId, now);
					console.warn(`[Voice] Chưa khôi phục được kết nối nhạc server ${player.guildId}:`, error instanceof Error ? error.message : error);
				}
			}
		}
	}

	/** A ready voice connection can still be detached from the music player. */
	private ensureAudioSubscription(player: Player): void {
		const connection = player.connection;
		if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) {
			throw new Error("Kết nối voice chưa sẵn sàng để gửi âm thanh");
		}
		if (!this.monitoredConnections.has(connection)) {
			this.monitoredConnections.add(connection);
			connection.on("error", (error: Error) => {
				console.error(`[Voice] Lỗi kết nối trong server ${player.guildId}:`, error.message);
			});
		}

		// ZiPlayer can replace the subscription with music when voice becomes
		// Ready again. Restore an active TTS or forward session first, without
		// unpausing it or changing its playback mode.
		const current = connection.state.subscription;
		const ttsPlayer = player.runtimeGraph.ttsController.player;
		if (ttsPlayer.state.status !== AudioPlayerStatus.Idle) {
			if (current?.player !== ttsPlayer && !connection.subscribe(ttsPlayer)) {
				throw new Error("Không thể nối trình phát TTS với kênh thoại");
			}
			return;
		}
		if (player.playbackMode !== "native") {
			const leader = player.runtimeGraph.forwardController.forwardLeader;
			if (leader && !leader.destroyed && current?.player !== leader.audioPlayer && !connection.subscribe(leader.audioPlayer)) {
				throw new Error("Không thể khôi phục chế độ chuyển tiếp âm thanh");
			}
			return;
		}
		if (current?.player === player.audioPlayer) return;

		const subscription = player.runtimeGraph.connectionController.ensureSubscription(connection);
		if (!subscription || subscription.player !== player.audioPlayer) {
			throw new Error("Không thể nối trình phát nhạc với kênh thoại; hãy kiểm tra log voice");
		}
		console.log(`[Voice] Đã khôi phục kết nối trình phát âm thanh trong server ${player.guildId}.`);
	}

	/** Begin recovery promptly for active players, not only on the next command
	 * or the slower 24/7 watchdog. Do not proactively retry a manual/4014 stop. */
	private monitorVoiceRecovery(player: Player, channel: VoiceBasedChannel): void {
		const connection = player.connection;
		if (!connection) return;
		const existing = this.voiceRecoveryTargets.get(connection);
		if (existing) {
			existing.player = player;
			existing.channel = channel;
			return;
		}
		const target = { player, channel, recoverableDisconnect: false };
		this.voiceRecoveryTargets.set(connection, target);
		connection.on(VoiceConnectionStatus.Ready, () => { target.recoverableDisconnect = false; });
		connection.on(VoiceConnectionStatus.Destroyed, () => {
			const currentPlayer = target.player;
			if (target.recoverableDisconnect && !this.shuttingDown && !currentPlayer.destroyed &&
				this.manager.get(currentPlayer.guildId) === currentPlayer && !this.expectedVoiceLeaves.has(currentPlayer.guildId)) {
				// ZiPlayer may destroy its own connection after a recovery timeout,
				// which sends a gateway leave. Keep the queue for a later retry.
				const previousChannelId = connection.joinConfig.channelId || target.channel.id;
				if (previousChannelId) this.expectReplacementLeave(currentPlayer, previousChannelId, 3_000);
			}
			target.recoverableDisconnect = false;
		});
		connection.on(VoiceConnectionStatus.Disconnected, () => {
			const currentPlayer = target.player;
			const state = connection.state;
			if (this.shuttingDown || currentPlayer.destroyed || currentPlayer.connection !== connection ||
				this.manager.get(currentPlayer.guildId) !== currentPlayer || state.status !== VoiceConnectionStatus.Disconnected) return;
			target.recoverableDisconnect = state.reason !== VoiceConnectionDisconnectReason.Manual &&
				!(state.reason === VoiceConnectionDisconnectReason.WebSocketClose && state.closeCode === 4014);
			if (!target.recoverableDisconnect || this.proactiveVoiceRecoveries.has(currentPlayer.guildId)) return;

			const voiceId = this.getUserData(currentPlayer).voiceChannelId || connection.joinConfig.channelId;
			const voice = voiceId === target.channel.id ? target.channel : target.channel.guild.channels.cache.get(voiceId ?? "");
			if (!voice || !voice.isVoiceBased()) return;
			const recovery = this.ensureConnected(currentPlayer, voice).catch((error: unknown) => {
				if (!this.shuttingDown && !currentPlayer.destroyed) {
					console.warn(`[Voice] Chưa khôi phục được kết nối server ${currentPlayer.guildId}:`, error instanceof Error ? error.message : error);
				}
			});
			this.proactiveVoiceRecoveries.set(currentPlayer.guildId, recovery);
			void recovery.finally(() => {
				if (this.proactiveVoiceRecoveries.get(currentPlayer.guildId) === recovery) this.proactiveVoiceRecoveries.delete(currentPlayer.guildId);
			});
		});
	}

	/** Allow Discord's own short reconnect to complete before replacing a voice
	 * session. Also stop waiting promptly if the connection is destroyed. */
	private async waitForVoiceReady(connection: NonNullable<Player["connection"]>, timeoutMs: number, player: Player): Promise<boolean> {
		if (this.shuttingDown || player.destroyed) return false;
		if (connection.state.status === VoiceConnectionStatus.Ready) return true;
		if (connection.state.status === VoiceConnectionStatus.Destroyed) return false;
		const controller = new AbortController();
		const cancel = () => controller.abort();
		const timer = setTimeout(cancel, timeoutMs);
		player.once("playerDestroy", cancel);
		this.shutdownSignal.signal.addEventListener("abort", cancel, { once: true });
		if (this.shuttingDown || player.destroyed) cancel();
		try {
			await Promise.race([
				once(connection, VoiceConnectionStatus.Ready, { signal: controller.signal }),
				once(connection, VoiceConnectionStatus.Destroyed, { signal: controller.signal }),
			]);
		} catch {
			// Timeout, an underlying voice error, or cancellation. The caller
			// checks the current state and decides whether a retry is needed.
		} finally {
			clearTimeout(timer);
			player.off("playerDestroy", cancel);
			this.shutdownSignal.signal.removeEventListener("abort", cancel);
			controller.abort();
		}
		// State can change while awaiting events; TypeScript's initial narrowing
		// does not account for that mutation.
		const status = connection.state.status as VoiceConnectionStatus;
		return status === VoiceConnectionStatus.Ready;
	}

	/** Serialize joins for a guild so overlapping /play, TTS and 24/7 checks do
	 * not race one another and replace a voice connection that is still joining. */
	async ensureConnected(player: Player, voiceChannel: VoiceBasedChannel): Promise<void> {
		const previous = this.voiceConnectionLocks.get(player.guildId) ?? Promise.resolve();
		const operation = previous.catch(() => undefined).then(() => this.ensureConnectedOnce(player, voiceChannel));
		this.voiceConnectionLocks.set(player.guildId, operation);
		try {
			await operation;
		} finally {
			if (this.voiceConnectionLocks.get(player.guildId) === operation) this.voiceConnectionLocks.delete(player.guildId);
		}
	}

	/** Connect to the requested Discord voice/stage channel if needed. */
	private async ensureConnectedOnce(player: Player, voiceChannel: VoiceBasedChannel): Promise<void> {
		if (this.shuttingDown || player.destroyed) throw new Error("Trình phát đã bị ngắt trong lúc kết nối voice");
		const ud = this.getUserData(player);
		let connection = player.connection;
		let currentChannelId = connection?.joinConfig?.channelId;
		let state = connection?.state?.status;
		let actualChannelId = voiceChannel.guild.members.me?.voice?.channelId;
		let joined = false;

		if (connection && state === VoiceConnectionStatus.Disconnected && currentChannelId === voiceChannel.id &&
			typeof connection.rejoin === "function") {
			// Discord or its voice library may already be repairing a brief drop.
			// Give that a chance rather than destroying a live player immediately.
			await this.waitForVoiceReady(connection, 2_000, player);
			if (this.shuttingDown || player.destroyed) throw new Error("Trình phát đã bị ngắt trong lúc kết nối voice");
			connection = player.connection;
			currentChannelId = connection?.joinConfig?.channelId;
			state = connection?.state?.status;
			actualChannelId = voiceChannel.guild.members.me?.voice?.channelId;
			if (connection && state === VoiceConnectionStatus.Disconnected && currentChannelId === voiceChannel.id) {
				const detail = connection.state;
				// A 4014 or manual disconnect is not suitable for an in-place
				// retry. Let the normal fresh-connection path handle it instead.
				const forbidden = detail.status === VoiceConnectionStatus.Disconnected && (
					detail.reason === VoiceConnectionDisconnectReason.Manual ||
					(detail.reason === VoiceConnectionDisconnectReason.WebSocketClose && detail.closeCode === 4014)
				);
				if (!forbidden && connection.rejoin({
					channelId: voiceChannel.id,
					selfDeaf: connection.joinConfig.selfDeaf,
					selfMute: connection.joinConfig.selfMute,
				})) {
					state = connection.state.status;
					joined = true;
				}
			}
		}

		const moved = Boolean(actualChannelId && actualChannelId !== voiceChannel.id);
		const disconnected = state === VoiceConnectionStatus.Disconnected || state === VoiceConnectionStatus.Destroyed;
		if (connection && state === VoiceConnectionStatus.Ready && (currentChannelId !== voiceChannel.id || moved)) {
			// ZiPlayer can reuse a ready connection without moving it. Send a voice
			// rejoin directly when the chosen room differs from the current room.
			const sent = connection.rejoin({
				channelId: voiceChannel.id,
				selfDeaf: connection.joinConfig.selfDeaf,
				selfMute: connection.joinConfig.selfMute,
			});
			if (!sent) throw new Error("Không thể gửi yêu cầu chuyển kênh thoại");
			joined = true;
		} else if (!connection || currentChannelId !== voiceChannel.id || disconnected) {
			const previousChannelId = currentChannelId || actualChannelId;
			if (previousChannelId) this.expectReplacementLeave(player, previousChannelId);
			try {
				await player.connect(voiceChannel as unknown as Parameters<Player["connect"]>[0]);
			} finally {
				this.finishReplacementLeave(player);
			}
			if (this.shuttingDown || player.destroyed) throw new Error("Trình phát đã bị ngắt trong lúc kết nối voice");
			joined = true;
		}

		const activeConnection = player.connection;
		if (!activeConnection) throw new Error("Không thể tạo kết nối voice");
		if (activeConnection.state.status !== VoiceConnectionStatus.Ready && !(await this.waitForVoiceReady(activeConnection, 15_000, player))) {
			throw new Error("Kết nối voice chưa sẵn sàng; hãy kiểm tra mạng và quyền kênh");
		}
		if (this.shuttingDown || player.destroyed || player.connection !== activeConnection) {
			throw new Error("Kết nối voice đã thay đổi trong lúc chuẩn bị phát");
		}
		this.ensureAudioSubscription(player);
		this.monitorVoiceRecovery(player, voiceChannel);

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
	scheduleControllerRefresh(player: Player, delayMs = 300): void {
		const guildId = player.guildId;
		const existingTimer = this.refreshTimers.get(guildId);
		if (existingTimer) clearTimeout(existingTimer);

		const timer = setTimeout(() => {
			this.refreshTimers.delete(guildId);
			if (player.destroyed) return;
			void this.updateControllerInPlace(player).catch(() => undefined);
		}, delayMs);
		timer.unref?.();
		this.refreshTimers.set(guildId, timer);
	}

	/**
	 * Sends a brand-new Now Playing controller message (deleting the old one to keep chat tidy).
	 */
	async sendFreshController(player: Player): Promise<Message | null> {
		const ud = this.getUserData(player);
		const channel = this.resolveSendableChannel(ud.textChannelId);
		if (!channel) return null;

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

	private async updateControllerInPlace(player: Player, disabled = false): Promise<void> {
		const ud = this.getUserData(player);
		if (!ud.controllerMessageId) return;
		const channel = this.resolveSendableChannel(ud.textChannelId);
		if (!channel) return;

		const payload = buildNowPlayingPayload(player, disabled);
		await channel.messages
			.fetch(ud.controllerMessageId)
			.then((msg) => msg.edit(payload))
			.catch(() => {
				if (disabled) ud.controllerMessageId = undefined;
			});

		if (disabled) {
			ud.controllerMessageId = undefined;
		}
	}

	private clearGuildTimers(guildId: string): void {
		this.clearExpectedVoiceLeave(guildId);
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

	private bindManagerEvents(): void {
		this.manager.on("debug", (msg: string, ...args: unknown[]) => {
			if (this.config.debugLevel !== "off") {
				console.debug(`[ZiPlayer] ${msg}`, ...args);
			}
		});

		this.manager.on("trackStart", (player: Player, track: Track) => {
			const ud = this.getUserData(player);
			ud.cachedLyrics = null;
			ud.lyricsTrackId = track.id || track.url;
			ud.lyricsMessageId = undefined;
			void this.sendFreshController(player);
		});

		this.manager.on("queueAdd", (player: Player, track: Track) => {
			// If a song is already playing, notify softly & refresh controller queue counter
			if (player.currentTrack && player.currentTrack.id !== track.id) {
				this.scheduleControllerRefresh(player, 350);
			}
		});

		this.manager.on("queueAddList", (player: Player, tracks: Track[]) => {
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
		] as const) {
			this.manager.on(evt, (player: Player, ..._args: unknown[]) => {
				this.scheduleControllerRefresh(player, 250);
			});
		}

		this.manager.on("queueEnd", (player: Player) => {
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

		this.manager.on("playerStop", (player: Player) => {
			void this.updateControllerInPlace(player, true);
		});

		this.manager.on("playerDestroy", (player: Player) => {
			this.subscriptionWarnings.delete(player.guildId);
			this.clearGuildTimers(player.guildId);
			void this.updateControllerInPlace(player, true);
		});

		this.manager.on("lyricsCreate", (player: Player, track: Track, result: LyricsResult) => {
			const ud = this.getUserData(player);
			ud.cachedLyrics = result;
			ud.lyricsTrackId = track.id || track.url;
		});

		this.manager.on("lyricsChange", async (player: Player, track: Track, result: LyricsResult) => {
			const ud = this.getUserData(player);
			ud.cachedLyrics = result;
			if (!ud.liveLyricsEnabled || !result?.current) return;

			const now = Date.now();
			if (ud.lastLyricsEditAt && now - ud.lastLyricsEditAt < 1_800) {
				return; // Guard against Discord per-message edit rate limits
			}
			ud.lastLyricsEditAt = now;

			const channel = this.resolveSendableChannel(ud.textChannelId);
			if (!channel) return;

			const embed = buildLiveLyricsEmbed(track, result);
			if (ud.lyricsMessageId) {
				const edited = await channel.messages
					.fetch(ud.lyricsMessageId)
					.then((m) => m.edit({ embeds: [embed] }))
					.catch(() => null);
				if (edited) return;
			}

			const sent = await channel.send({ embeds: [embed] }).catch(() => null);
			if (sent) {
				ud.lyricsMessageId = sent.id;
			}
		});

		this.manager.on(
			"voiceCreate",
			async (player: Player, payload: { content: string; userId: string; channelId: string; guildId: string }) => {
				const ud = this.getUserData(player);
				if (!ud.voiceCommandsEnabled) return;

				const action = parseVoiceCommand(payload.content, this.config.voiceWakeWords);
				if (!action) return;

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
				} catch (err) {
					console.error(`[VoiceCommand] Error in guild ${player.guildId}:`, err);
				}
			},
		);

		this.manager.on("trackStuck", (player: Player, track: Track | null) => {
			console.warn(`[ZiPlayer] Track stuck in guild ${player.guildId}: ${track?.title ?? "unknown"} (Anti-Stuck recovering...)`);
		});

		this.manager.on("playerError", (player: Player, error: Error, track?: Track) => {
			console.error(`[ZiPlayer] Player error in guild ${player.guildId}:`, error.message);
			const ud = this.getUserData(player);
			const channel = this.resolveSendableChannel(ud.textChannelId);
			if (channel) {
				const embed = new EmbedBuilder()
					.setColor(COLORS.ERROR)
					.setDescription(
						`⚠️ Không thể phát ${track ? `**${truncate(track.title, 80)}**` : "bài hát"}: \`${truncate(error.message, 140)}\``,
					);
				void channel.send({ embeds: [embed] }).catch(() => undefined);
			}
		});

		this.manager.on("connectionError", (player: Player, error: Error) => {
			console.error(`[ZiPlayer] Voice connection error in guild ${player.guildId}:`, error.message);
		});
	}

	private bindDiscordVoiceEvents(): void {
		this.client.on("voiceStateUpdate", (oldState, newState) => {
			const guildId = newState.guild.id;
			const player = this.manager.get(guildId);
			if (!player || player.destroyed) return;

			const botId = this.client.user?.id;
			if (botId && newState.id === botId) {
				if (oldState.channelId && !newState.channelId) {
					const expected = this.expectedVoiceLeaves.get(guildId);
					if (expected?.player === player && expected.fromChannelId === oldState.channelId) {
						// Our own connection replacement emits this leave. Keep the
						// player and queue while the new connection is established.
						this.clearExpectedVoiceLeave(guildId);
						return;
					}
					// An unanticipated server-side removal still tears down the player.
					player.destroy();
					return;
				}
				// Bot was moved to another voice channel
				if (newState.channelId && oldState.channelId !== newState.channelId) {
					if (!oldState.channelId) this.clearExpectedVoiceLeave(guildId);
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
	async restorePersistedSessions(): Promise<number> {
		if (!this.config.enablePersistence) {
			this.sessionRestoreComplete = true;
			return 0;
		}
		await this.alwaysOnStore.ready().catch(() => undefined);
		const sessions = await this.persistence.loadValidSessions();
		// Keep one manual recovery copy in case Discord/voice is unavailable or
		// the host stops again before a fresh periodic snapshot can be written.
		await this.persistence.backupForRecovery(sessions).catch((error: unknown) => {
			console.warn("[Persistence] Không thể tạo bản dự phòng phiên nhạc:", error instanceof Error ? error.message : error);
		});
		let restoredCount = 0;

		for (const session of sessions) {
			try {
				await this.withVoiceModeLock(session.guildId, async () => {
					if (this.shuttingDown || this.suppressedSessionRestores.has(session.guildId)) return;
					const alwaysOn = this.alwaysOnStore.get(session.guildId);
					if (alwaysOn && alwaysOn.voiceChannelId !== session.voiceChannelId) return;
					const guild = this.client.guilds.cache.get(session.guildId);
					if (!guild) return;

					const voiceCh = guild.channels.cache.get(session.voiceChannelId);
					if (!voiceCh || !voiceCh.isVoiceBased()) return;

					const humans = voiceCh.members.filter((m) => !m.user.bot).size;
					if (humans === 0) return;

					const player = await this.getOrCreatePlayer({
						guildId: session.guildId,
						voiceChannelId: session.voiceChannelId,
						textChannelId: session.textChannelId,
					});
					// A listener may have started a new session while startup was still
					// restoring snapshots. Never insert old songs into their live queue.
					if (player.currentTrack || player.queueSize > 0) return;

					await this.ensureConnected(player, voiceCh);
					player.setVolume(session.volume);
					player.loop(session.loopMode);
					player.autoPlay(session.autoPlay);

					if (session.activeFilters.length > 0) {
						await player.filter.applyFilters(session.activeFilters).catch(() => undefined);
					}

					const tracksToRestore: Track[] = [
						...(session.currentTrack ? [session.currentTrack] : []),
						...session.upcomingTracks,
					];

					if (tracksToRestore.length > 0) {
						// ZiPlayer.play(track) appends to an existing queue before starting.
						// Enqueue the whole snapshot in order and start its first item;
						// otherwise the first waiting song starts before the current song.
						player.queue.addMultiple(tracksToRestore);
						const started = await player.play(null, tracksToRestore[0].requestedBy);
						if (!started) {
							console.warn(`[Persistence] Không thể bắt đầu phiên nhạc đã lưu cho server ${session.guildId}.`);
							return;
						}
						restoredCount++;

						const textChannel = this.resolveSendableChannel(session.textChannelId);
						if (textChannel) {
							const embed = new EmbedBuilder()
								.setColor(COLORS.PLAYING)
								.setDescription(
									`🔄 Đã tự động khôi phục phiên phát nhạc (**${tracksToRestore.length}** bài) sau khi khởi động lại!`,
								);
							await textChannel.send({ embeds: [embed] }).catch(() => undefined);
						}
					}
				});
			} catch (err) {
				console.warn(`[Persistence] Could not restore session for guild ${session.guildId}:`, err);
			}
		}

		// Do not delete the old snapshot before the first new one has been saved.
		this.sessionRestoreComplete = true;
		return restoredCount;
	}

	startSessionSaving(): void {
		// A slow restore must finish before periodic snapshots may overwrite it.
		if (!this.shuttingDown && this.sessionRestoreComplete) {
			this.persistence.startPeriodicSave(this.manager, 30_000);
		}
	}

	async shutdown(options: { saveSessions?: boolean } = {}): Promise<void> {
		this.shuttingDown = true;
		this.shutdownSignal.abort();
		if (this.musicSubscriptionTimer) clearInterval(this.musicSubscriptionTimer);
		this.musicSubscriptionTimer = null;
		this.subscriptionWarnings.clear();
		if (this.alwaysOnTimer) clearInterval(this.alwaysOnTimer);
		this.alwaysOnTimer = null;
		await Promise.allSettled([...this.voiceModeLocks.values(), ...this.voiceConnectionLocks.values()]);
		this.persistence.stopPeriodicSave();
		// Never overwrite an old snapshot while startup restoration is unfinished
		// (or when a client failed before login during an intent retry).
		if (options.saveSessions !== false && this.sessionRestoreComplete) {
			await this.persistence.saveAll(this.manager).catch(() => undefined);
		}
		for (const guildId of [...this.refreshTimers.keys(), ...this.emptyChannelTimers.keys(), ...this.expectedVoiceLeaves.keys()]) {
			this.clearGuildTimers(guildId);
		}
		this.manager.destroy();
	}
}
