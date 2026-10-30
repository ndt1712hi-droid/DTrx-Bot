import { AudioPlayerStatus, VoiceConnectionStatus } from "@discordjs/voice";
import {
	AttachmentBuilder,
	ChannelType,
	EmbedBuilder,
	PermissionFlagsBits,
	type Guild,
	type GuildMember,
	type MessageCreateOptions,
	type MessagePayload,
	type VoiceBasedChannel,
} from "discord.js";
import { PREDEFINED_FILTERS, type LoopMode, type Player } from "ziplayer";
import type { ZiMusicBotEngine } from "../core/musicEngine.js";
import { exportTrackToMp3Buffer } from "../core/exporter.js";
import { waitForAudioDelivery } from "../core/playbackHealth.js";
import { getPlaybackFallback } from "../core/streamProvenance.js";
import type { PlayerUserData } from "../types/bot.js";
import {
	buildFullLyricsEmbed,
	buildHelpEmbed,
	buildQueueEmbed,
	buildStatsEmbed,
	COLORS,
} from "../ui/embeds.js";
import {
	formatDuration,
	formatLoopMode,
	formatSourceBadge,
	parseTimeInput,
	sanitizeFilename,
	truncate,
} from "../utils/format.js";
import { normalizeMusicQuery } from "../utils/musicQuery.js";

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

function infoEmbed(description: string, color: number = COLORS.PRIMARY): EmbedBuilder {
	return new EmbedBuilder().setColor(color).setDescription(description);
}

class TtsSearchTimeoutError extends Error {
	constructor() {
		super("TTS metadata search timed out");
		this.name = "TtsSearchTimeoutError";
	}
}

/** Bound TTS metadata lookup; an expired search cannot start playback later. */
async function withTtsSearchTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new TtsSearchTimeoutError()), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Validates that the member is in a voice channel, and if a guild player is already
 * connected, ensures the member is in the SAME voice channel as the bot.
 */
export function validateMemberVoiceAccess(
	member: GuildMember,
	existingPlayer?: Player,
): { ok: true; voiceChannel: VoiceBasedChannel } | { ok: false; reason: string } {
	const voiceChannel = member.voice?.channel;
	if (!voiceChannel) {
		return {
			ok: false,
			reason: "❌ Bạn cần tham gia một **kênh thoại (Voice Channel)** trước khi sử dụng lệnh này!",
		};
	}

	const botChannelId = existingPlayer?.connection?.joinConfig?.channelId;
	if (existingPlayer && !existingPlayer.destroyed && botChannelId && botChannelId !== voiceChannel.id) {
		return {
			ok: false,
			reason: `❌ Bạn phải ở cùng kênh thoại <#${botChannelId}> với Bot để điều khiển nhạc!`,
		};
	}

	const me = member.guild.members.me;
	if (me && (!botChannelId || botChannelId !== voiceChannel.id)) {
		const perms = voiceChannel.permissionsFor(me);
		if (perms && (!perms.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.Connect))) {
			return {
				ok: false,
				reason: `❌ Bot thiếu quyền **Xem kênh** hoặc **Kết nối (Connect)** vào <#${voiceChannel.id}>!`,
			};
		}
		if (perms && voiceChannel.type !== ChannelType.GuildStageVoice && !perms.has(PermissionFlagsBits.Speak)) {
			return {
				ok: false,
				reason: `❌ Bot thiếu quyền **Nói (Speak)** trong <#${voiceChannel.id}>!`,
			};
		}
	}

	return { ok: true, voiceChannel };
}

/** Check audio-specific permissions even when 24/7 already joined the room. */
export function getVoicePlaybackIssue(member: GuildMember, channel: VoiceBasedChannel): string | null {
	const me = member.guild.members.me;
	if (!me) return null;
	const permissions = channel.permissionsFor(me);
	if (permissions && channel.type !== ChannelType.GuildStageVoice && !permissions.has(PermissionFlagsBits.Speak)) {
		return `Bot thiếu quyền **Nói (Speak)** trong <#${channel.id}>. Hãy bật quyền này cho bot trong cài đặt kênh.`;
	}
	const voice = me.voice;
	if (voice?.channelId === channel.id && voice.serverMute) {
		return "Bot đang bị quản trị viên tắt tiếng trong phòng thoại. Hãy bỏ tắt tiếng máy chủ cho bot.";
	}
	if (voice?.channelId === channel.id && voice.selfMute) {
		return "Bot đang tự tắt mic. Hãy khởi động lại bot rồi thử phát lại.";
	}
	return null;
}

class VoicePlaybackError extends Error {}

async function prepareVoiceForPlayback(member: GuildMember, channel: VoiceBasedChannel): Promise<void> {
	const issue = getVoicePlaybackIssue(member, channel);
	if (issue) throw new VoicePlaybackError(issue);

	// A Stage audience member can join successfully while remaining inaudible.
	const voice = member.guild.members.me?.voice;
	if (channel.type === ChannelType.GuildStageVoice && voice?.channelId === channel.id && voice.suppress) {
		try {
			await voice.setSuppressed(false);
		} catch {
			throw new VoicePlaybackError("Bot đang là khán giả trong Stage. Hãy mời bot làm diễn giả hoặc dùng phòng thoại thường.");
		}
	}
}

export class MusicCommandActions {
	constructor(private readonly engine: ZiMusicBotEngine) {}

	private getActivePlayerOrReply(ctx: CommandContext): Player | null {
		const player = this.engine.manager.get(ctx.guild.id);
		if (!player || player.destroyed || (!player.currentTrack && player.queueSize === 0 && !player.connection)) {
			void ctx.reply({
				embeds: [infoEmbed("❌ Hiện không có bài hát nào đang phát trong Server này!", COLORS.ERROR)],
				ephemeral: true,
			});
			return null;
		}
		return player;
	}

