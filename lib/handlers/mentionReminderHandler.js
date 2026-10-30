import { randomUUID } from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits, } from "discord.js";
import { DEFAULT_INTERVAL_SECONDS, DEFAULT_REMINDER_TEXT, MAX_INTERVAL_SECONDS, MAX_REMINDER_TEXT, MAX_REMINDERS_PER_RUN, MAX_TRACKED_REMINDER_MESSAGES, MIN_INTERVAL_SECONDS, } from "../core/mentionReminderStore.js";
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_CONCURRENT_GUILDS = 4;
const BUTTON_PREFIX = "tagremind:";
const defaultSchedule = (task, milliseconds) => {
    const handle = setTimeout(() => { void Promise.resolve().then(task).catch((err) => console.warn("[MentionReminder] Lỗi bộ hẹn giờ:", err instanceof Error ? err.message : err)); }, milliseconds);
    handle.unref();
    return () => clearTimeout(handle);
};
function buttonRow(token, kind) {
    const row = new ActionRowBuilder();
    if (kind === "approval") {
        row.addComponents(new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}yes:${token}`).setLabel("Đồng ý").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}no:${token}`).setLabel("Từ chối").setStyle(ButtonStyle.Secondary));
    }
    else {
        row.addComponents(new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}stop:${token}`).setLabel("Dừng tag").setStyle(ButtonStyle.Danger));
    }
    return row;
}
function isUnknownMessage(err) {
    return Boolean(err && typeof err === "object" && "code" in err && err.code === 10008);
}
function isUnknownChannel(err) {
    return Boolean(err && typeof err === "object" && "code" in err && err.code === 10003);
}
/** One short, explicitly approved reminder run per guild; nothing resumes after a restart. */
export class MentionReminderService {
    client;
    store;
    schedule;
    pending = new Map();
    active = new Map();
    reserved = new Set();
    lastSent = new Map();
    queues = new Map();
    closed = false;
    constructor(client, store, schedule = defaultSchedule) {
        this.client = client;
        this.store = store;
        this.schedule = schedule;
    }
    async close() {
        this.closed = true;
        for (const request of this.pending.values())
            request.cancelTimer();
        this.pending.clear();
        for (const run of this.active.values()) {
            run.cancelled = true;
            run.cancelTimer?.();
        }
        await Promise.allSettled([...this.active.values()].map((run) => run.inFlight).filter((work) => Boolean(work)));
        this.active.clear();
        await Promise.allSettled([...this.queues.values()]);
        // A pending command may have completed while shutdown was draining queues.
        for (const request of this.pending.values())
            request.cancelTimer();
        this.pending.clear();
        for (const run of this.active.values()) {
            run.cancelled = true;
            run.cancelTimer?.();
        }
        this.active.clear();
        this.reserved.clear();
        await this.store.flush();
    }
    queue(guildId, work) {
        const previous = this.queues.get(guildId) ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(work);
        this.queues.set(guildId, current);
        return current.finally(() => { if (this.queues.get(guildId) === current)
            this.queues.delete(guildId); });
    }
    async manage(ctx, mode, input = {}) {
        if (this.closed) {
            await ctx.reply({ content: "❌ Chức năng nhắc tag đang đóng.", ephemeral: true });
            return;
        }
        // Queue before any network fetch so a later /off cannot overtake a slow /on.
        await this.queue(ctx.guild.id, async () => {
            if (this.closed) {
                await ctx.reply({ content: "❌ Chức năng nhắc tag đang đóng.", ephemeral: true });
                return;
            }
            const caller = await ctx.guild.members.fetch({ user: ctx.userId, force: true }).catch(() => null);
            if (!caller || (ctx.guild.ownerId !== ctx.userId && !caller.permissions.has(PermissionFlagsBits.ManageGuild))) {
                await ctx.reply({ content: "❌ Bạn cần quyền **Quản lý máy chủ (Manage Server)** để quản lý nhắc tag.", ephemeral: true });
                return;
            }
            try {
                if (mode === "set")
                    await this.configure(ctx, caller, input);
                else if (mode === "on")
                    await this.requestConsent(ctx, caller);
                else if (mode === "off") {
                    const stopped = await this.stop(ctx.guild.id);
                    await ctx.reply({ content: stopped ? "🛑 Đã dừng nhắc tag; cấu hình vẫn được giữ." : "ℹ️ Hiện không có đợt tag hoặc yêu cầu đồng ý đang chạy.", ephemeral: true });
                }
                else if (mode === "delete") {
                    await this.stop(ctx.guild.id);
                    const removed = await this.store.deleteConfig(ctx.guild.id);
                    await ctx.reply({ content: removed ? "🗑️ Đã dừng và xóa cấu hình tag. Tin cũ vẫn được giữ; dùng `/spam clear` nếu muốn dọn tin bot." : "ℹ️ Chưa có cấu hình tag để xóa.", ephemeral: true });
                }
                else if (mode === "clear") {
                    await this.stop(ctx.guild.id);
                    await this.clearMessages(ctx, caller);
                }
                else if (mode === "status") {
                    const record = await this.store.get(ctx.guild.id);
                    const c = record?.config;
                    const state = this.active.has(ctx.guild.id) ? "Đang chạy" : this.pending.has(ctx.guild.id) ? "Chờ người nhận đồng ý" : "Đang dừng";
                    const detail = c ? `**Người nhận ID:** \`${c.targetId}\`\n**Kênh:** <#${c.channelId}>\n**Khoảng cách:** ${c.intervalSeconds} giây\n**Tối đa:** ${c.count} lần mỗi đợt` : "Chưa có cấu hình. Dùng `/spam set`.";
                    await ctx.reply({ content: `**Nhắc tag:** ${state}\n${detail}\n**Tin bot có thể dọn:** ${record?.messages.length ?? 0}`, ephemeral: true });
                }
            }
            catch (err) {
                console.warn(`[MentionReminder] Không xử lý được ${mode} cho server ${ctx.guild.id}:`, err instanceof Error ? err.message : err);
                await ctx.reply({ content: "❌ Không thể xử lý nhắc tag. Kiểm tra quyền kênh, dữ liệu và log [MentionReminder].", ephemeral: true });
            }
        });
    }
    async channelFor(guild, channelId) {
        const channel = await guild.channels.fetch(channelId, { force: true }).catch(() => null);
        if (!channel || channel.guildId !== guild.id || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement))
            return null;
        return channel;
    }
    async validateTarget(guild, caller, config) {
        const channel = await this.channelFor(guild, config.channelId);
        if (!channel)
            return { error: "❌ Hãy chọn một kênh chữ hoặc kênh thông báo trong server này." };
        if (!channel.permissionsFor(caller)?.has(PermissionFlagsBits.ViewChannel))
            return { error: "❌ Bạn không có quyền xem kênh đã chọn." };
        const [target, bot] = await Promise.all([
            guild.members.fetch({ user: config.targetId, force: true }).catch(() => null),
            guild.members.fetchMe({ force: true }).catch(() => null),
        ]);
        if (!target || target.user.bot)
            return { error: "❌ Hãy chọn một thành viên thật đang có mặt trong server." };
        if (!channel.permissionsFor(target)?.has(PermissionFlagsBits.ViewChannel))
            return { error: "❌ Người được chọn không xem được kênh để xác nhận." };
        if (!bot || !channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
            return { error: "❌ Bot cần quyền **Xem kênh** và **Gửi tin nhắn** trong kênh đã chọn." };
        }
        return { channel };
    }
    async configure(ctx, caller, input) {
        const intervalSeconds = input.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
        const count = input.count ?? MAX_REMINDERS_PER_RUN;
        const text = input.text?.trim() || DEFAULT_REMINDER_TEXT;
        if (!input.targetId || !Number.isInteger(intervalSeconds) || intervalSeconds < MIN_INTERVAL_SECONDS || intervalSeconds > MAX_INTERVAL_SECONDS ||
            !Number.isInteger(count) || count < 1 || count > MAX_REMINDERS_PER_RUN || text.length > MAX_REMINDER_TEXT) {
            await ctx.reply({ content: `❌ Chọn một người; khoảng cách ${MIN_INTERVAL_SECONDS}–${MAX_INTERVAL_SECONDS} giây, số lượt 1–${MAX_REMINDERS_PER_RUN} và nội dung tối đa ${MAX_REMINDER_TEXT} ký tự.`, ephemeral: true });
            return;
        }
        const config = { guildId: ctx.guild.id, channelId: input.channelId || ctx.textChannelId, targetId: input.targetId, intervalSeconds, count, text };
        const validated = await this.validateTarget(ctx.guild, caller, config);
        if ("error" in validated) {
            await ctx.reply({ content: validated.error, ephemeral: true });
            return;
        }
        await this.stop(ctx.guild.id);
        await this.store.setConfig(config);
        await ctx.reply({ content: `✅ Đã lưu người nhận và kênh <#${config.channelId}>: ${config.intervalSeconds} giây/lần, tối đa ${config.count} lần. Dùng \`/spam on\` để xin người đó đồng ý; chưa gửi tag nào.`, ephemeral: true });
    }
    async requestConsent(ctx, caller) {
        const record = await this.store.get(ctx.guild.id);
        if (!record?.config) {
            await ctx.reply({ content: "❌ Chưa có cấu hình. Dùng `/spam set` trước.", ephemeral: true });
            return;
        }
        if (this.pending.has(ctx.guild.id) || this.active.has(ctx.guild.id)) {
            await ctx.reply({ content: "ℹ️ Đợt tag đang chạy hoặc đang chờ đồng ý. Dùng `/spam off` để dừng.", ephemeral: true });
            return;
        }
        if (this.pending.size + this.active.size + this.reserved.size >= MAX_CONCURRENT_GUILDS) {
            await ctx.reply({ content: "⚠️ Bot đang xử lý đủ số đợt nhắc tag; hãy thử lại sau.", ephemeral: true });
            return;
        }
        if (record.messages.length + record.config.count + 1 > MAX_TRACKED_REMINDER_MESSAGES) {
            await ctx.reply({ content: "⚠️ Danh sách tin bot đã đầy; dùng `/spam clear` trước khi bắt đầu đợt mới.", ephemeral: true });
            return;
        }
        this.reserved.add(ctx.guild.id);
        try {
            const validated = await this.validateTarget(ctx.guild, caller, record.config);
            if ("error" in validated) {
                await ctx.reply({ content: validated.error, ephemeral: true });
                return;
            }
            const token = randomUUID();
            const config = { ...record.config };
            const sent = await validated.channel.send({
                content: `<@${config.targetId}>, có người muốn gửi bạn tối đa ${config.count} lời nhắc, cách nhau ${config.intervalSeconds} giây. Bạn chọn **Đồng ý** để bắt đầu hoặc **Từ chối**. Yêu cầu hết hạn sau 2 phút.`,
                allowedMentions: { parse: [], users: [] }, // The approval request itself must not ping.
                components: [buttonRow(token, "approval")],
            });
            if (this.closed) {
                await sent.delete().catch(() => undefined);
                return;
            }
            try {
                await this.store.addMessage(ctx.guild.id, { channelId: config.channelId, messageId: sent.id });
            }
            catch (err) {
                await sent.delete().catch(() => undefined);
                throw err;
            }
            if (this.closed) {
                await sent.delete().catch(() => undefined);
                return;
            }
            const request = {
                token, guild: ctx.guild, config, requesterId: ctx.userId, messageId: sent.id,
                expiresAt: Date.now() + REQUEST_TIMEOUT_MS, cancelTimer: () => undefined,
            };
            request.cancelTimer = this.schedule(() => this.queue(ctx.guild.id, async () => {
                if (this.pending.get(ctx.guild.id) === request)
                    this.pending.delete(ctx.guild.id);
            }), REQUEST_TIMEOUT_MS);
            this.pending.set(ctx.guild.id, request);
            await ctx.reply({ content: `📨 Đã gửi yêu cầu đồng ý trong <#${config.channelId}>. Bot chỉ tag sau khi người được chọn nhấn **Đồng ý**; yêu cầu không tự ping.`, ephemeral: true });
        }
        finally {
            this.reserved.delete(ctx.guild.id);
        }
    }
    async handleButton(interaction) {
        const guildId = interaction.guildId;
        const match = /^tagremind:(yes|no|stop):([a-f0-9-]{36})$/.exec(interaction.customId);
        if (!guildId || !match || this.closed) {
            await interaction.reply({ content: "ℹ️ Nút này đã hết hiệu lực.", flags: MessageFlags.Ephemeral });
            return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.queue(guildId, async () => {
            const action = match[1], token = match[2];
            if (action === "stop") {
                const run = this.active.get(guildId);
                if (!run || run.token !== token) {
                    await interaction.editReply({ content: "ℹ️ Đợt tag này đã dừng." });
                    return;
                }
                if (interaction.user.id !== run.config.targetId && interaction.user.id !== run.requesterId && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                    await interaction.editReply({ content: "❌ Chỉ người nhận, người bắt đầu hoặc quản trị viên có thể dừng đợt này." });
                    return;
                }
                await this.stop(guildId);
                await interaction.editReply({ content: "🛑 Đã dừng tag." });
                return;
            }
            const request = this.pending.get(guildId);
            if (!request || request.token !== token || request.messageId !== interaction.message.id || Date.now() >= request.expiresAt) {
                if (request?.token === token && Date.now() >= request.expiresAt) {
                    request.cancelTimer();
                    this.pending.delete(guildId);
                }
                await interaction.editReply({ content: "ℹ️ Yêu cầu đã hết hạn hoặc đã được xử lý." });
                return;
            }
            if (interaction.user.id !== request.config.targetId) {
                await interaction.editReply({ content: "❌ Chỉ người được chọn mới có thể đồng ý hoặc từ chối." });
                return;
            }
            request.cancelTimer();
            this.pending.delete(guildId);
            if (action === "no") {
                await interaction.editReply({ content: "✅ Đã từ chối; bot sẽ không gửi tag." });
                return;
            }
            const run = { token, guild: request.guild, config: request.config, requesterId: request.requesterId, sent: 0, cancelled: false };
            this.active.set(guildId, run);
            // Make stopping available immediately, even before the first timed message.
            await interaction.message.edit({
                content: `<@${run.config.targetId}> đã đồng ý nhận tối đa ${run.config.count} lời nhắc. Bạn có thể dừng bất kỳ lúc nào.`,
                allowedMentions: { parse: [], users: [] }, components: [buttonRow(run.token, "stop")],
            }).catch((err) => console.warn("[MentionReminder] Không thể cập nhật nút dừng:", err instanceof Error ? err.message : err));
            const previousSend = this.lastSent.get(guildId) ?? 0;
            const delay = Math.max(0, MIN_INTERVAL_SECONDS * 1000 - (Date.now() - previousSend));
            if (this.isRunning(run))
                this.scheduleTick(run, delay);
            await interaction.editReply({ content: `✅ Bạn đã đồng ý nhận tối đa ${run.config.count} lời nhắc. Bấm **Dừng tag** trong tin bất kỳ lúc nào để dừng.` });
        });
    }
    scheduleTick(run, delayMs) {
        run.cancelTimer = this.schedule(() => this.tick(run), delayMs);
    }
    isRunning(run) { return !this.closed && !run.cancelled && this.active.get(run.guild.id) === run; }
    async tick(run) {
        run.cancelTimer = undefined;
        if (!this.isRunning(run))
            return;
        const work = this.sendOne(run);
        run.inFlight = work;
        try {
            await work;
        }
        finally {
            if (run.inFlight === work)
                run.inFlight = undefined;
        }
    }
    async sendOne(run) {
        try {
            const channel = await this.channelFor(run.guild, run.config.channelId);
            if (!this.isRunning(run))
                return;
            if (!channel)
                throw new Error("Không tìm thấy kênh gửi");
            const message = await channel.send({
                content: `<@${run.config.targetId}> ${run.config.text}`,
                allowedMentions: { parse: [], users: [run.config.targetId], repliedUser: false },
                components: [buttonRow(run.token, "stop")],
            });
            const now = Date.now();
            for (const [id, sentAt] of this.lastSent)
                if (now - sentAt >= MIN_INTERVAL_SECONDS * 1000)
                    this.lastSent.delete(id);
            this.lastSent.set(run.guild.id, now);
            try {
                await this.store.addMessage(run.guild.id, { channelId: run.config.channelId, messageId: message.id });
            }
            catch (err) {
                await message.delete().catch(() => undefined);
                throw err;
            }
            run.sent++;
            if (!this.isRunning(run))
                return;
            if (run.sent >= run.config.count) {
                this.active.delete(run.guild.id);
                return;
            }
            this.scheduleTick(run, run.config.intervalSeconds * 1000);
        }
        catch (err) {
            console.warn(`[MentionReminder] Dừng đợt tag ở server ${run.guild.id}:`, err instanceof Error ? err.message : err);
            run.cancelled = true;
            run.cancelTimer?.();
            if (this.active.get(run.guild.id) === run)
                this.active.delete(run.guild.id);
        }
    }
    async stop(guildId) {
        let changed = false;
        const request = this.pending.get(guildId);
        if (request) {
            request.cancelTimer();
            this.pending.delete(guildId);
            changed = true;
        }
        const run = this.active.get(guildId);
        if (run) {
            run.cancelled = true;
            run.cancelTimer?.();
            if (run.inFlight)
                await run.inFlight.catch(() => undefined);
            if (this.active.get(guildId) === run)
                this.active.delete(guildId);
            changed = true;
        }
        return changed;
    }
    async clearMessages(ctx, caller) {
        const record = await this.store.get(ctx.guild.id);
        if (!record?.messages.length) {
            await ctx.reply({ content: "ℹ️ Không có tin bot đã lưu để dọn.", ephemeral: true });
            return;
        }
        const removed = [];
        let failed = 0;
        for (const ref of record.messages) {
            let channel;
            try {
                const found = await ctx.guild.channels.fetch(ref.channelId, { force: true });
                channel = found && found.guildId === ctx.guild.id && (found.type === ChannelType.GuildText || found.type === ChannelType.GuildAnnouncement) ? found : null;
            }
            catch (err) {
                if (isUnknownChannel(err)) {
                    removed.push(ref);
                    continue;
                }
                failed++;
                continue;
            }
            if (!channel || !channel.permissionsFor(caller)?.has(PermissionFlagsBits.ViewChannel)) {
                failed++;
                continue;
            }
            let message;
            try {
                message = await channel.messages.fetch({ message: ref.messageId, force: true });
            }
            catch (err) {
                if (isUnknownMessage(err))
                    removed.push(ref);
                else
                    failed++;
                continue;
            }
            if (!this.client.user?.id || message.author.id !== this.client.user.id) {
                failed++;
                continue;
            }
            try {
                await message.delete();
                removed.push(ref);
            }
            catch (err) {
                if (isUnknownMessage(err))
                    removed.push(ref);
                else
                    failed++;
            }
        }
        await this.store.removeMessages(ctx.guild.id, removed);
        const warning = failed ? ` Còn ${failed} tin chưa dọn được; kiểm tra quyền xem kênh của bạn và quyền **Xem kênh**, **Đọc lịch sử tin nhắn** của bot rồi thử lại.` : "";
        await ctx.reply({ content: `🧹 Đã dọn ${removed.length} tin do chức năng tag ghi nhận.${warning}`, ephemeral: true });
    }
}
export function isMentionReminderButton(customId) { return customId.startsWith(BUTTON_PREFIX); }
//# sourceMappingURL=mentionReminderHandler.js.map