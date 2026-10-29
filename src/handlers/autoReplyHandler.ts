import { EmbedBuilder, Events, PermissionFlagsBits, escapeMarkdown, type Client, type Message } from "discord.js";
import { AutoReplyStore, MAX_AUTO_REPLY_TEXT, MAX_AUTO_REPLY_TRIGGER } from "../core/autoReplyStore.js";
import { COLORS } from "../ui/embeds.js";
import { truncate } from "../utils/format.js";
import type { CommandContext, ReplyPayload } from "./musicActions.js";

/** Reply only to a human message whose complete content matches a saved trigger. */
export function registerAutoReplyHandler(client: Client, store: AutoReplyStore, hasMessageContentIntent: boolean): void {
	let loadErrorLogged = false;
	client.on(Events.MessageCreate, async (message: Message) => {
		if (!hasMessageContentIntent || !message.guildId || message.author.bot || message.webhookId ||
			message.author.id === client.user?.id || !message.content) return;
		let reply: string | undefined;
		try {
			reply = await store.find(message.guildId, message.content);
		} catch (err) {
			if (!loadErrorLogged) {
				loadErrorLogged = true;
				console.error("[AutoReply] Không thể đọc cấu hình:", err instanceof Error ? err.message : err);
			}
			return;
		}
		if (reply === undefined) return;
		try {
			await message.reply({ content: reply, allowedMentions: { parse: [], repliedUser: false } });
		} catch (err) {
			console.warn(`[AutoReply] Không thể trả lời trong server ${message.guildId}:`, err instanceof Error ? err.message : err);
		}
	});
}

export class AutoReplyActions {
	constructor(private readonly store: AutoReplyStore, private readonly hasMessageContentIntent: boolean) {}

	async manage(ctx: CommandContext, mode: string, trigger?: string, reply?: string): Promise<void> {
		const canManage = ctx.guild.ownerId === ctx.userId || ctx.member.permissions?.has(PermissionFlagsBits.ManageGuild);
		if (!canManage) {
			await ctx.reply({ content: "❌ Bạn cần quyền **Quản lý máy chủ (Manage Server)** để cấu hình trả lời tự động.", ephemeral: true });
			return;
		}

		if (mode !== "list" && (typeof trigger !== "string" || !trigger.trim() || trigger.trim().length > MAX_AUTO_REPLY_TRIGGER)) {
			await ctx.reply({ content: `❌ Câu kích hoạt phải có 1–${MAX_AUTO_REPLY_TRIGGER} ký tự.`, ephemeral: true });
			return;
		}
		if (mode === "set" && (typeof reply !== "string" || !reply.trim() || reply.length > MAX_AUTO_REPLY_TEXT)) {
			await ctx.reply({ content: `❌ Câu trả lời phải có 1–${MAX_AUTO_REPLY_TEXT} ký tự.`, ephemeral: true });
			return;
		}

		let payload: ReplyPayload;
		try {
			if (mode === "set") {
				await this.store.set({ guildId: ctx.guild.id, trigger: trigger!, reply: reply! });
				const intentWarning = this.hasMessageContentIntent
					? ""
					: "\n⚠️ Bot đang thiếu Message Content Intent. Bật intent trong Discord Developer Portal và khởi động lại để tự trả lời.";
				payload = { content: `✅ Đã lưu câu kích hoạt và câu trả lời cho server này.${intentWarning}`, ephemeral: true };
			} else if (mode === "remove") {
				const removed = await this.store.remove(ctx.guild.id, trigger!);
				payload = { content: removed ? "🗑️ Đã xóa câu trả lời tự động." : "ℹ️ Không tìm thấy câu kích hoạt này.", ephemeral: true };
			} else if (mode === "list") {
				const rules = await this.store.list(ctx.guild.id);
				const show = (s: string, max: number) => truncate(escapeMarkdown(s.replace(/\s+/g, " ")), max);
				const body = rules.length
					? rules.map((rule, i) => `**${i + 1}.** ${show(rule.trigger, 50)} → ${show(rule.reply, 60)}`).join("\n")
					: "Chưa có câu trả lời tự động nào.";
				const intentWarning = this.hasMessageContentIntent
					? ""
					: "\n\n⚠️ Thiếu Message Content Intent, bot chưa thể đọc tin nhắn thường.";
				const embed = new EmbedBuilder().setColor(COLORS.INFO).setTitle("💬 Trả lời tự động").setDescription(`${body}${intentWarning}`);
				payload = { embeds: [embed], ephemeral: true };
			} else {
				payload = { content: "❌ Dùng `/autoreply set`, `/autoreply remove` hoặc `/autoreply list`.", ephemeral: true };
			}
		} catch (err) {
			console.error(`[AutoReply] Không thể cập nhật server ${ctx.guild.id}:`, err instanceof Error ? err.message : err);
			const limitError = err instanceof Error && err.message.startsWith("Mỗi server chỉ được lưu") ? err.message : null;
			payload = { content: limitError ? `❌ ${limitError}` : "❌ Không thể đọc hoặc lưu cấu hình; kiểm tra log Botkeep.", ephemeral: true };
		}
		await ctx.reply(payload);
	}
}
