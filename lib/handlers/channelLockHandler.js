import { ChannelType, OverwriteType, PermissionFlagsBits, PermissionOverwrites, } from "discord.js";
import { LOCKED_PERMISSIONS, } from "../core/channelLockStore.js";
const EVERYONE_DENY = {
    SendMessages: false,
    SendMessagesInThreads: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
};
function stateOf(overwrite, name) {
    const flag = PermissionFlagsBits[name];
    // An overwrite bitfield is not an effective member permission: do not let
    // an Administrator bit masquerade as a different overwrite bit.
    if (overwrite?.deny.has(flag, false))
        return false;
    if (overwrite?.allow.has(flag, false))
        return true;
    return null;
}
function everyoneStates(overwrite) {
    return Object.fromEntries(LOCKED_PERMISSIONS.map((name) => [name, stateOf(overwrite, name)]));
}
/** Applies and restores a deliberately small set of channel overwrites. */
export class ChannelLockActions {
    store;
    pending = new Map();
    closed = false;
    constructor(store) {
        this.store = store;
    }
    async close() {
        this.closed = true;
        await Promise.allSettled([...this.pending.values()]);
        await this.store.flush();
    }
    async manage(ctx, mode, selectedChannelId) {
        if (this.closed) {
            await ctx.reply({ content: "❌ Chức năng khóa kênh đang đóng. Hãy thử lại sau.", ephemeral: true });
            return;
        }
        const channelId = selectedChannelId || ctx.textChannelId;
        const key = JSON.stringify([ctx.guild.id, channelId]);
        const previous = this.pending.get(key) ?? Promise.resolve();
        const operation = previous.catch(() => undefined).then(() => this.run(ctx, mode, channelId));
        this.pending.set(key, operation);
        try {
            await operation;
        }
        finally {
            if (this.pending.get(key) === operation)
                this.pending.delete(key);
        }
    }
    async fetchChannel(ctx, channelId) {
        const channel = await ctx.guild.channels.fetch(channelId, { force: true }).catch(() => null);
        if (!channel || channel.guildId !== ctx.guild.id ||
            (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement))
            return null;
        return channel;
    }
    async requireFreshChannel(ctx, channelId) {
        const channel = await this.fetchChannel(ctx, channelId);
        if (!channel)
            throw new Error("Không lấy được kênh sau khi thay đổi quyền");
        return channel;
    }
    async run(ctx, mode, channelId) {
        const channel = await this.fetchChannel(ctx, channelId);
        if (!channel) {
            await ctx.reply({ content: "❌ Hãy chọn một kênh chữ hoặc kênh thông báo trong server này. Nếu đang ở chủ đề, hãy chọn kênh cha.", ephemeral: true });
            return;
        }
        // Fetch fresh members: cached/partial members can have stale roles, and a
        // permission-changing command must not rely on those stale permissions.
        const caller = await ctx.guild.members.fetch({ user: ctx.userId, force: true }).catch(() => null);
        if (!caller) {
            await ctx.reply({ content: "❌ Không xác minh được quyền thành viên của bạn. Hãy thử lại.", ephemeral: true });
            return;
        }
        const callerPermissions = channel.permissionsFor(caller);
        if (!callerPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageRoles])) {
            await ctx.reply({ content: "❌ Bạn cần quyền **Xem kênh** và **Quản lý quyền hạn (Manage Roles)** trong kênh được chọn.", ephemeral: true });
            return;
        }
        const me = await ctx.guild.members.fetchMe({ force: true }).catch(() => null);
        if (!me) {
            await ctx.reply({ content: "❌ Không tìm thấy thành viên bot trong server. Hãy thử lại.", ephemeral: true });
            return;
        }
        const botPermissions = channel.permissionsFor(me);
        if (!botPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageRoles])) {
            await ctx.reply({ content: "❌ Bot cần quyền **Xem kênh** và **Quản lý quyền hạn (Manage Roles)** trong kênh đã chọn. Nhờ chủ server cấp quyền rồi thử lại.", ephemeral: true });
            return;
        }
        let existing;
        try {
            existing = await this.store.get(ctx.guild.id, channelId);
        }
        catch (err) {
            console.warn("[ChannelLock] Không đọc được bản lưu:", err instanceof Error ? err.message : err);
            await ctx.reply({ content: "❌ Không đọc được dữ liệu khôi phục quyền. Bot chưa thay đổi kênh; kiểm tra log Botkeep.", ephemeral: true });
            return;
        }
        if (mode === "lock") {
            if (existing) {
                const detail = existing.phase === "locked" ? "đã được bot khóa" : "có lần khóa chưa hoàn tất";
                await ctx.reply({ content: `ℹ️ <#${channelId}> ${detail}. Dùng \`/unlock\` để khôi phục quyền trước.`, ephemeral: true });
                return;
            }
            if (!botPermissions.has(PermissionFlagsBits.SendMessages)) {
                await ctx.reply({ content: "❌ Bot chưa có quyền **Gửi tin nhắn** trong kênh. Hãy cấp quyền đó trước để bot vẫn gửi được welcome khi khóa.", ephemeral: true });
                return;
            }
            await this.lock(ctx, channel, me, botPermissions.has(PermissionFlagsBits.Administrator, false));
            return;
        }
        if (!existing) {
            await ctx.reply({ content: `ℹ️ Không có bản lưu do \`/lock\` tạo cho <#${channelId}>. Bot không tự thay đổi quyền để tránh mở nhầm kênh.`, ephemeral: true });
            return;
        }
        if (existing.botId !== me.id) {
            await ctx.reply({ content: "❌ Bản lưu khóa thuộc bot khác; bot này không tự thay đổi quyền. Hãy kiểm tra dữ liệu hoặc khôi phục thủ công.", ephemeral: true });
            return;
        }
        await this.unlock(ctx, channel, existing);
    }
    async lock(ctx, channel, me, botIsAdmin) {
        const everyone = channel.permissionOverwrites.cache.get(ctx.guild.id);
        const bot = channel.permissionOverwrites.cache.get(me.id);
        const botSend = stateOf(bot, "SendMessages");
        const record = {
            guildId: ctx.guild.id,
            channelId: channel.id,
            botId: me.id,
            phase: "pending",
            everyone: { existed: Boolean(everyone), permissions: everyoneStates(everyone) },
            bot: { existed: Boolean(bot), sendMessages: botSend, changed: !botIsAdmin && botSend !== true },
        };
        try {
            await this.store.put(record);
        }
        catch (err) {
            console.warn("[ChannelLock] Không lưu được bản khôi phục:", err instanceof Error ? err.message : err);
            await ctx.reply({ content: "❌ Không lưu được quyền cũ; bot chưa thay đổi kênh. Kiểm tra thư mục dữ liệu và log Botkeep.", ephemeral: true });
            return;
        }
        const reason = `DTrx /lock requested by ${ctx.userId}`;
        let bannerHint = "";
        try {
            let fresh = channel;
            if (record.bot.changed) {
                // First keep the bot able to send when the @everyone deny takes effect.
                await fresh.permissionOverwrites.edit(me.id, { SendMessages: true }, { type: OverwriteType.Member, reason });
                fresh = await this.requireFreshChannel(ctx, channel.id);
                if (stateOf(fresh.permissionOverwrites.cache.get(me.id), "SendMessages") !== true) {
                    throw new Error("Không xác nhận được quyền gửi của bot");
                }
            }
            await fresh.permissionOverwrites.edit(ctx.guild.id, EVERYONE_DENY, { type: OverwriteType.Role, reason });
            fresh = await this.requireFreshChannel(ctx, channel.id);
            const applied = fresh.permissionOverwrites.cache.get(ctx.guild.id);
            if (LOCKED_PERMISSIONS.some((name) => stateOf(applied, name) !== false))
                throw new Error("Không xác nhận được toàn bộ quyền khóa");
            const effective = fresh.permissionsFor(me);
            if (!effective?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))
                throw new Error("Bot không còn quyền xem hoặc gửi trong kênh");
            await this.store.put({ ...record, phase: "locked" });
            bannerHint = effective.has(PermissionFlagsBits.AttachFiles) ? "" : "\n⚠️ Bot thiếu **Đính kèm tập tin**; welcome có thể chỉ gửi chữ.";
        }
        catch (err) {
            console.warn(`[ChannelLock] Khóa kênh ${channel.id} chưa hoàn tất:`, err instanceof Error ? err.message : err);
            await ctx.reply({ content: `❌ Chưa xác nhận khóa <#${channel.id}>. Bot đã giữ bản quyền cũ; dùng \`/unlock\` để hoàn nguyên nếu cần. Kiểm tra quyền **Quản lý quyền hạn** và log [ChannelLock].`, ephemeral: true });
            return;
        }
        await ctx.reply({
            content: `🔒 Đã khóa <#${channel.id}> cho **@everyone**: không gửi tin nhắn, tạo hoặc nhắn trong chủ đề. Bot vẫn có quyền gửi.${bannerHint}\n⚠️ Quản trị viên hoặc vai trò/thành viên được cho phép riêng có thể vẫn gửi. Dùng \`/unlock\` để khôi phục quyền cũ.`,
            ephemeral: true,
        });
    }
    async restoreGroup(ctx, channel, targetId, type, existedBefore, original, locked) {
        const current = channel.permissionOverwrites.cache.get(targetId);
        const patch = {};
        let conflicts = 0;
        for (const name of Object.keys(original)) {
            const before = original[name];
            const expected = locked[name];
            if (before === undefined || expected === undefined)
                continue;
            const now = stateOf(current, name);
            if (now === before)
                continue; // Already restored, including after an ambiguous API failure.
            if (now === expected)
                patch[name] = before;
            else
                conflicts++; // A human/another bot changed it; preserve their edit.
        }
        const names = Object.keys(patch);
        if (names.length === 0)
            return { channel, conflicts };
        const reason = `DTrx /unlock requested by ${ctx.userId}`;
        const result = PermissionOverwrites.resolveOverwriteOptions(patch, {
            allow: current?.allow.bitfield ?? 0n,
            deny: current?.deny.bitfield ?? 0n,
        });
        if (!existedBefore && current && result.allow.bitfield === 0n && result.deny.bitfield === 0n) {
            await channel.permissionOverwrites.delete(targetId, reason);
        }
        else {
            await channel.permissionOverwrites.edit(targetId, patch, { type, reason });
        }
        const fresh = await this.requireFreshChannel(ctx, channel.id);
        const updated = fresh.permissionOverwrites.cache.get(targetId);
        if (names.some((name) => stateOf(updated, name) !== patch[name]))
            throw new Error("Không xác nhận được quyền đã khôi phục");
        return { channel: fresh, conflicts };
    }
    async unlock(ctx, channel, record) {
        let conflicts = 0;
        try {
            const everyoneResult = await this.restoreGroup(ctx, channel, ctx.guild.id, OverwriteType.Role, record.everyone.existed, record.everyone.permissions, EVERYONE_DENY);
            conflicts = everyoneResult.conflicts;
            if (record.bot.changed) {
                const botResult = await this.restoreGroup(ctx, everyoneResult.channel, record.botId, OverwriteType.Member, record.bot.existed, { SendMessages: record.bot.sendMessages }, { SendMessages: true });
                conflicts += botResult.conflicts;
            }
            await this.store.remove(record.guildId, record.channelId);
        }
        catch (err) {
            console.warn(`[ChannelLock] Khôi phục kênh ${channel.id} chưa hoàn tất:`, err instanceof Error ? err.message : err);
            await ctx.reply({ content: `❌ Chưa khôi phục xong <#${channel.id}>. Bản lưu vẫn được giữ; kiểm tra quyền bot và thử \`/unlock\` lại. Xem log [ChannelLock].`, ephemeral: true });
            return;
        }
        const conflictHint = conflicts ? "\n⚠️ Một số quyền đã được đổi trong lúc khóa nên bot giữ nguyên thay đổi đó; hãy kiểm tra quyền kênh." : "";
        const originalHint = record.everyone.permissions.SendMessages === false ? "\nℹ️ Trước khi khóa, @everyone đã bị chặn gửi tin nên kênh có thể vẫn không nhắn được." : "";
        await ctx.reply({ content: `🔓 Đã khôi phục quyền trước khi khóa cho <#${channel.id}>.${conflictHint}${originalHint}`, ephemeral: true });
    }
}
//# sourceMappingURL=channelLockHandler.js.map