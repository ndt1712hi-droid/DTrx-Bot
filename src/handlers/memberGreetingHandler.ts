import { ChannelType, Events, PermissionFlagsBits, escapeMarkdown, type Client, type GuildMember, type PartialGuildMember } from "discord.js";
import { BannerInputError, MAX_BANNER_UPLOAD_BYTES, fetchDiscordBannerAttachment, normalizeBannerBackground, renderMemberBanner, type MemberBannerData } from "../core/memberBanner.js";
import { MemberBannerStore } from "../core/memberBannerStore.js";
import { MemberGreetingStore, type GreetingKind, type GreetingSetting } from "../core/memberGreetingStore.js";
import { truncate } from "../utils/format.js";
import type { CommandContext } from "./musicActions.js";

type Member = GuildMember | PartialGuildMember;
export type GreetingDelivery = "banner" | "text-only" | "not-enabled" | "unavailable";
export interface BannerAttachment { url: string; size: number }
const MAX_PENDING = 32;
const DUPLICATE_WINDOW_MS = 10_000;

/** A bounded, single-worker queue protects music playback during join bursts. */
export class GreetingWorkQueue {
	private tail: Promise<unknown> = Promise.resolve();
	private pending = 0;
	constructor(private readonly limit = MAX_PENDING) {}

	tryRun<T>(work: () => Promise<T>): Promise<T> | null {
		if (this.pending >= this.limit) return null;
		this.pending++;
		const result = this.tail.then(work);
		this.tail = result.catch(() => undefined);
		return result.finally(() => { this.pending--; });
	}
}

function memberName(member: Member): string {
	return member.displayName || member.user?.globalName || member.user?.username || "Thành viên";
}

/** Only the joining member may be mentioned; custom text never pings roles or everyone. */
export function formatGreeting(setting: GreetingSetting, member: Member, preview = false) {
	const name = memberName(member);
	const server = member.guild.name || "máy chủ";
	const mention = setting.kind === "welcome" ? `<@${member.id}>` : name;
	const count = typeof member.guild.memberCount === "number" ? String(member.guild.memberCount) : "?";
	const replacements: Record<string, string> = { user: mention, name, server, count };
	const content = setting.message.replace(/\{(user|name|server|count)\}/gi, (_match, key: string) => replacements[key.toLowerCase()]);
	return {
		content: truncate(content, 1900),
		allowedMentions: {
			parse: [] as [],
			users: setting.kind === "welcome" && !preview && /\{user\}/i.test(setting.message) ? [member.id] : [],
			repliedUser: false,
		},
	};
}

function bannerData(kind: GreetingKind, member: Member): MemberBannerData {
	let avatarUrl: string | undefined;
	try { avatarUrl = member.displayAvatarURL({ extension: "png", size: 256, forceStatic: true }); }
	catch { avatarUrl = undefined; }
	return {
		kind,
		displayName: memberName(member),
		serverName: member.guild.name || "máy chủ",
		memberCount: member.guild.memberCount,
		avatarUrl,
	};
}

/** Handles member events and test sends; failures fall back to a text message. */
export class MemberGreetingService {
	private readonly work = new GreetingWorkQueue();
	private readonly lastEvents = new Map<string, number>();
	private closed = false;

	constructor(
		private readonly client: Client,
		private readonly store: MemberGreetingStore,
		private readonly hasMemberIntent: boolean,
		private readonly render: (data: MemberBannerData) => Promise<Buffer> = renderMemberBanner,
		private readonly backgrounds?: MemberBannerStore,
	) {}

	register(): void {
		if (!this.hasMemberIntent) return;
		this.client.on(Events.GuildMemberAdd, (member) => { void this.handleEvent("welcome", member); });
		this.client.on(Events.GuildMemberRemove, (member) => { void this.handleEvent("goodbye", member); });
	}

	close(): void { this.closed = true; }

	async handleEvent(kind: GreetingKind, member: Member): Promise<void> {
		if (this.closed || !this.hasMemberIntent || !member.guild?.id || !member.id) return;
		if (!this.acceptEvent(kind, member)) return;
		try {
			const setting = await this.store.get(member.guild.id, kind);
			if (!setting?.enabled) return;
			const queued = this.work.tryRun(() => this.deliver(kind, member, false, true));
			if (queued) await queued;
			else {
				console.warn(`[Greeting] Hàng đợi banner đầy trong server ${member.guild.id}; gửi văn bản thay thế.`);
				await this.deliver(kind, member, false, false);
			}
		} catch (err) {
			console.warn(`[Greeting] Không gửi được ${kind} trong server ${member.guild.id}:`, err instanceof Error ? err.message : err);
		}
	}

	async sendTest(kind: GreetingKind, member: Member): Promise<GreetingDelivery> {
		if (this.closed) return "unavailable";
		const queued = this.work.tryRun(() => this.deliver(kind, member, true, true));
		return queued ? queued : this.deliver(kind, member, true, false);
	}

