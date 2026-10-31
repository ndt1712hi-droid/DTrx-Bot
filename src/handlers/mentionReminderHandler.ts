import { randomUUID } from "node:crypto";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	MessageFlags,
	PermissionFlagsBits,
	type ButtonInteraction,
	type Client,
	type Guild,
	type GuildMember,
	type NewsChannel,
	type TextChannel,
} from "discord.js";
import {
	DEFAULT_INTERVAL_SECONDS,
	DEFAULT_REMINDER_TEXT,
	MAX_INTERVAL_SECONDS,
	MAX_REMINDER_TEXT,
	MAX_REMINDERS_PER_RUN,
	MAX_TRACKED_REMINDER_MESSAGES,
	MIN_INTERVAL_SECONDS,
	MentionReminderStore,
	type MentionReminderConfig,
	type ReminderMessageRef,
} from "../core/mentionReminderStore.js";
import type { CommandContext } from "./musicActions.js";

type TargetChannel = TextChannel | NewsChannel;
type Mode = "set" | "on" | "off" | "delete" | "clear" | "status";
type Schedule = (task: () => void | Promise<void>, milliseconds: number) => () => void;
export interface MentionReminderInput { targetId?: string; channelId?: string; intervalSeconds?: number; count?: number; text?: string }

const MAX_CONCURRENT_GUILDS = 4;
const BUTTON_PREFIX = "tagremind:";

const defaultSchedule: Schedule = (task, milliseconds) => {
	const handle = setTimeout(() => { void Promise.resolve().then(task).catch((err) => console.warn("[MentionReminder] Lỗi bộ hẹn giờ:", err instanceof Error ? err.message : err)); }, milliseconds);
	handle.unref();
	return () => clearTimeout(handle);
};
interface ActiveRun {
	token: string;
	guild: Guild;
	config: MentionReminderConfig;
	requesterId: string;
	sent: number;
	cancelled: boolean;
	cancelTimer?: () => void;
	inFlight?: Promise<void>;
}