	async play(ctx: CommandContext, query?: string, attachmentUrl?: string): Promise<void> {
		const effectiveQuery = normalizeMusicQuery(attachmentUrl || query || "");
		if (!effectiveQuery) {
			await ctx.reply({
				embeds: [
					infoEmbed(
						"❌ Vui lòng nhập **tên bài hát**, **URL** (YouTube / SoundCloud / Spotify / MP3), hoặc đính kèm một file âm thanh!",
						COLORS.ERROR,
					),
				],
				ephemeral: true,
			});
			return;
		}

		const existing = this.engine.manager.get(ctx.guild.id);
		const access = validateMemberVoiceAccess(ctx.member, existing);
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}
		const voiceIssue = getVoicePlaybackIssue(ctx.member, access.voiceChannel);
		if (voiceIssue) {
			await ctx.reply({ embeds: [infoEmbed(`❌ ${voiceIssue}`, COLORS.ERROR)], ephemeral: true });
			return;
		}

		await ctx.defer();

		try {
			const player = await this.engine.getOrCreatePlayer({
				guildId: ctx.guild.id,
				voiceChannelId: access.voiceChannel.id,
				textChannelId: ctx.textChannelId,
			});

			await this.engine.ensureConnected(player, access.voiceChannel);
			await prepareVoiceForPlayback(ctx.member, access.voiceChannel);

			const wasAlreadyPlaying = Boolean(player.currentTrack && (
				player.isPlaying || player.isPaused || player.isBuffering || player.audioPlayer.state.status === AudioPlayerStatus.AutoPaused
			));
			const beforeSize = player.queueSize;

			const ok = await player.play(effectiveQuery, ctx.userId);
			if (!ok) {
				console.warn(`[Playback] Không thể tìm hoặc tải luồng nhạc trong server ${ctx.guild.id}.`);
				await ctx.reply({
					embeds: [infoEmbed("❌ Không tìm thấy bài hoặc không tải được nguồn âm thanh. Hãy thử link khác và kiểm tra log Botkeep nếu lỗi tiếp diễn.", COLORS.ERROR)],
				});
				return;
			}

			const addedCount = Math.max(0, player.queueSize - beforeSize);
			const ttsActive = player.connection?.state.status === VoiceConnectionStatus.Ready &&
				player.connection.state.subscription?.player === player.runtimeGraph.ttsController.player;
			const queueHint = player.volume <= 0
				? "\n🔇 Âm lượng đang là 0; dùng `/volume 80` để bật tiếng."
				: ttsActive
					? "\n🗣️ Bot đang đọc TTS; nhạc sẽ tiếp tục sau đó."
					: player.audioPlayer.state.status === AudioPlayerStatus.Paused
						? "\n⏸️ Nhạc đang tạm dừng; dùng `/resume` để phát tiếp."
						: "";
			if (wasAlreadyPlaying && addedCount > 1) {
				await ctx.reply({
					embeds: [
						infoEmbed(
							`✅ Đã thêm **${addedCount}** bài hát từ \`${truncate(effectiveQuery, 100)}\` vào hàng đợi!${queueHint}`,
							COLORS.PLAYING,
						),
					],
				});
			} else if (wasAlreadyPlaying) {
				const last = player.queue.lastTrack;
				await ctx.reply({
					embeds: [
						infoEmbed(
							`✅ Đã thêm vào hàng đợi (#${player.queueSize}): **${truncate(last?.title || effectiveQuery, 120)}** \`[${formatDuration(last?.duration, last?.isLive)}]\`${queueHint}`,
							COLORS.PLAYING,
						),
					],
				});
			} else {
				const delivery = await waitForAudioDelivery(player);
				const fallback = getPlaybackFallback(player, player.currentTrack);
				const title = truncate(fallback?.title || player.currentTrack?.title || effectiveQuery, 140);
				const fallbackHint = fallback && delivery !== "replaced"
					? `\n⚠️ Không tải được nguồn gốc; bot chọn bản dự phòng từ ${formatSourceBadge(fallback.source)} (có thể khác phiên bản).`
					: "";
				const descriptions: Record<typeof delivery, string> = {
					delivering: `🎶 Đang gửi âm thanh: **${title}** tại <#${access.voiceChannel.id}>.`,
					muted: `🔇 Đã tải **${title}** nhưng âm lượng đang là 0. Dùng \`/volume 80\` để bật tiếng.`,
					paused: `⏸️ Đã nhận **${title}** nhưng trình phát đang tạm dừng. Hãy thử \`/resume\`.`,
					tts: `🗣️ Đã nhận **${title}**. Bot đang đọc TTS; hãy đợi TTS kết thúc.`,
					disconnected: `⚠️ Đã nhận **${title}** nhưng kết nối thoại chưa sẵn sàng. Hãy kiểm tra log Botkeep.`,
					"no-subscription": `⚠️ Đã nhận **${title}** nhưng trình phát chưa nối được với voice. Hãy kiểm tra log Botkeep.`,
					stopped: `⚠️ Luồng **${title}** đã dừng trước khi xác nhận có gói âm thanh. Hãy thử link khác và xem log Botkeep.`,
					replaced: "⏭️ Yêu cầu phát đã thay đổi trong lúc bot chuẩn bị âm thanh.",
					buffering: `⏳ Đã nhận **${title}** nhưng chưa xác nhận được gói âm thanh. Hãy kiểm tra log Botkeep nếu vẫn im lặng.`,
					external: `🎵 Đã gửi yêu cầu phát **${title}** tới trình phát ngoài.`,
				};
				if (!["delivering", "external", "replaced"].includes(delivery)) {
					console.warn(`[Playback] Chưa xác nhận âm thanh server=${player.guildId} result=${delivery} voice=${player.connection?.state.status ?? "none"} audio=${player.audioPlayer.state.status} volume=${player.volume}`);
				}
				await ctx.reply({
					embeds: [infoEmbed(descriptions[delivery] + fallbackHint, delivery === "delivering" ? COLORS.PLAYING : COLORS.INFO)],
				});
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await ctx.reply({
				embeds: [infoEmbed(`❌ Đã xảy ra lỗi khi phát nhạc: \`${truncate(message, 180)}\``, COLORS.ERROR)],
			});
		}
	}