	async setBackground(guildId: string, kind: GreetingKind, attachment: BannerAttachment | null | undefined): Promise<void> {
		if (!this.backgrounds) throw new Error("Không có kho ảnh nền");
		if (!attachment || !Number.isSafeInteger(attachment.size) || attachment.size <= 0 || attachment.size > MAX_BANNER_UPLOAD_BYTES) {
			throw new BannerInputError("Hãy tải ảnh JPG, PNG hoặc WebP không quá 3 MB.");
		}
		const work = this.work.tryRun(async () => {
			if (this.closed) throw new Error("Dịch vụ banner đang đóng");
			const source = await fetchDiscordBannerAttachment(attachment.url);
			if (!source) throw new BannerInputError("Không tải được ảnh từ Discord. Hãy tải lại ảnh JPG, PNG hoặc WebP không quá 3 MB.");
			const normalized = await normalizeBannerBackground(source);
			if (this.closed) throw new Error("Dịch vụ banner đang đóng");
			await this.backgrounds!.set(guildId, kind, normalized);
		});
		if (!work) throw new BannerInputError("Bot đang xử lý quá nhiều banner; hãy thử lại sau.");
		await work;
	}

	async resetBackground(guildId: string, kind: GreetingKind): Promise<boolean> {
		if (!this.backgrounds) throw new Error("Không có kho ảnh nền");
		const work = this.work.tryRun(async () => {
			if (this.closed) throw new Error("Dịch vụ banner đang đóng");
			return this.backgrounds!.reset(guildId, kind);
		});
		if (!work) throw new BannerInputError("Bot đang xử lý quá nhiều banner; hãy thử lại sau.");
		return work;
	}

	async hasBackground(guildId: string, kind: GreetingKind): Promise<boolean> {
		return this.backgrounds ? this.backgrounds.has(guildId, kind) : false;
	}

	private acceptEvent(kind: GreetingKind, member: Member): boolean {
		const now = Date.now();
		for (const [key, time] of this.lastEvents) if (now - time > DUPLICATE_WINDOW_MS) this.lastEvents.delete(key);
		const base = `${member.guild.id}:${member.id}`;
		const key = `${base}:${kind}`;
		const previous = this.lastEvents.get(key);
		if (previous !== undefined && now - previous < DUPLICATE_WINDOW_MS) return false;
		this.lastEvents.delete(`${base}:${kind === "welcome" ? "goodbye" : "welcome"}`);
		// Bound memory even if a server has an unusually large burst of events.
		if (this.lastEvents.size >= 2048) {
			const oldest = this.lastEvents.keys().next().value as string | undefined;
			if (oldest) this.lastEvents.delete(oldest);
		}
		this.lastEvents.set(key, now);
		return true;
	}

	private async deliver(kind: GreetingKind, member: Member, preview: boolean, wantBanner: boolean): Promise<GreetingDelivery> {
		if (this.closed) return "unavailable";
		// Re-read after waiting in the queue so disabling or changing the channel
		// takes effect before a pending message is sent.
		const initial = await this.store.get(member.guild.id, kind);
		if (!initial?.enabled) return "not-enabled";
		let banner: Buffer | undefined;
		if (wantBanner) {
			try {
				let background: Buffer | undefined;
				try { background = await this.backgrounds?.get(member.guild.id, kind); }
				catch (err) { console.warn("[Greeting] Không đọc được ảnh nền; dùng mặc định:", err instanceof Error ? err.message : err); }
				banner = await this.render({ ...bannerData(kind, member), background });
			} catch (err) { console.warn("[Greeting] Không tạo được banner; sẽ gửi chữ:", err instanceof Error ? err.message : err); }
		}
		if (this.closed) return "unavailable";
		// A setting may have changed while the image was rendering.
		const setting = await this.store.get(member.guild.id, kind);
		if (!setting?.enabled) return "not-enabled";
		const channel = member.guild.channels.cache.get(setting.channelId) ??
			await member.guild.channels.fetch(setting.channelId).catch(() => null);
		if (!channel?.isSendable() || !channel.isTextBased()) {
			console.warn(`[Greeting] Không tìm thấy kênh gửi ${kind} trong server ${member.guild.id}.`);
			return "unavailable";
		}
		const base = formatGreeting(setting, member, preview);
		if (banner) {
			try {
				await channel.send({ ...base, files: [{ attachment: banner, name: `${kind}.jpg` }] });
				return "banner";
			} catch (err) {
				console.warn(`[Greeting] Không gửi được ảnh ${kind}, thử gửi chữ:`, err instanceof Error ? err.message : err);
			}
		}
		try { await channel.send(base); return "text-only"; }
		catch (err) {
			console.warn(`[Greeting] Không gửi được tin ${kind} trong server ${member.guild.id}:`, err instanceof Error ? err.message : err);
			return "unavailable";
		}
	}
}