function buttonRow(token: string): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}stop:${token}`).setLabel("Dừng tag").setStyle(ButtonStyle.Danger),
	);
}
function isUnknownMessage(err: unknown): boolean {
	return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === 10008);
}
function isUnknownChannel(err: unknown): boolean {
	return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === 10003);
}

/** One bounded reminder run per guild; nothing resumes after a restart. */
export class MentionReminderService {
	private readonly active = new Map<string, ActiveRun>();
	private readonly reserved = new Set<string>();
	private readonly lastSent = new Map<string, number>();
	private readonly queues = new Map<string, Promise<unknown>>();
	private closed = false;

	constructor(private readonly client: Client, private readonly store: MentionReminderStore, private readonly schedule: Schedule = defaultSchedule) {}

	async close(): Promise<void> {
		this.closed = true;
		for (const run of this.active.values()) { run.cancelled = true; run.cancelTimer?.(); }
		await Promise.allSettled([...this.active.values()].map((run) => run.inFlight).filter((work): work is Promise<void> => Boolean(work)));
		this.active.clear();
		await Promise.allSettled([...this.queues.values()]);
		// An in-flight command may have completed while shutdown was draining queues.
		for (const run of this.active.values()) { run.cancelled = true; run.cancelTimer?.(); }
		this.active.clear();
		this.reserved.clear();
		await this.store.flush();
	}

	private queue<T>(guildId: string, work: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(guildId) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(work);
		this.queues.set(guildId, current);
		return current.finally(() => { if (this.queues.get(guildId) === current) this.queues.delete(guildId); });
	}

	async manage(ctx: CommandContext, mode: Mode, input: MentionReminderInput = {}): Promise<void> {
		if (this.closed) { await ctx.reply({ content: "❌ Chức năng nhắc tag đang đóng.", ephemeral: true }); return; }
		// Queue before any network fetch so a later /off cannot overtake a slow /on.
		await this.queue(ctx.guild.id, async () => {
			if (this.closed) { await ctx.reply({ content: "❌ Chức năng nhắc tag đang đóng.", ephemeral: true }); return; }
			const caller = await ctx.guild.members.fetch({ user: ctx.userId, force: true }).catch(() => null);
			if (!caller || (ctx.guild.ownerId !== ctx.userId && !caller.permissions.has(PermissionFlagsBits.ManageGuild))) {
				await ctx.reply({ content: "❌ Bạn cần quyền **Quản lý máy chủ (Manage Server)** để quản lý nhắc tag.", ephemeral: true });
				return;
			}
			try {
				if (mode === "set") await this.configure(ctx, caller, input);
				else if (mode === "on") await this.startRun(ctx, caller);
				else if (mode === "off") {
					const stopped = await this.stop(ctx.guild.id);
					await ctx.reply({ content: stopped ? "🛑 Đã dừng nhắc tag; cấu hình vẫn được giữ." : "ℹ️ Hiện không có đợt tag đang chạy.", ephemeral: true });
				} else if (mode === "delete") {
					await this.stop(ctx.guild.id);
					const removed = await this.store.deleteConfig(ctx.guild.id);
					await ctx.reply({ content: removed ? "🗑️ Đã dừng và xóa cấu hình tag. Tin cũ vẫn được giữ; dùng `/spam clear` nếu muốn dọn tin bot." : "ℹ️ Chưa có cấu hình tag để xóa.", ephemeral: true });
				} else if (mode === "clear") {
					await this.stop(ctx.guild.id);
					await this.clearMessages(ctx, caller);
				} else if (mode === "status") {
					const record = await this.store.get(ctx.guild.id);
					const c = record?.config;
					const state = this.active.has(ctx.guild.id) ? "Đang chạy" : "Đang dừng";
					const detail = c ? `**Người nhận ID:** \`${c.targetId}\`\n**Kênh:** <#${c.channelId}>\n**Khoảng cách:** ${c.intervalSeconds} giây\n**Tối đa:** ${c.count} lần mỗi đợt` : "Chưa có cấu hình. Dùng `/spam set`.";
					await ctx.reply({ content: `**Nhắc tag:** ${state}\n${detail}\n**Tin bot có thể dọn:** ${record?.messages.length ?? 0}`, ephemeral: true });
				}
			} catch (err) {
				console.warn(`[MentionReminder] Không xử lý được ${mode} cho server ${ctx.guild.id}:`, err instanceof Error ? err.message : err);
				await ctx.reply({ content: "❌ Không thể xử lý nhắc tag. Kiểm tra quyền kênh, dữ liệu và log [MentionReminder].", ephemeral: true });
			}
		});
	}

	private async channelFor(guild: Guild, channelId: string): Promise<TargetChannel | null> {
		const channel = await guild.channels.fetch(channelId, { force: true }).catch(() => null);
		if (!channel || channel.guildId !== guild.id || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) return null;
		return channel as TargetChannel;
	}

	private async validateTarget(guild: Guild, caller: GuildMember, config: MentionReminderConfig): Promise<{ channel: TargetChannel } | { error: string }> {
		const channel = await this.channelFor(guild, config.channelId);
		if (!channel) return { error: "❌ Hãy chọn một kênh chữ hoặc kênh thông báo trong server này." };
		if (!channel.permissionsFor(caller)?.has(PermissionFlagsBits.ViewChannel)) return { error: "❌ Bạn không có quyền xem kênh đã chọn." };
		const [target, bot] = await Promise.all([
			guild.members.fetch({ user: config.targetId, force: true }).catch(() => null),
			guild.members.fetchMe({ force: true }).catch(() => null),
		]);
		if (!target || target.user.bot) return { error: "❌ Hãy chọn một thành viên thật đang có mặt trong server." };
		if (!channel.permissionsFor(target)?.has(PermissionFlagsBits.ViewChannel)) return { error: "❌ Người được chọn không xem được kênh để nhận tin và dùng nút dừng." };
		if (!bot || !channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
			return { error: "❌ Bot cần quyền **Xem kênh** và **Gửi tin nhắn** trong kênh đã chọn." };
		}
		return { channel };
	}

	private async configure(ctx: CommandContext, caller: GuildMember, input: MentionReminderInput): Promise<void> {
		const intervalSeconds = input.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
		const count = input.count ?? MAX_REMINDERS_PER_RUN;
		const text = input.text?.trim() || DEFAULT_REMINDER_TEXT;
		if (!input.targetId || !Number.isInteger(intervalSeconds) || intervalSeconds < MIN_INTERVAL_SECONDS || intervalSeconds > MAX_INTERVAL_SECONDS ||
			!Number.isInteger(count) || count < 1 || count > MAX_REMINDERS_PER_RUN || text.length > MAX_REMINDER_TEXT) {
			await ctx.reply({ content: `❌ Chọn một người; khoảng cách ${MIN_INTERVAL_SECONDS}–${MAX_INTERVAL_SECONDS} giây, số lượt 1–${MAX_REMINDERS_PER_RUN} và nội dung tối đa ${MAX_REMINDER_TEXT} ký tự.`, ephemeral: true });
			return;
		}
		const config: MentionReminderConfig = { guildId: ctx.guild.id, channelId: input.channelId || ctx.textChannelId, targetId: input.targetId, intervalSeconds, count, text };
		const validated = await this.validateTarget(ctx.guild, caller, config);
		if ("error" in validated) { await ctx.reply({ content: validated.error, ephemeral: true }); return; }
		await this.stop(ctx.guild.id);
		await this.store.setConfig(config);
		await ctx.reply({ content: `✅ Đã lưu người nhận và kênh <#${config.channelId}>: ${config.intervalSeconds} giây/lần, tối đa ${config.count} lần. Dùng \`/spam on\` để bắt đầu; chưa gửi tag nào.`, ephemeral: true });
	}

	private async startRun(ctx: CommandContext, caller: GuildMember): Promise<void> {
		const record = await this.store.get(ctx.guild.id);
		if (!record?.config) { await ctx.reply({ content: "❌ Chưa có cấu hình. Dùng `/spam set` trước.", ephemeral: true }); return; }
		// Older releases allowed intervals above the current maximum. Preserve those records,
		// but require an explicit /set rather than silently making their reminders much faster.
		if (record.config.intervalSeconds < MIN_INTERVAL_SECONDS || record.config.intervalSeconds > MAX_INTERVAL_SECONDS) {
			await ctx.reply({ content: `⚠️ Khoảng cách đã lưu không còn hợp lệ. Dùng \`/spam set\` đặt lại từ ${MIN_INTERVAL_SECONDS} đến ${MAX_INTERVAL_SECONDS} giây.`, ephemeral: true }); return;
		}
		if (this.active.has(ctx.guild.id)) {
			await ctx.reply({ content: "ℹ️ Đợt tag đang chạy. Dùng `/spam off` để dừng.", ephemeral: true }); return;
		}
		// Reserve before channel/member fetches so concurrent servers cannot exceed the shared cap.
		if (this.active.size + this.reserved.size >= MAX_CONCURRENT_GUILDS) {
			await ctx.reply({ content: "⚠️ Bot đang xử lý đủ số đợt nhắc tag; hãy thử lại sau.", ephemeral: true }); return;
		}
		if (record.messages.length + record.config.count > MAX_TRACKED_REMINDER_MESSAGES) {
			await ctx.reply({ content: "⚠️ Danh sách tin bot đã đầy; dùng `/spam clear` trước khi bắt đầu đợt mới.", ephemeral: true }); return;
		}
		this.reserved.add(ctx.guild.id);
		try {
			const validated = await this.validateTarget(ctx.guild, caller, record.config);
			if ("error" in validated) { await ctx.reply({ content: validated.error, ephemeral: true }); return; }
			if (this.closed) { await ctx.reply({ content: "❌ Chức năng nhắc tag đang đóng.", ephemeral: true }); return; }
			const run: ActiveRun = {
				token: randomUUID(), guild: ctx.guild, config: { ...record.config }, requesterId: ctx.userId,
				sent: 0, cancelled: false,
			};
			const previousSend = this.lastSent.get(ctx.guild.id) ?? 0;
			const delay = Math.max(0, MIN_INTERVAL_SECONDS * 1000 - (Date.now() - previousSend));
			// Transfer the reservation to an active slot without an await between the two operations.
			this.reserved.delete(ctx.guild.id);
			this.active.set(ctx.guild.id, run);
			try {
				this.scheduleTick(run, delay);
				await ctx.reply({ content: `✅ Đã bắt đầu tag trong <#${run.config.channelId}>: tối đa ${run.config.count} lần, cách nhau ${run.config.intervalSeconds} giây. Dùng \`/spam off\` hoặc nút **Dừng tag** để dừng.`, ephemeral: true });
			} catch (err) {
				await this.stop(ctx.guild.id);
				throw err;
			}
		} finally {
			this.reserved.delete(ctx.guild.id);
		}
	}

	async handleButton(interaction: ButtonInteraction): Promise<void> {
		const guildId = interaction.guildId;
		const match = /^tagremind:(yes|no|stop):([a-f0-9-]{36})$/.exec(interaction.customId);
		if (!guildId || !match || this.closed || match[1] !== "stop") {
			// Old consent buttons from previous releases are deliberately inert after an upgrade.
			await interaction.reply({ content: "ℹ️ Nút này đã hết hiệu lực.", flags: MessageFlags.Ephemeral }); return;
		}
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		await this.queue(guildId, async () => {
			const run = this.active.get(guildId);
			if (!run || run.token !== match[2]) { await interaction.editReply({ content: "ℹ️ Đợt tag này đã dừng." }); return; }
			if (interaction.user.id !== run.config.targetId && interaction.user.id !== run.requesterId && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
				await interaction.editReply({ content: "❌ Chỉ người nhận, người bắt đầu hoặc quản trị viên có thể dừng đợt này." }); return;
			}
			await this.stop(guildId);
			await interaction.editReply({ content: "🛑 Đã dừng tag." });
		});
	}

	private scheduleTick(run: ActiveRun, delayMs: number): void {
		run.cancelTimer = this.schedule(() => this.tick(run), delayMs);
	}
	private isRunning(run: ActiveRun): boolean { return !this.closed && !run.cancelled && this.active.get(run.guild.id) === run; }

	private async tick(run: ActiveRun): Promise<void> {
		run.cancelTimer = undefined;
		if (!this.isRunning(run)) return;
		const work = this.sendOne(run);
		run.inFlight = work;
		try { await work; } finally { if (run.inFlight === work) run.inFlight = undefined; }
	}

	private async sendOne(run: ActiveRun): Promise<void> {
		try {
			const channel = await this.channelFor(run.guild, run.config.channelId);
			if (!this.isRunning(run)) return;
			if (!channel) throw new Error("Không tìm thấy kênh gửi");
			const message = await channel.send({
				content: `<@${run.config.targetId}> ${run.config.text}`,
				allowedMentions: { parse: [], users: [run.config.targetId], repliedUser: false },
				components: [buttonRow(run.token)],
			});
			const now = Date.now();
			for (const [id, sentAt] of this.lastSent) if (now - sentAt >= MIN_INTERVAL_SECONDS * 1000) this.lastSent.delete(id);
			this.lastSent.set(run.guild.id, now);
			try { await this.store.addMessage(run.guild.id, { channelId: run.config.channelId, messageId: message.id }); }
			catch (err) { await message.delete().catch(() => undefined); throw err; }
			run.sent++;
			if (!this.isRunning(run)) return;
			if (run.sent >= run.config.count) { this.active.delete(run.guild.id); return; }
			this.scheduleTick(run, run.config.intervalSeconds * 1000);
		} catch (err) {
			console.warn(`[MentionReminder] Dừng đợt tag ở server ${run.guild.id}:`, err instanceof Error ? err.message : err);
			run.cancelled = true; run.cancelTimer?.();
			if (this.active.get(run.guild.id) === run) this.active.delete(run.guild.id);
		}
	}

	private async stop(guildId: string): Promise<boolean> {
		let changed = false;
		const run = this.active.get(guildId);
		if (run) {
			run.cancelled = true; run.cancelTimer?.();
			if (run.inFlight) await run.inFlight.catch(() => undefined);
			if (this.active.get(guildId) === run) this.active.delete(guildId);
			changed = true;
		}
		return changed;
	}

	private async clearMessages(ctx: CommandContext, caller: GuildMember): Promise<void> {
		const record = await this.store.get(ctx.guild.id);
		if (!record?.messages.length) { await ctx.reply({ content: "ℹ️ Không có tin bot đã lưu để dọn.", ephemeral: true }); return; }
		const removed: ReminderMessageRef[] = [];
		let failed = 0;
		for (const ref of record.messages) {
			let channel: TargetChannel | null;
			try {
				const found = await ctx.guild.channels.fetch(ref.channelId, { force: true });
				channel = found && found.guildId === ctx.guild.id && (found.type === ChannelType.GuildText || found.type === ChannelType.GuildAnnouncement) ? found as TargetChannel : null;
			} catch (err) {
				if (isUnknownChannel(err)) { removed.push(ref); continue; }
				failed++; continue;
			}
			if (!channel || !channel.permissionsFor(caller)?.has(PermissionFlagsBits.ViewChannel)) { failed++; continue; }
			let message;
			try { message = await channel.messages.fetch({ message: ref.messageId, force: true }); }
			catch (err) { if (isUnknownMessage(err)) removed.push(ref); else failed++; continue; }
			if (!this.client.user?.id || message.author.id !== this.client.user.id) { failed++; continue; }
			try { await message.delete(); removed.push(ref); }
			catch (err) { if (isUnknownMessage(err)) removed.push(ref); else failed++; }
		}
		await this.store.removeMessages(ctx.guild.id, removed);
		const warning = failed ? ` Còn ${failed} tin chưa dọn được; kiểm tra quyền xem kênh của bạn và quyền **Xem kênh**, **Đọc lịch sử tin nhắn** của bot rồi thử lại.` : "";
		await ctx.reply({ content: `🧹 Đã dọn ${removed.length} tin do chức năng tag ghi nhận.${warning}`, ephemeral: true });
	}
}

export function isMentionReminderButton(customId: string): boolean { return customId.startsWith(BUTTON_PREFIX); }
