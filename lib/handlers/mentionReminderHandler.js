import { ChannelType, MessageFlags, PermissionFlagsBits, } from "discord.js";
import { DEFAULT_INTERVAL_SECONDS, DEFAULT_REMINDER_TEXT, MAX_INTERVAL_SECONDS, MAX_REMINDER_TEXT, MAX_REMINDERS_PER_RUN, MAX_TRACKED_REMINDER_MESSAGES, MIN_INTERVAL_SECONDS, } from "../core/mentionReminderStore.js";
const MAX_CONCURRENT_GUILDS = 4;
const BUTTON_PREFIX = "tagremind:";
const CLEAR_DELAY_MS = 5_000;
// Keep a margin so a message close to Discord's two-week cutoff does not age
// out between verification and the bulk-delete request.
const MAX_BULK_AGE_MS = 14 * 24 * 60 * 60 * 1_000 - 60_000;
const MAX_BULK_SIZE = 100;
/** Limit concurrent requests without introducing a delay between deletions. */
async function mapBounded(items, limit, work) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await work(items[index]);
        }
    }));
    return results;
}
const defaultSchedule = (task, milliseconds) => {
    const handle = setTimeout(() => { void Promise.resolve().then(task).catch((err) => console.warn("[MentionReminder] Lỗi bộ hẹn giờ:", err instanceof Error ? err.message : err)); }, milliseconds);
    handle.unref();
    return () => clearTimeout(handle);
};
function isUnknownMessage(err) {
    return Boolean(err && typeof err === "object" && "code" in err && err.code === 10008);
}
function isUnknownChannel(err) {
    return Boolean(err && typeof err === "object" && "code" in err && err.code === 10003);
}
function isMissingAccess(err) {
    if (!err || typeof err !== "object")
        return false;
    const failure = err;
    return failure.code === 50001 || failure.code === 50013 || failure.status === 403;
}
/** One bounded reminder run per guild; nothing resumes after a restart. */
export class MentionReminderService {
    client;
    store;
    schedule;
    active = new Map();
    reserved = new Set();
    lastSent = new Map();
    queues = new Map();
    cleanupDelayCancels = new Set();
    closeSignal = new AbortController();
    closed = false;
    constructor(client, store, schedule = defaultSchedule) {
        this.client = client;
        this.store = store;
        this.schedule = schedule;
    }
    async close() {
        this.closed = true;
        this.closeSignal.abort();
        for (const cancel of [...this.cleanupDelayCancels])
            cancel();
        for (const run of this.active.values()) {
            run.cancelled = true;
            run.cancelTimer?.();
        }
        await Promise.allSettled([...this.active.values()].map((run) => run.inFlight).filter((work) => Boolean(work)));
        this.active.clear();
        await Promise.allSettled([...this.queues.values()]);
        // An in-flight command may have completed while shutdown was draining queues.
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
            // The selected recipient and initiator can stop their own active run even without
            // Manage Server. Every other management operation still requires that permission.
            const running = this.active.get(ctx.guild.id);
            if (mode === "off" && running && (running.config.targetId === ctx.userId || running.requesterId === ctx.userId)) {
                await this.stop(ctx.guild.id);
                await ctx.reply({ content: "🛑 Đã dừng nhắc tag; cấu hình vẫn được giữ.", ephemeral: true });
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
                    await this.startRun(ctx, caller);
                else if (mode === "off") {
                    const stopped = await this.stop(ctx.guild.id);
                    await ctx.reply({ content: stopped ? "🛑 Đã dừng nhắc tag; cấu hình vẫn được giữ." : "ℹ️ Hiện không có đợt tag đang chạy.", ephemeral: true });
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
                    const state = this.active.has(ctx.guild.id) ? "Đang chạy" : "Đang dừng";
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
            return { error: "❌ Người được chọn không xem được kênh để nhận tin và dùng lệnh dừng." };
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
        await ctx.reply({ content: `✅ Đã lưu người nhận và kênh <#${config.channelId}>: ${config.intervalSeconds} giây/lần, tối đa ${config.count} lần. Dùng \`/spam on\` để bắt đầu; chưa gửi tag nào.`, ephemeral: true });
    }
    async startRun(ctx, caller) {
        const record = await this.store.get(ctx.guild.id);
        if (!record?.config) {
            await ctx.reply({ content: "❌ Chưa có cấu hình. Dùng `/spam set` trước.", ephemeral: true });
            return;
        }
        // Older releases allowed intervals above the current maximum. Preserve those records,
        // but require an explicit /set rather than silently making their reminders much faster.
        if (record.config.intervalSeconds < MIN_INTERVAL_SECONDS || record.config.intervalSeconds > MAX_INTERVAL_SECONDS) {
            await ctx.reply({ content: `⚠️ Khoảng cách đã lưu không còn hợp lệ. Dùng \`/spam set\` đặt lại từ ${MIN_INTERVAL_SECONDS} đến ${MAX_INTERVAL_SECONDS} giây.`, ephemeral: true });
            return;
        }
        if (this.active.has(ctx.guild.id)) {
            await ctx.reply({ content: "ℹ️ Đợt tag đang chạy. Dùng `/spam off` để dừng.", ephemeral: true });
            return;
        }
        // Reserve before channel/member fetches so concurrent servers cannot exceed the shared cap.
        if (this.active.size + this.reserved.size >= MAX_CONCURRENT_GUILDS) {
            await ctx.reply({ content: "⚠️ Bot đang xử lý đủ số đợt nhắc tag; hãy thử lại sau.", ephemeral: true });
            return;
        }
        if (record.messages.length + record.config.count > MAX_TRACKED_REMINDER_MESSAGES) {
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
            if (this.closed) {
                await ctx.reply({ content: "❌ Chức năng nhắc tag đang đóng.", ephemeral: true });
                return;
            }
            const run = {
                guild: ctx.guild, config: { ...record.config }, requesterId: ctx.userId,
                sent: 0, cancelled: false,
            };
            const previousSend = this.lastSent.get(ctx.guild.id) ?? 0;
            const delay = Math.max(0, MIN_INTERVAL_SECONDS * 1000 - (Date.now() - previousSend));
            // Transfer the reservation to an active slot without an await between the two operations.
            this.reserved.delete(ctx.guild.id);
            this.active.set(ctx.guild.id, run);
            try {
                this.scheduleTick(run, delay);
                await ctx.reply({ content: `✅ Đã bắt đầu tag trong <#${run.config.channelId}>: tối đa ${run.config.count} lần, cách nhau ${run.config.intervalSeconds} giây. Dùng \`/spam off\` để dừng.`, ephemeral: true });
            }
            catch (err) {
                await this.stop(ctx.guild.id);
                throw err;
            }
        }
        finally {
            this.reserved.delete(ctx.guild.id);
        }
    }
    async handleButton(interaction) {
        // Messages from old versions can still show a button, but only the slash command stops a run.
        await interaction.reply({ content: "ℹ️ Nút cũ không còn hiệu lực. Dùng `/spam off` để dừng.", flags: MessageFlags.Ephemeral });
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
    /** Cancel the five-second wait during shutdown without deleting any messages. */
    waitBeforeCleanup() {
        return new Promise((resolve, reject) => {
            let done = false;
            let cancelTimer;
            const finish = (ready) => {
                if (done)
                    return;
                done = true;
                cancelTimer?.();
                this.cleanupDelayCancels.delete(cancel);
                resolve(ready);
            };
            const cancel = () => finish(false);
            this.cleanupDelayCancels.add(cancel);
            try {
                cancelTimer = this.schedule(() => finish(true), CLEAR_DELAY_MS);
                if (done)
                    cancelTimer();
                else if (this.closed)
                    cancel();
            }
            catch (error) {
                this.cleanupDelayCancels.delete(cancel);
                reject(error);
            }
        });
    }
    async untilClosed(operation) {
        if (this.closed)
            return undefined;
        let cancel = () => undefined;
        const stopped = new Promise((resolve) => {
            cancel = () => resolve(undefined);
            this.closeSignal.signal.addEventListener("abort", cancel, { once: true });
        });
        try {
            return await Promise.race([operation, stopped]);
        }
        finally {
            this.closeSignal.signal.removeEventListener("abort", cancel);
        }
    }
    /** Fetch recent messages in pages so a typical batch can be verified with
     * one request, then force-fetch only IDs not found in those pages. */
    async prepareCleanup(guild, caller, refs) {
        const groups = new Map();
        for (const ref of refs) {
            const group = groups.get(ref.channelId) ?? [];
            group.push(ref);
            groups.set(ref.channelId, group);
        }
        const bot = await guild.members.fetchMe({ force: true }).catch(() => null);
        return mapBounded([...groups.entries()], 4, async ([channelId, channelRefs]) => {
            const result = { channelId, refs: channelRefs, verified: [], missing: [] };
            let channel;
            try {
                const found = await guild.channels.fetch(channelId, { force: true });
                channel = found && found.guildId === guild.id && (found.type === ChannelType.GuildText || found.type === ChannelType.GuildAnnouncement) ? found : null;
            }
            catch (error) {
                if (isUnknownChannel(error))
                    result.missing.push(...channelRefs);
                return result;
            }
            if (this.closed || !channel || !channel.permissionsFor(caller)?.has(PermissionFlagsBits.ViewChannel) || !this.client.user?.id ||
                (bot && !channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])))
                return result;
            const botId = this.client.user.id;
            let accessDenied = false;
            const pending = new Map(channelRefs.map((ref) => [ref.messageId, ref]));
            const inspect = (message) => {
                const ref = pending.get(message.id);
                if (!ref)
                    return;
                pending.delete(message.id);
                if (message.author?.id === botId)
                    result.verified.push({ ref, message });
            };
            // IDs in Discord are sortable snowflakes. Fetch around tracked IDs in
            // bounded rounds, covering batches even if other users spoke between
            // reminders. Unrelated IDs/foreign authors are never eligible.
            for (let round = 0; pending.size > 1 && round < 6 && !accessDenied && !this.closed; round++) {
                const before = pending.size;
                const ordered = [...pending.values()].sort((a, b) => a.messageId.length - b.messageId.length || a.messageId.localeCompare(b.messageId));
                const anchors = [];
                for (let start = 0; start < ordered.length; start += MAX_BULK_SIZE) {
                    anchors.push(ordered[Math.min(start + Math.floor(MAX_BULK_SIZE / 2), ordered.length - 1)].messageId);
                }
                await mapBounded(anchors, 4, async (around) => {
                    if (this.closed || accessDenied)
                        return;
                    try {
                        const page = await channel.messages.fetch({ around, limit: MAX_BULK_SIZE, cache: false });
                        for (const message of page.values())
                            inspect(message);
                    }
                    catch (error) {
                        if (isMissingAccess(error))
                            accessDenied = true;
                        // Other failures fall back to force-fetching the tracked IDs.
                    }
                });
                if (pending.size === before)
                    break;
            }
            await mapBounded([...pending.values()], 10, async (ref) => {
                if (this.closed || accessDenied)
                    return;
                try {
                    inspect(await channel.messages.fetch({ message: ref.messageId, force: true, cache: false }));
                }
                catch (error) {
                    if (isUnknownMessage(error))
                        result.missing.push(ref);
                    else if (isMissingAccess(error))
                        accessDenied = true;
                }
            });
            if (accessDenied)
                result.verified = [];
            return result;
        });
    }
    async clearMessages(ctx, caller) {
        const record = await this.store.get(ctx.guild.id);
        if (!record?.messages.length) {
            await ctx.reply({ content: "ℹ️ Không có tin bot đã lưu để dọn.", ephemeral: true });
            return;
        }
        await ctx.reply({ content: "🕒 Đã dừng đợt tag. Bot sẽ bắt đầu dọn các tin đã ghi nhận sau khoảng **5 giây**.", ephemeral: true });
        // Verification can run while the five-second timer is counting down.
        // A failed or cancelled delay must never trigger a delete.
        const delay = this.waitBeforeCleanup();
        const preparation = this.prepareCleanup(ctx.guild, caller, record.messages).then((plan) => ({ plan }), (error) => ({ error }));
        if (!(await delay) || this.closed) {
            await ctx.reply({ content: "ℹ️ Đã hủy dọn tin vì bot đang dừng; danh sách tin vẫn được giữ.", ephemeral: true }).catch(() => undefined);
            return;
        }
        const prepared = await this.untilClosed(preparation);
        if (!prepared || this.closed)
            return;
        if ("error" in prepared)
            throw prepared.error;
        // The caller's privileges may have changed during the delay. Never use
        // the original authorization to delete after their access is revoked.
        const currentCaller = await this.untilClosed(ctx.guild.members.fetch({ user: ctx.userId, force: true }).catch(() => null));
        if (this.closed)
            return;
        if (!currentCaller || (ctx.guild.ownerId !== ctx.userId && !currentCaller.permissions.has(PermissionFlagsBits.ManageGuild))) {
            await ctx.reply({ content: "⚠️ Đã hủy dọn tin vì bạn không còn quyền **Quản lý máy chủ**.", ephemeral: true });
            return;
        }
        const bot = await this.untilClosed(ctx.guild.members.fetchMe({ force: true }).catch(() => null));
        if (this.closed)
            return;
        const removed = new Map();
        const markRemoved = (ref) => removed.set(JSON.stringify([ref.channelId, ref.messageId]), ref);
        let usedOldMessages = false, missingBulkPermission = false, bulkFailed = false;
        const tasks = (await mapBounded(prepared.plan, 4, async (group) => {
            const jobs = [];
            for (const ref of group.missing)
                markRemoved(ref);
            if (this.closed || !group.verified.length)
                return jobs;
            let channel;
            try {
                const found = await this.untilClosed(ctx.guild.channels.fetch(group.channelId, { force: true }));
                channel = found && found.guildId === ctx.guild.id && (found.type === ChannelType.GuildText || found.type === ChannelType.GuildAnnouncement) ? found : null;
            }
            catch (error) {
                if (isUnknownChannel(error))
                    for (const ref of group.refs)
                        markRemoved(ref);
                return jobs;
            }
            if (this.closed || !channel || !channel.permissionsFor(currentCaller)?.has(PermissionFlagsBits.ViewChannel) ||
                (bot && !channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])))
                return jobs;
            const canBulkDelete = Boolean(bot && channel.permissionsFor(bot)?.has(PermissionFlagsBits.ManageMessages));
            const now = Date.now();
            const recent = [], single = [];
            for (const item of group.verified) {
                if (Number.isFinite(item.message.createdTimestamp) && now - item.message.createdTimestamp < MAX_BULK_AGE_MS)
                    recent.push(item);
                else {
                    single.push(item);
                    usedOldMessages = true;
                }
            }
            const deleteOne = async (item) => {
                if (this.closed)
                    return;
                try {
                    await item.message.delete();
                    markRemoved(item.ref);
                }
                catch (error) {
                    if (isUnknownMessage(error) || isUnknownChannel(error))
                        markRemoved(item.ref);
                }
            };
            if (!canBulkDelete && recent.length > 1)
                missingBulkPermission = true;
            for (let start = 0; start < recent.length; start += MAX_BULK_SIZE) {
                const batch = recent.slice(start, start + MAX_BULK_SIZE);
                if (batch.length === 1 || !canBulkDelete) {
                    for (const item of batch)
                        jobs.push(() => deleteOne(item));
                }
                else {
                    jobs.push(async () => {
                        if (this.closed)
                            return;
                        try {
                            await channel.bulkDelete(batch.map((item) => item.ref.messageId));
                            for (const item of batch)
                                markRemoved(item.ref);
                        }
                        catch (error) {
                            if (isUnknownChannel(error))
                                for (const item of batch)
                                    markRemoved(item.ref);
                            else {
                                bulkFailed = true;
                                await mapBounded(batch, 5, deleteOne);
                            }
                        }
                    });
                }
            }
            for (const item of single)
                jobs.push(() => deleteOne(item));
            return jobs;
        })).flat();
        await mapBounded(tasks, 8, async (job) => job());
        await this.store.removeMessages(ctx.guild.id, [...removed.values()]);
        const failed = record.messages.length - removed.size;
        const warning = failed ? ` Còn ${failed} tin chưa dọn được; kiểm tra quyền xem kênh của bạn và quyền **Xem kênh**, **Đọc lịch sử tin nhắn** của bot rồi thử lại.` : "";
        const details = [
            missingBulkPermission ? "Bot thiếu quyền **Quản lý tin nhắn**, nên các tin đó phải xóa riêng." : "",
            usedOldMessages ? "Tin gần hoặc quá 14 ngày phải xóa riêng theo giới hạn Discord." : "",
            bulkFailed ? "Một số lô không xóa được hàng loạt và đã được thử xóa riêng." : "",
        ].filter(Boolean).join(" ");
        if (!this.closed)
            await ctx.reply({ content: `🧹 Đã dọn ${removed.size} tin do chức năng tag ghi nhận.${warning}${details ? ` ${details}` : ""}`, ephemeral: true });
    }
}
export function isMentionReminderButton(customId) { return customId.startsWith(BUTTON_PREFIX); }
//# sourceMappingURL=mentionReminderHandler.js.map