export class MemberGreetingActions {
	constructor(private readonly store: MemberGreetingStore, private readonly service: MemberGreetingService, private readonly hasMemberIntent: boolean) {}

	async manage(ctx: CommandContext, kind: GreetingKind, mode: string, channel?: { id: string; guildId: string | null; type: ChannelType } | null, message?: string, attachment?: BannerAttachment | null): Promise<void> {
		const canManage = ctx.guild.ownerId === ctx.userId || ctx.member.permissions?.has(PermissionFlagsBits.ManageGuild);
		if (!canManage) {
			await ctx.reply({ content: "❌ Bạn cần quyền **Quản lý máy chủ** để cấu hình welcome/goodbye.", ephemeral: true });
			return;
		}
		const title = kind === "welcome" ? "Welcome" : "Goodbye";
		const intentHint = this.hasMemberIntent ? "" : "\n⚠️ Bot chưa nhận sự kiện thành viên. Bật **Server Members Intent** trong Discord Developer Portal rồi khởi động lại bot.";
		try {
			if (mode === "set") {
				if (!channel || channel.guildId !== ctx.guild.id || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
					await ctx.reply({ content: "❌ Hãy chọn một kênh văn bản thuộc server này.", ephemeral: true });
					return;
				}
				const setting = await this.store.configure(ctx.guild.id, kind, channel.id, message);
				await ctx.reply({ content: `✅ Đã bật **${title}** tại <#${setting.channelId}>. Dùng \`/${kind} test\` để xem thử.${intentHint}`, ephemeral: true });
			} else if (mode === "off") {
				const changed = await this.store.disable(ctx.guild.id, kind);
				await ctx.reply({ content: changed ? `🛑 Đã tắt **${title}**; cấu hình được giữ lại.` : `ℹ️ **${title}** đang tắt hoặc chưa được cấu hình.`, ephemeral: true });
			} else if (mode === "status") {
				const setting = await this.store.get(ctx.guild.id, kind);
				const customBackground = await this.service.hasBackground(ctx.guild.id, kind);
				const summary = setting
					? `**${title}:** ${setting.enabled ? "Bật" : "Tắt"}\n**Kênh:** <#${setting.channelId}>\n**Nội dung:** ${truncate(escapeMarkdown(setting.message), 700)}`
					: `**${title}:** Chưa cấu hình. Dùng \`/${kind} set\` để bắt đầu.`;
				await ctx.reply({ content: `${summary}\n**Ảnh nền:** ${customBackground ? "Tùy chỉnh" : "Mặc định"}${intentHint}`, ephemeral: true });
			} else if (mode === "banner") {
				await this.service.setBackground(ctx.guild.id, kind, attachment);
				await ctx.reply({ content: `✅ Đã thay ảnh nền **${title}** riêng cho server này. Dùng \`/${kind} test\` để xem thử; ảnh được cắt giữa theo khung 1200×420.`, ephemeral: true });
			} else if (mode === "reset-banner") {
				const removed = await this.service.resetBackground(ctx.guild.id, kind);
				await ctx.reply({ content: removed ? `✅ **${title}** đã trở về ảnh nền mặc định.` : `ℹ️ **${title}** đang dùng ảnh nền mặc định.`, ephemeral: true });
			} else if (mode === "test") {
				const result = await this.service.sendTest(kind, ctx.member);
				const text: Record<GreetingDelivery, string> = {
					banner: `✅ Đã gửi thử **${title}** kèm banner đến kênh đã chọn.`,
					"text-only": `⚠️ Đã gửi thử **${title}** bằng chữ nhưng chưa gửi được banner. Kiểm tra quyền **Attach Files** và log Botkeep.`,
					"not-enabled": `❌ **${title}** chưa bật. Dùng \`/${kind} set\` trước.`,
					unavailable: `❌ Không gửi được vào kênh đã chọn. Kiểm tra quyền **View Channel**, **Send Messages** và log Botkeep.`,
				};
				await ctx.reply({ content: `${text[result]}${intentHint}`, ephemeral: true });
			} else {
				await ctx.reply({ content: `❌ Dùng \`/${kind} set\`, \`off\`, \`status\`, \`test\`, \`banner\` hoặc \`reset-banner\`.`, ephemeral: true });
			}
		} catch (err) {
			console.warn(`[Greeting] Không thể cấu hình ${kind} server ${ctx.guild.id}:`, err instanceof Error ? err.message : err);
			const messageError = err instanceof BannerInputError || (err instanceof Error && err.message.startsWith("Nội dung phải")) ? err.message : null;
			await ctx.reply({ content: messageError ? `❌ ${messageError}` : "❌ Không thể đọc hoặc lưu cấu hình welcome/goodbye; kiểm tra log Botkeep.", ephemeral: true });
		}
	}
}
