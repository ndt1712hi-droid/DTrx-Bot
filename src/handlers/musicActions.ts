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
	parseTimeInput,
	sanitizeFilename,
	truncate,
} from "../utils/format.js";

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
		const effectiveQuery = (attachmentUrl || query || "").trim();
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

		await ctx.defer();

		try {
			const player = await this.engine.getOrCreatePlayer({
				guildId: ctx.guild.id,
				voiceChannelId: access.voiceChannel.id,
				textChannelId: ctx.textChannelId,
			});

			await this.engine.ensureConnected(player, access.voiceChannel);

			const wasAlreadyPlaying = Boolean(player.currentTrack && (player.isPlaying || player.isPaused));
			const beforeSize = player.queueSize;

			const ok = await player.play(effectiveQuery, ctx.userId);
			if (!ok) {
				await ctx.reply({
					embeds: [infoEmbed(`❌ Không tìm thấy kết quả phù hợp cho: \`${truncate(effectiveQuery, 120)}\``, COLORS.ERROR)],
				});
				return;
			}

			const addedCount = Math.max(0, player.queueSize - beforeSize);
			if (wasAlreadyPlaying && addedCount > 1) {
				await ctx.reply({
					embeds: [
						infoEmbed(
							`✅ Đã thêm **${addedCount}** bài hát từ \`${truncate(effectiveQuery, 100)}\` vào hàng đợi!`,
							COLORS.PLAYING,
						),
					],
				});
			} else if (wasAlreadyPlaying) {
				const last = player.queue.lastTrack;
				await ctx.reply({
					embeds: [
						infoEmbed(
							`✅ Đã thêm vào hàng đợi (#${player.queueSize}): **${truncate(last?.title || effectiveQuery, 120)}** \`[${formatDuration(last?.duration, last?.isLive)}]\``,
							COLORS.PLAYING,
						),
					],
				});
			} else {
				const current = player.currentTrack;
				await ctx.reply({
					embeds: [
						infoEmbed(
							`🎶 Đang tải & phát: **${truncate(current?.title || effectiveQuery, 140)}** tại <#${access.voiceChannel.id}>`,
							COLORS.PLAYING,
						),
					],
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
		const trimmed = query.trim();
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

		await ctx.defer();
		const player = await this.engine.getOrCreatePlayer({
			guildId: ctx.guild.id,
			voiceChannelId: access.voiceChannel.id,
			textChannelId: ctx.textChannelId,
		});
		await this.engine.ensureConnected(player, access.voiceChannel);

		const ttsResult = await this.engine.ttsPlugin.search(`tts:${cleaned}`, ctx.userId);
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
		const player = this.engine.manager.get(ctx.guild.id);
		if (!player || player.destroyed) {
			await ctx.reply({
				embeds: [infoEmbed("❌ Bot hiện không kết nối kênh thoại nào trong Server!", COLORS.ERROR)],
				ephemeral: true,
			});
			return;
		}

		const access = validateMemberVoiceAccess(ctx.member, player);
		if (!access.ok) {
			await ctx.reply({ embeds: [infoEmbed(access.reason, COLORS.ERROR)], ephemeral: true });
			return;
		}

		player.destroy();
		await ctx.reply({ embeds: [infoEmbed("👋 Đã ngắt kết nối và rời khỏi kênh thoại!", COLORS.INFO)] });
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