	async playNext(ctx: CommandContext, query: string): Promise<void> {
		const trimmed = normalizeMusicQuery(query);
		if (!trimmed) {
			await ctx.reply({
				embeds: [infoEmbed("❌ Vui lòng nhập tên bài hát hoặc URL cần chèn phát kế tiếp!", COLORS.ERROR)],
				ephemeral: true,
			});
			return;
		}

		const existing = this.engine.manager.get(ctx.guild.id);
		if (!existing || !existing.currentTrack) {
			await this.play(ctx, trimmed);
			return;
		}

		const access = validateMemberVoiceAccess(ctx.member, existing);
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}

		await ctx.defer();
		const inserted = await existing.insert(trimmed, 0, ctx.userId);
		if (!inserted) {
			await ctx.reply({
				embeds: [infoEmbed(`❌ Không tìm thấy bài hát cho: \`${truncate(trimmed, 120)}\``, COLORS.ERROR)],
			});
			return;
		}

		const nextTrack = existing.queue.nextTrack;
		this.engine.scheduleControllerRefresh(existing, 200);
		await ctx.reply({
			embeds: [
				infoEmbed(
					`⏭️ Đã chèn lên đầu hàng đợi (phát ngay kế tiếp): **${truncate(nextTrack?.title || trimmed, 130)}**`,
					COLORS.PLAYING,
				),
			],
		});
	}

	async tts(ctx: CommandContext, text: string): Promise<void> {
		const cleaned = text.trim();
		if (!cleaned) {
			await ctx.reply({
				embeds: [infoEmbed("❌ Vui lòng nhập nội dung văn bản cần đọc!", COLORS.ERROR)],
				ephemeral: true,
			});
			return;
		}

		const existing = this.engine.manager.get(ctx.guild.id);
		const access = validateMemberVoiceAccess(ctx.member, existing);
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}
		const voiceIssue = getVoicePlaybackIssue(ctx.member, access.voiceChannel);
		if (voiceIssue) {
			await ctx.reply({ embeds: [infoEmbed(`❌ ${voiceIssue}`, COLORS.ERROR)], ephemeral: true });
			return;
		}

		await ctx.defer();
		try {
			const player = await this.engine.getOrCreatePlayer({
				guildId: ctx.guild.id,
				voiceChannelId: access.voiceChannel.id,
				textChannelId: ctx.textChannelId,
			});
			await this.engine.ensureConnected(player, access.voiceChannel);
			await prepareVoiceForPlayback(ctx.member, access.voiceChannel);

			const ttsResult = await withTtsSearchTimeout(
				this.engine.ttsPlugin.search(`tts:${cleaned}`, ctx.userId),
				Math.min(this.engine.config.extractorTimeoutMs, 20_000),
			);
			const ttsTrack = ttsResult?.tracks?.[0];
			if (!ttsTrack) {
				await ctx.reply({
					embeds: [infoEmbed("❌ Không thể tạo luồng giọng đọc TTS lúc này.", COLORS.ERROR)],
				});
				return;
			}

			const ok = await player.play(ttsTrack, ctx.userId);
			if (!ok) {
				await ctx.reply({
					embeds: [infoEmbed("❌ Không thể phát giọng đọc TTS trên kênh thoại.", COLORS.ERROR)],
				});
				return;
			}

			await ctx.reply({
				embeds: [infoEmbed(`🗣️ Đã gửi giọng đọc tới <#${access.voiceChannel.id}>: *"${truncate(cleaned, 180)}"*`, COLORS.INFO)],
			});
		} catch (err) {
			console.error(`[TTS] Lỗi trong server ${ctx.guild.id}:`, err instanceof Error ? err.message : err);
			const message = err instanceof TtsSearchTimeoutError
				? "❌ Dịch vụ TTS phản hồi quá lâu. Hãy thử lại sau và kiểm tra kết nối mạng của bot."
				: err instanceof VoicePlaybackError
					? `❌ ${err.message}`
					: "❌ Không thể tạo hoặc phát giọng đọc TTS. Hãy thử lại và kiểm tra log Botkeep nếu lỗi tiếp diễn.";
			await ctx.reply({ embeds: [infoEmbed(message, COLORS.ERROR)], ephemeral: true });
		}
	}

	async alwaysOnVoice(ctx: CommandContext, modeInput = "status"): Promise<void> {
		const mode = modeInput.trim().toLowerCase();
		if (["status", "trangthai", "trạng thái", ""].includes(mode)) {
			let target;
			try {
				target = await this.engine.getAlwaysOnVoiceTarget(ctx.guild.id);
			} catch (err) {
				console.error("[24/7] Không thể đọc cấu hình:", err instanceof Error ? err.message : err);
				await ctx.reply({ embeds: [infoEmbed("❌ Không thể đọc trạng thái 24/7. Hãy kiểm tra log Botkeep.", COLORS.ERROR)], ephemeral: true });
				return;
			}
			if (!target) {
				await ctx.reply({ embeds: [infoEmbed("💤 Chế độ 24/7 đang **tắt**. Vào phòng thoại và dùng `/247 on` để bật.", COLORS.INFO)] });
				return;
			}
			const connection = this.engine.manager.get(ctx.guild.id)?.connection;
			const actualChannelId = ctx.guild.members.me?.voice?.channelId;
			const connected = connection?.joinConfig.channelId === target.voiceChannelId &&
				connection.state?.status === VoiceConnectionStatus.Ready &&
				(!actualChannelId || actualChannelId === target.voiceChannelId);
			await ctx.reply({
				embeds: [infoEmbed(`🔁 24/7 đang **bật** tại <#${target.voiceChannelId}>. ${connected ? "Bot đang kết nối." : "Bot chưa kết nối và sẽ tự thử lại."}`, COLORS.INFO)],
			});
			return;
		}

		if (["off", "tat", "tắt"].includes(mode)) {
			await ctx.defer();
			let removed: boolean;
			try {
				removed = await this.engine.disableAlwaysOnVoice(ctx.guild.id);
			} catch (err) {
				console.error("[24/7] Không thể tắt chế độ:", err instanceof Error ? err.message : err);
				await ctx.reply({ embeds: [infoEmbed("❌ Không thể lưu việc tắt 24/7. Hãy kiểm tra log Botkeep và thử lại.", COLORS.ERROR)], ephemeral: true });
				return;
			}
			await ctx.reply({
				embeds: [infoEmbed(
					removed
						? "⏹️ Đã tắt chế độ 24/7. Bot sẽ rời theo cài đặt thông thường; dùng `/leave` để rời ngay."
						: "💤 Chế độ 24/7 vốn đang tắt.",
					COLORS.INFO,
				)],
			});
			return;
		}

		if (!["on", "bat", "bật"].includes(mode)) {
			await ctx.reply({ embeds: [infoEmbed("❌ Dùng `/247 on`, `/247 off` hoặc `/247 status`.", COLORS.ERROR)], ephemeral: true });
			return;
		}

		const existing = this.engine.manager.get(ctx.guild.id);
		const access = validateMemberVoiceAccess(ctx.member, existing);
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}
		await ctx.defer();
		try {
			await this.engine.enableAlwaysOnVoice({
				guildId: ctx.guild.id,
				voiceChannelId: access.voiceChannel.id,
				textChannelId: ctx.textChannelId,
			}, access.voiceChannel);
			await ctx.reply({
				embeds: [infoEmbed(`🔁 Đã bật **24/7** tại <#${access.voiceChannel.id}>. Bot sẽ ở lại khi hết nhạc hoặc phòng trống và thử vào lại khi bị ngắt.`, COLORS.PLAYING)],
			});
		} catch (err) {
			console.error(`[24/7] Không thể bật trong server ${ctx.guild.id}:`, err instanceof Error ? err.message : err);
			const saved = await this.engine.getAlwaysOnVoiceTarget(ctx.guild.id).catch(() => undefined);
			const message = saved?.voiceChannelId === access.voiceChannel.id
				? "⚠️ Đã lưu chế độ 24/7 nhưng bot chưa vào được phòng. Kiểm tra quyền Xem kênh/Kết nối và log; bot sẽ thử lại."
				: "❌ Không thể lưu hoặc bật chế độ 24/7. Hãy kiểm tra log Botkeep và thử lại.";
			await ctx.reply({ embeds: [infoEmbed(message, COLORS.ERROR)], ephemeral: true });
		}
	}

	async pause(ctx: CommandContext): Promise<void> {
		const player = this.getActivePlayerOrReply(ctx);
		if (!player) return;
		const access = validateMemberVoiceAccess(ctx.member, player);
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}

		if (player.isPaused) {
			await ctx.reply({ embeds: [infoEmbed("⏸️ Nhạc vốn đang tạm dừng rồi!", COLORS.WARNING)], ephemeral: true });
			return;
		}

		player.pause();
		this.engine.scheduleControllerRefresh(player, 150);
		await ctx.reply({ embeds: [infoEmbed("⏸️ Đã tạm dừng phát nhạc.", COLORS.PAUSED)] });
	}

	async resume(ctx: CommandContext): Promise<void> {
		const player = this.getActivePlayerOrReply(ctx);
		if (!player) return;
		const access = validateMemberVoiceAccess(ctx.member, player);
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}

		if (!player.isPaused) {
			await ctx.reply({ embeds: [infoEmbed("▶️ Nhạc vẫn đang phát bình thường!", COLORS.WARNING)], ephemeral: true });
			return;
		}

		player.resume();
		this.engine.scheduleControllerRefresh(player, 150);
		await ctx.reply({ embeds: [infoEmbed("▶️ Đã tiếp tục phát nhạc!", COLORS.PLAYING)] });
	}

	async skip(ctx: CommandContext, toPosition?: number): Promise<void> {
		const player = this.getActivePlayerOrReply(ctx);
		if (!player) return;
		const access = validateMemberVoiceAccess(ctx.member, player);
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}

		const currentTitle = player.currentTrack?.title ?? "bài hiện tại";

		if (toPosition !== undefined && toPosition > 1) {
			if (toPosition > player.queueSize) {
				await ctx.reply({
					embeds: [
						infoEmbed(
							`❌ Vị trí \`#${toPosition}\` không hợp lệ (hàng đợi hiện có \`${player.queueSize}\` bài).`,
							COLORS.ERROR,
						),
					],
					ephemeral: true,
				});
				return;
			}
			const indicesToDrop = Array.from({ length: toPosition - 1 }, (_, i) => i);
			await player.safeCancelPreload().catch(() => undefined);
			player.queue.removeMultiple(indicesToDrop);
		}

		player.skip();
		await ctx.reply({
			embeds: [
				infoEmbed(
					toPosition && toPosition > 1
						? `⏭️ Đã nhảy thẳng tới bài vị trí **#${toPosition}** (bỏ qua **${truncate(currentTitle, 90)}**).`
						: `⏭️ Đã bỏ qua: **${truncate(currentTitle, 110)}**`,
					COLORS.INFO,
				),
			],
		});
	}

	async previous(ctx: CommandContext): Promise<void> {
		const player = this.getActivePlayerOrReply(ctx);
		if (!player) return;
		const access = validateMemberVoiceAccess(ctx.member, player);
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}

		if (player.previousTracks.length === 0) {
			await ctx.reply({
				embeds: [infoEmbed("❌ Chưa có bài hát nào trong lịch sử phát trước đó!", COLORS.WARNING)],
				ephemeral: true,
			});
			return;
		}

		await ctx.defer();
		const ok = await player.previous();
		if (!ok) {
			await ctx.reply({ embeds: [infoEmbed("❌ Không thể quay lại bài trước đó.", COLORS.ERROR)] });
			return;
		}

		await ctx.reply({
			embeds: [infoEmbed(`⏮️ Đã quay lại bài trước: **${truncate(player.currentTrack?.title, 120)}**`, COLORS.PLAYING)],
		});
	}

	async stop(ctx: CommandContext): Promise<void> {
		const player = this.getActivePlayerOrReply(ctx);
		if (!player) return;
		const access = validateMemberVoiceAccess(ctx.member, player);
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}

		player.clearQueue();
		player.stop();
		await ctx.reply({ embeds: [infoEmbed("⏹️ Đã dừng phát nhạc và xóa sạch hàng đợi.", COLORS.INFO)] });
	}

	async leave(ctx: CommandContext): Promise<void> {
		const existing = this.engine.manager.get(ctx.guild.id);
		if (existing && !existing.destroyed) {
			const access = validateMemberVoiceAccess(ctx.member, existing);
			if (!access.ok) {
				await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
				return;
			}
		}

		await ctx.defer();
		// Disable 24/7 under the same per-guild lock used by reconnection, so an
		// in-flight retry cannot immediately bring the bot back after /leave.
		let result: { disabled: boolean; left: boolean };
		try {
			result = await this.engine.leaveVoice(ctx.guild.id);
		} catch (err) {
			console.error("[24/7] Không thể tắt trước khi rời voice:", err instanceof Error ? err.message : err);
			await ctx.reply({ embeds: [infoEmbed("❌ Không thể lưu việc tắt 24/7; bot chưa rời. Hãy kiểm tra log Botkeep.", COLORS.ERROR)], ephemeral: true });
			return;
		}
		const { disabled, left } = result;
		if (!left && !disabled) {
			await ctx.reply({
				embeds: [infoEmbed("❌ Bot hiện không kết nối kênh thoại nào trong Server!", COLORS.ERROR)],
				ephemeral: true,
			});
			return;
		}
		await ctx.reply({
			embeds: [infoEmbed(disabled ? "👋 Đã tắt 24/7 và rời khỏi kênh thoại!" : "👋 Đã ngắt kết nối và rời khỏi kênh thoại!", COLORS.INFO)],
		});
	}

	async nowPlaying(ctx: CommandContext): Promise<void> {
		const player = this.getActivePlayerOrReply(ctx);
		if (!player || !player.currentTrack) {
			await ctx.reply({ embeds: [infoEmbed("❌ Không có bài hát nào đang phát!", COLORS.ERROR)], ephemeral: true });
			return;
		}

		const ud = player.userdata as PlayerUserData | undefined;
		if (ud) ud.textChannelId = ctx.textChannelId;
		await this.engine.sendFreshController(player);
		await ctx.reply({
			embeds: [infoEmbed("🎛️ Đã làm mới bảng điều khiển **Đang phát (Now Playing)** ngay bên dưới!", COLORS.PLAYING)],
			ephemeral: true,
		});
	}

	async queue(ctx: CommandContext, page = 1): Promise<void> {
		const player = this.getActivePlayerOrReply(ctx);
		if (!player) return;

		await ctx.reply({
			embeds: [buildQueueEmbed(player, page)],
		});
	}

	async shuffle(ctx: CommandContext): Promise<void> {
		const player = this.getActivePlayerOrReply(ctx);
		if (!player) return;
		const access = validateMemberVoiceAccess(ctx.member, player);
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}

		if (player.queueSize < 2) {
			await ctx.reply({
				embeds: [infoEmbed("❌ Cần ít nhất 2 bài trong hàng đợi chờ để trộn ngẫu nhiên!", COLORS.WARNING)],
				ephemeral: true,
			});
			return;
		}

		player.shuffle();
		this.engine.scheduleControllerRefresh(player, 200);
		await ctx.reply({
			embeds: [infoEmbed(`🔀 Đã trộn ngẫu nhiên **${player.queueSize}** bài hát trong hàng đợi!`, COLORS.PRIMARY)],
		});
	}

	async loop(ctx: CommandContext, modeInput?: string): Promise<void> {
		const player = this.getActivePlayerOrReply(ctx);
		if (!player) return;
		const access = validateMemberVoiceAccess(ctx.member, player);
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}

		const normalized = (modeInput ?? "").trim().toLowerCase();
		let target: LoopMode;
		if (["off", "0", "none", "tat", "tắt"].includes(normalized)) {
			target = "off";
		} else if (["track", "song", "1", "bai", "bài"].includes(normalized)) {
			target = "track";
		} else if (["queue", "all", "2"].includes(normalized)) {
			target = "queue";
		} else {
			await ctx.reply({
				embeds: [infoEmbed("❌ Chế độ lặp không hợp lệ! Hãy chọn: `off`, `track`, hoặc `queue`.", COLORS.ERROR)],
				ephemeral: true,
			});
			return;
		}

		player.loop(target);
		this.engine.scheduleControllerRefresh(player, 200);
		await ctx.reply({
			embeds: [infoEmbed(`🔁 Đã chuyển chế độ lặp sang: **${formatLoopMode(target)}**`, COLORS.PRIMARY)],
		});
	}

	async autoPlay(ctx: CommandContext): Promise<void> {
		const player = this.getActivePlayerOrReply(ctx);
		if (!player) return;
		const access = validateMemberVoiceAccess(ctx.member, player);
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}

		const next = !player.autoPlay();
		player.autoPlay(next);
		this.engine.scheduleControllerRefresh(player, 200);
		await ctx.reply({
			embeds: [
				infoEmbed(
					`♾️ Tự động phát gợi ý (**Autoplay**): **${next ? "ĐÃ BẬT" : "ĐÃ TẮT"}**${next && this.engine.config.geminiApiKey ? " *(AI Gemini Autoplay đang kích hoạt)*" : ""}`,
					next ? COLORS.PLAYING : COLORS.INFO,
				),
			],
		});
	}

	async seek(ctx: CommandContext, timeStr: string): Promise<void> {
		const player = this.getActivePlayerOrReply(ctx);
		if (!player || !player.currentTrack) return;
		const access = validateMemberVoiceAccess(ctx.member, player);
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}

		if (player.currentTrack.isLive) {
			await ctx.reply({
				embeds: [infoEmbed("❌ Không thể tua thời gian đối với luồng phát trực tiếp (LIVE)!", COLORS.ERROR)],
				ephemeral: true,
			});
			return;
		}

		const ms = parseTimeInput(timeStr);
		if (ms === null) {
			await ctx.reply({
				embeds: [infoEmbed("❌ Định dạng thời gian không hợp lệ! Ví dụ hợp lệ: `1:30`, `90`, `2m15s`.", COLORS.ERROR)],
				ephemeral: true,
			});
			return;
		}

		if (player.currentTrack.duration > 0 && ms >= player.currentTrack.duration) {
			await ctx.reply({
				embeds: [
					infoEmbed(
						`❌ Mốc tua \`${formatDuration(ms)}\` vượt quá độ dài bài hát (\`${formatDuration(player.currentTrack.duration)}\`)!`,
						COLORS.ERROR,
					),
				],
				ephemeral: true,
			});
			return;
		}

		await ctx.defer();
		const ok = await player.seek(ms);
		this.engine.scheduleControllerRefresh(player, 250);
		await ctx.reply({
			embeds: [
				infoEmbed(
					ok ? `⏩ Đã tua bài hát tới mốc **\`${formatDuration(ms)}\`**!` : "❌ Không thể tua bài hát hiện tại.",
					ok ? COLORS.PLAYING : COLORS.ERROR,
				),
			],
		});
	}

	async volume(ctx: CommandContext, level?: number): Promise<void> {
		const player = this.getActivePlayerOrReply(ctx);
		if (!player) return;

		if (level === undefined || Number.isNaN(level)) {
			await ctx.reply({
				embeds: [infoEmbed(`🔊 Âm lượng hiện tại của trình phát là: **\`${player.volume}%\`**`, COLORS.INFO)],
			});
			return;
		}

		const access = validateMemberVoiceAccess(ctx.member, player);
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}

		if (level < 0 || level > 100) {
			await ctx.reply({
				embeds: [infoEmbed("❌ Mức âm lượng phải nằm trong khoảng từ **0** đến **100**!", COLORS.ERROR)],
				ephemeral: true,
			});
			return;
		}

		player.setVolume(level);
		this.engine.scheduleControllerRefresh(player, 200);
		await ctx.reply({
			embeds: [infoEmbed(`🔊 Đã đặt âm lượng trình phát thành **\`${level}%\`**`, COLORS.PLAYING)],
		});
	}

	async move(ctx: CommandContext, fromPos: number, toPos: number): Promise<void> {
		const player = this.getActivePlayerOrReply(ctx);
		if (!player) return;
		const access = validateMemberVoiceAccess(ctx.member, player);
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}

		if (!Number.isInteger(fromPos) || !Number.isInteger(toPos) || fromPos < 1 || toPos < 1) {
			await ctx.reply({
				embeds: [infoEmbed("❌ Vui lòng nhập vị trí số nguyên dương hợp lệ (ví dụ: `!move 3 1`).", COLORS.ERROR)],
				ephemeral: true,
			});
			return;
		}

		const fromIdx = fromPos - 1;
		const toIdx = toPos - 1;
		const target = player.queue.getTrack(fromIdx);
		if (!target || toIdx < 0 || toIdx >= player.queueSize) {
			await ctx.reply({
				embeds: [infoEmbed(`❌ Vị trí di chuyển không hợp lệ (hàng đợi có \`${player.queueSize}\` bài).`, COLORS.ERROR)],
				ephemeral: true,
			});
			return;
		}

		player.queue.move(fromIdx, toIdx);
		this.engine.scheduleControllerRefresh(player, 200);
		await ctx.reply({
			embeds: [
				infoEmbed(
					`↕️ Đã chuyển **${truncate(target.title, 100)}** từ vị trí \`#${fromPos}\` sang \`#${toPos}\`!`,
					COLORS.PRIMARY,
				),
			],
		});
	}

	async swap(ctx: CommandContext, posA: number, posB: number): Promise<void> {
		const player = this.getActivePlayerOrReply(ctx);
		if (!player) return;
		const access = validateMemberVoiceAccess(ctx.member, player);
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}

		if (!Number.isInteger(posA) || !Number.isInteger(posB) || posA < 1 || posB < 1) {
			await ctx.reply({
				embeds: [infoEmbed("❌ Vui lòng nhập 2 vị trí số nguyên dương hợp lệ (ví dụ: `!swap 1 2`).", COLORS.ERROR)],
				ephemeral: true,
			});
			return;
		}

		const idxA = posA - 1;
		const idxB = posB - 1;
		const trackA = player.queue.getTrack(idxA);
		const trackB = player.queue.getTrack(idxB);
		if (!trackA || !trackB) {
			await ctx.reply({
				embeds: [infoEmbed(`❌ Vị trí hoán đổi không hợp lệ (hàng đợi có \`${player.queueSize}\` bài).`, COLORS.ERROR)],
				ephemeral: true,
			});
			return;
		}

		player.queue.swap(idxA, idxB);
		this.engine.scheduleControllerRefresh(player, 200);
		await ctx.reply({
			embeds: [
				infoEmbed(
					`🔄 Đã hoán đổi \`#${posA}\` (**${truncate(trackA.title, 60)}**) ↔ \`#${posB}\` (**${truncate(trackB.title, 60)}**)!`,
					COLORS.PRIMARY,
				),
			],
		});
	}

	async remove(ctx: CommandContext, pos: number): Promise<void> {
		const player = this.getActivePlayerOrReply(ctx);
		if (!player) return;
		const access = validateMemberVoiceAccess(ctx.member, player);
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}

		if (!Number.isInteger(pos) || pos < 1) {
			await ctx.reply({
				embeds: [infoEmbed("❌ Vui lòng nhập số thứ tự bài hát hợp lệ (từ 1 trở lên).", COLORS.ERROR)],
				ephemeral: true,
			});
			return;
		}

		const removed = player.remove(pos - 1);
		if (!removed) {
			await ctx.reply({
				embeds: [infoEmbed(`❌ Không tìm thấy bài hát ở vị trí \`#${pos}\`!`, COLORS.ERROR)],
				ephemeral: true,
			});
			return;
		}

		this.engine.scheduleControllerRefresh(player, 200);
		await ctx.reply({
			embeds: [infoEmbed(`🗑️ Đã xóa khỏi hàng đợi: **${truncate(removed.title, 120)}**`, COLORS.INFO)],
		});
	}

	async clear(ctx: CommandContext): Promise<void> {
		const player = this.getActivePlayerOrReply(ctx);
		if (!player) return;
		const access = validateMemberVoiceAccess(ctx.member, player);
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}

		const count = player.queueSize;
		player.clearQueue();
		this.engine.scheduleControllerRefresh(player, 200);
		await ctx.reply({
			embeds: [infoEmbed(`🧹 Đã dọn sạch **${count}** bài hát đang chờ trong hàng đợi!`, COLORS.INFO)],
		});
	}

	async filter(ctx: CommandContext, action: string, filterName?: string): Promise<void> {
		const act = action.trim().toLowerCase();

		if (act === "list") {
			const grouped = new Map<string, string[]>();
			for (const [key, def] of Object.entries(PREDEFINED_FILTERS)) {
				const cat = def.category ?? "other";
				const arr = grouped.get(cat) ?? [];
				arr.push(`\`${key}\``);
				grouped.set(cat, arr);
			}

			const activePlayer = this.engine.manager.get(ctx.guild.id);
			const activeList = activePlayer?.filter.getActiveFilters().map((f) => `\`${f.name}\``) ?? [];

			const embed = new EmbedBuilder()
				.setColor(COLORS.PRIMARY)
				.setTitle(`🎛️ Danh sách ${Object.keys(PREDEFINED_FILTERS).length} Hiệu ứng Âm thanh FFmpeg`)
				.setDescription(
					activeList.length > 0
						? `**Đang kích hoạt:** ${activeList.join(", ")}`
						: "*Hiện chưa bật hiệu ứng nào. Dùng `/filter apply <tên>` để bật!*",
				);

			for (const [cat, names] of grouped.entries()) {
				embed.addFields({
					name: `📂 Nhóm ${cat.toUpperCase()}`,
					value: names.join(", "),
					inline: false,
				});
			}

			await ctx.reply({ embeds: [embed] });
			return;
		}

		const player = this.getActivePlayerOrReply(ctx);
		if (!player) return;
		const access = validateMemberVoiceAccess(ctx.member, player);
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}

		if (act === "clear" || act === "off" || act === "reset") {
			await ctx.defer();
			await player.filter.clearAll();
			this.engine.scheduleControllerRefresh(player, 200);
			await ctx.reply({
				embeds: [infoEmbed("🧹 Đã tắt toàn bộ bộ lọc và khôi phục âm thanh gốc!", COLORS.PLAYING)],
			});
			return;
		}

		const targetKey = Object.keys(PREDEFINED_FILTERS).find(
			(k) => k.toLowerCase() === (filterName ?? "").trim().toLowerCase(),
		);
		if (!targetKey) {
			await ctx.reply({
				embeds: [
					infoEmbed(
						`❌ Hiệu ứng \`${truncate(filterName || "", 40)}\` không tồn tại! Gõ \`/filter list\` để xem đủ 36 hiệu ứng.`,
						COLORS.ERROR,
					),
				],
				ephemeral: true,
			});
			return;
		}

		await ctx.defer();

		if (act === "remove") {
			if (!player.filter.hasFilter(targetKey)) {
				await ctx.reply({
					embeds: [infoEmbed(`ℹ️ Hiệu ứng \`${targetKey}\` hiện không được bật.`, COLORS.WARNING)],
				});
				return;
			}
			await player.filter.removeFilter(targetKey);
			this.engine.scheduleControllerRefresh(player, 200);
			await ctx.reply({
				embeds: [infoEmbed(`➖ Đã gỡ hiệu ứng **\`${targetKey}\`**!`, COLORS.INFO)],
			});
			return;
		}

		// Default: apply (or toggle if already active)
		const def = PREDEFINED_FILTERS[targetKey];
		await player.filter.applyFilter(targetKey);
		this.engine.scheduleControllerRefresh(player, 200);
		await ctx.reply({
			embeds: [
				infoEmbed(
					`🎛️ Đã kích hoạt hiệu ứng **\`${def.name}\`** (*${def.description}*)\nĐang bật: ${player.filter
						.getActiveFilters()
						.map((f) => `\`${f.name}\``)
						.join(", ")}`,
					COLORS.PLAYING,
				),
			],
		});
	}

	async lyrics(ctx: CommandContext, mode = "show"): Promise<void> {
		const player = this.getActivePlayerOrReply(ctx);
		if (!player || !player.currentTrack) return;

		const ud = player.userdata as PlayerUserData;
		const normalizedMode = mode.trim().toLowerCase();

		if (normalizedMode === "live") {
			ud.liveLyricsEnabled = !ud.liveLyricsEnabled;
			ud.textChannelId = ctx.textChannelId;
			this.engine.scheduleControllerRefresh(player, 200);
			await ctx.reply({
				embeds: [
					infoEmbed(
						ud.liveLyricsEnabled
							? "🎤 Đã **BẬT** chế độ **Karaoke Live**! Lời bài hát đồng bộ sẽ tự động nhảy theo câu nhạc."
							: "🔇 Đã **TẮT** chế độ **Karaoke Live**.",
						ud.liveLyricsEnabled ? COLORS.LYRICS : COLORS.INFO,
					),
				],
			});
			return;
		}

		await ctx.defer();
		const track = player.currentTrack;
		let result = ud.lyricsTrackId === (track.id || track.url) ? ud.cachedLyrics : null;

		if (!result && ud.lyricsExtInstance) {
			result = await ud.lyricsExtInstance.fetch(track).catch(() => null);
			if (result) {
				ud.cachedLyrics = result;
				ud.lyricsTrackId = track.id || track.url;
			}
		}

		if (!result || (!result.text && !result.synced)) {
			await ctx.reply({
				embeds: [
					infoEmbed(
						`❌ Không tìm thấy lời bài hát cho **${truncate(track.title, 120)}** trên LRCLIB / Lyrics.ovh.`,
						COLORS.WARNING,
					),
				],
			});
			return;
		}

		await ctx.reply({
			embeds: [buildFullLyricsEmbed(track, result)],
		});
	}

	async save(ctx: CommandContext, filterName?: string): Promise<void> {
		const player = this.getActivePlayerOrReply(ctx);
		if (!player || !player.currentTrack) return;

		let resolvedFilter: string | undefined;
		if (filterName && filterName.trim()) {
			resolvedFilter = Object.keys(PREDEFINED_FILTERS).find(
				(k) => k.toLowerCase() === filterName.trim().toLowerCase(),
			);
			if (!resolvedFilter) {
				await ctx.reply({
					embeds: [infoEmbed(`❌ Hiệu ứng \`${truncate(filterName, 40)}\` không hợp lệ!`, COLORS.ERROR)],
					ephemeral: true,
				});
				return;
			}
		}

		await ctx.defer();

		try {
			const track = player.currentTrack;
			const mp3Buffer = await exportTrackToMp3Buffer(player, track, {
				ffmpegPath: this.engine.config.ffmpegPath,
				filterName: resolvedFilter,
				maxDurationSec: this.engine.config.maxSaveDurationSec,
			});

			const filename = sanitizeFilename(
				resolvedFilter ? `${track.title}_${resolvedFilter}` : track.title,
			);
			const attachment = new AttachmentBuilder(mp3Buffer, { name: filename });

			await ctx.reply({
				embeds: [
					infoEmbed(
						`💾 Đã xuất thành công **${truncate(track.title, 110)}**${resolvedFilter ? ` *(Filter: \`${resolvedFilter}\`)*` : ""} — \`${(mp3Buffer.length / 1024 / 1024).toFixed(2)} MB\``,
						COLORS.PLAYING,
					),
				],
				files: [attachment],
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await ctx.reply({
				embeds: [infoEmbed(`❌ Không thể xuất file MP3: ${truncate(message, 180)}`, COLORS.ERROR)],
			});
		}
	}

	async mirror(ctx: CommandContext, leaderGuildIdOrOff: string): Promise<void> {
		const input = leaderGuildIdOrOff.trim();
		const access = validateMemberVoiceAccess(ctx.member, this.engine.manager.get(ctx.guild.id));
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}

		if (input.toLowerCase() === "off" || input.toLowerCase() === "stop") {
			const follower = this.engine.manager.get(ctx.guild.id);
			if (!follower || !follower.forwardLeader) {
				await ctx.reply({
					embeds: [infoEmbed("ℹ️ Server này hiện không đồng bộ (Mirror) từ Server nào.", COLORS.WARNING)],
					ephemeral: true,
				});
				return;
			}
			follower.unsubscribeForward("User stopped mirror");
			await ctx.reply({
				embeds: [infoEmbed("🔌 Đã ngắt chế độ đồng bộ luồng nhạc (Forward Mirror)!", COLORS.INFO)],
			});
			return;
		}

		if (input === ctx.guild.id) {
			await ctx.reply({
				embeds: [infoEmbed("❌ Không thể tự Mirror chính Server hiện tại!", COLORS.ERROR)],
				ephemeral: true,
			});
			return;
		}

		const leader = this.engine.manager.get(input);
		if (!leader || leader.destroyed || !leader.connection) {
			await ctx.reply({
				embeds: [
					infoEmbed(
						`❌ Không tìm thấy trình phát đang hoạt động ở Server chính có ID \`${truncate(input, 30)}\`!`,
						COLORS.ERROR,
					),
				],
				ephemeral: true,
			});
			return;
		}

		await ctx.defer();
		const follower = await this.engine.getOrCreatePlayer({
			guildId: ctx.guild.id,
			voiceChannelId: access.voiceChannel.id,
			textChannelId: ctx.textChannelId,
		});
		await this.engine.ensureConnected(follower, access.voiceChannel);

		const ok = follower.subscribeTo(leader, { forwardMode: true });
		await ctx.reply({
			embeds: [
				infoEmbed(
					ok
						? `📡 Đã đồng bộ luồng âm thanh trực tiếp từ Server \`${leader.guildId}\` sang <#${access.voiceChannel.id}>!`
						: "❌ Không thể thiết lập đồng bộ luồng âm thanh.",
					ok ? COLORS.PLAYING : COLORS.ERROR,
				),
			],
		});
	}

	async stats(ctx: CommandContext): Promise<void> {
		await ctx.reply({
			embeds: [buildStatsEmbed(this.engine.manager, this.engine.client)],
		});
	}

	async help(ctx: CommandContext): Promise<void> {
		await ctx.reply({
			embeds: [buildHelpEmbed(this.engine.config.prefix)],
		});
	}
}

export function toMessageOptions(payload: ReplyPayload): string | MessagePayload | MessageCreateOptions {
	return {
		content: payload.content,
		embeds: payload.embeds,
		files: payload.files,
	};
}
