import { EmbedBuilder, GuildMember, MessageFlags, } from "discord.js";
import { PREDEFINED_FILTERS } from "ziplayer";
import { buildFullLyricsEmbed, buildNowPlayingPayload, COLORS, CONTROL_IDS, } from "../ui/embeds.js";
import { formatDuration, nextLoopMode, truncate } from "../utils/format.js";
import { validateMemberVoiceAccess, } from "./musicActions.js";
// ViewChannel | SendMessages | EmbedLinks | AttachFiles | Connect | Speak | UseVAD
const BOT_INVITE_PERMISSIONS = "36752384";
/**
 * Safely resolves `Guild` and `GuildMember` for Slash & Component interactions.
 *
 * Fixes two common Discord.js v14 pitfalls:
 * 1. `interaction.member` can be a raw `APIInteractionGuildMember` plain object (not `instanceof GuildMember`)
 *    when `GuildMemberManager` uses `Options.cacheWithLimits` or before member cache warms up.
 * 2. When a user installs the app via "User Install" or invites it with `applications.commands` only
 *    (missing `bot` scope), `interaction.inGuild()` is `true` (`guildId` exists), yet `interaction.guild`
 *    is `null` because the Bot user is not in the server.
 */
export async function resolveInteractionGuildAndMember(interaction) {
    if (!interaction.inGuild() || !interaction.guildId) {
        return {
            ok: false,
            kind: "not_in_guild",
            message: "❌ Lệnh này không thể dùng trong Tin nhắn riêng (DM). Hãy gõ lệnh trong kênh chat của Server!",
        };
    }
    const guild = interaction.guild ??
        interaction.client.guilds.cache.get(interaction.guildId) ??
        (await interaction.client.guilds.fetch(interaction.guildId).catch(() => null));
    if (!guild) {
        const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${interaction.applicationId}&permissions=${BOT_INVITE_PERMISSIONS}&integration_type=0&scope=bot+applications.commands`;
        return {
            ok: false,
            kind: "bot_not_in_guild",
            message: [
                "❌ **Bot chưa có mặt trong Server này với tư cách thành viên (`bot` scope)!**",
                "Hiện tại ứng dụng chỉ mới được cài dưới dạng *User App* hoặc chỉ có quyền *Slash Commands*, nên Discord không cho phép Bot nhìn thấy Server hay vào kênh thoại.",
                `👉 **Cách sửa ngay:** [Bấm vào đây để mời đầy đủ Bot vào Server](${inviteUrl}) *(chọn Server của bạn → Authorize)* rồi gõ lại lệnh nhé!`,
            ].join("\n"),
        };
    }
    const member = interaction.member instanceof GuildMember
        ? interaction.member
        : (guild.members.cache.get(interaction.user.id) ??
            (await guild.members.fetch(interaction.user.id).catch(() => null)));
    if (!member) {
        return {
            ok: false,
            kind: "member_fetch_failed",
            message: "❌ Không thể lấy thông tin thành viên của bạn trong Server này. Vui lòng thử lại sau giây lát!",
        };
    }
    return { ok: true, guild, member };
}
/**
 * Complete an acknowledged slash interaction without accidentally exposing a
 * private error. A deferred response's visibility is fixed at deferReply time.
 * If the intended visibility differs, resolve the placeholder with a generic
 * message, send the actual response as a follow-up, then remove the placeholder.
 */
async function replyToSlashInteraction(interaction, payload) {
    const base = {
        content: payload.content,
        embeds: payload.embeds,
        files: payload.files,
    };
    const flags = payload.ephemeral ? { flags: MessageFlags.Ephemeral } : {};
    if (interaction.deferred && !interaction.replied) {
        if (Boolean(interaction.ephemeral) !== Boolean(payload.ephemeral)) {
            // A first follow-up to an unresolved deferral can be treated as an edit
            // by Discord, so resolve it before creating the new-visibility message.
            await interaction.editReply({ content: "Đang gửi phản hồi..." });
            await interaction.followUp({ ...base, ...flags });
            await interaction.deleteReply().catch(() => undefined);
        }
        else {
            await interaction.editReply(base);
        }
    }
    else if (interaction.replied) {
        await interaction.followUp({ ...base, ...flags });
    }
    else {
        await interaction.reply({ ...base, ...flags });
    }
}
async function createSlashContext(interaction) {
    const resolved = await resolveInteractionGuildAndMember(interaction);
    if (!resolved.ok) {
        return { ok: false, message: resolved.message };
    }
    const ctx = {
        guild: resolved.guild,
        member: resolved.member,
        userId: interaction.user.id,
        textChannelId: interaction.channelId,
        defer: async (ephemeral = false) => {
            if (interaction.deferred || interaction.replied)
                return;
            await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : undefined);
        },
        reply: async (payload) => replyToSlashInteraction(interaction, payload),
    };
    return { ok: true, ctx };
}
async function handleAutocomplete(engine, interaction) {
    try {
        const focused = interaction.options.getFocused(true);
        const value = focused.value.trim();
        if ((interaction.commandName === "filter" && focused.name === "name") ||
            (interaction.commandName === "save" && focused.name === "filter")) {
            const action = interaction.commandName === "filter" ? interaction.options.getString("action") : "apply";
            const player = interaction.guildId ? engine.manager.get(interaction.guildId) : undefined;
            const pool = action === "remove" && player
                ? player.filter.getActiveFilters().map((f) => [f.name, f])
                : Object.entries(PREDEFINED_FILTERS);
            const lower = value.toLowerCase();
            const matches = pool
                .filter(([k, def]) => !lower || k.toLowerCase().includes(lower) || def.description.toLowerCase().includes(lower))
                .slice(0, 25)
                .map(([k, def]) => ({
                name: truncate(`${k} — ${def.description} [${def.category ?? "fx"}]`, 100),
                value: k,
            }));
            await interaction.respond(matches);
            return;
        }
        if ((interaction.commandName === "play" || interaction.commandName === "playnext") && focused.name === "query") {
            if (value.length < 2 || /^https?:\/\//i.test(value) || value.toLowerCase().startsWith("tts:")) {
                await interaction.respond(value
                    ? [{ name: truncate(`▶️ Phát trực tiếp: ${value}`, 100), value: truncate(value, 100) }]
                    : []);
                return;
            }
            // Bound autocomplete search under 2200ms so Discord's 3s interaction window never expires
            const result = await Promise.race([
                engine.manager.search(value, interaction.user.id),
                new Promise((resolve) => setTimeout(() => resolve(null), 2_200)),
            ]).catch(() => null);
            if (!result || !result.tracks?.length) {
                await interaction.respond([{ name: truncate(`🔍 Tìm kiếm: ${value}`, 100), value: truncate(value, 100) }]);
                return;
            }
            const choices = result.tracks.slice(0, 10).map((t) => {
                const label = truncate(`${t.title} [${formatDuration(t.duration, t.isLive)}]`, 100);
                const choiceValue = t.url && t.url.length <= 100 ? t.url : truncate(t.title, 100);
                return { name: label, value: choiceValue };
            });
            await interaction.respond(choices);
        }
    }
    catch {
        // Autocomplete timeouts are benign; swallow safely
    }
}
async function handleControllerComponent(engine, interaction) {
    const resolved = await resolveInteractionGuildAndMember(interaction);
    if (!resolved.ok) {
        await interaction.reply({
            content: resolved.message,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    const player = engine.manager.get(resolved.guild.id);
    if (!player || player.destroyed || !player.currentTrack) {
        await interaction.reply({
            embeds: [new EmbedBuilder().setColor(COLORS.ERROR).setDescription("❌ Phiên phát nhạc này đã kết thúc!")],
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    const access = validateMemberVoiceAccess(resolved.member, player);
    if (!access.ok) {
        await interaction.reply({
            embeds: [new EmbedBuilder().setColor(COLORS.ERROR).setDescription(access.reason)],
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    const ud = player.userdata;
    if (interaction.isStringSelectMenu() && interaction.customId === CONTROL_IDS.FILTER_SELECT) {
        const selected = interaction.values[0];
        await interaction.deferUpdate();
        if (selected === "clear") {
            await player.filter.clearAll();
        }
        else if (player.filter.hasFilter(selected)) {
            await player.filter.removeFilter(selected);
        }
        else {
            await player.filter.applyFilter(selected);
        }
        await interaction.editReply(buildNowPlayingPayload(player, false)).catch(() => undefined);
        return;
    }
    if (!interaction.isButton())
        return;
    switch (interaction.customId) {
        case CONTROL_IDS.PREV: {
            await interaction.deferUpdate();
            await player.previous();
            break;
        }
        case CONTROL_IDS.TOGGLE: {
            if (player.isPaused) {
                player.resume();
            }
            else {
                player.pause();
            }
            await interaction.update(buildNowPlayingPayload(player, false)).catch(() => undefined);
            break;
        }
        case CONTROL_IDS.SKIP: {
            await interaction.deferUpdate();
            player.skip();
            break;
        }
        case CONTROL_IDS.STOP: {
            player.clearQueue();
            player.stop();
            await interaction.update(buildNowPlayingPayload(player, true)).catch(() => undefined);
            break;
        }
        case CONTROL_IDS.LOOP: {
            const next = nextLoopMode(player.queue.getLoopMode());
            player.loop(next);
            await interaction.update(buildNowPlayingPayload(player, false)).catch(() => undefined);
            break;
        }
        case CONTROL_IDS.SHUFFLE: {
            player.shuffle();
            await interaction.update(buildNowPlayingPayload(player, false)).catch(() => undefined);
            break;
        }
        case CONTROL_IDS.AUTOPLAY: {
            player.autoPlay(!player.autoPlay());
            await interaction.update(buildNowPlayingPayload(player, false)).catch(() => undefined);
            break;
        }
        case CONTROL_IDS.VOLDOWN: {
            player.setVolume(Math.max(0, player.volume - 10));
            await interaction.update(buildNowPlayingPayload(player, false)).catch(() => undefined);
            break;
        }
        case CONTROL_IDS.VOLUP: {
            player.setVolume(Math.min(100, player.volume + 10));
            await interaction.update(buildNowPlayingPayload(player, false)).catch(() => undefined);
            break;
        }
        case CONTROL_IDS.LYRICS: {
            ud.liveLyricsEnabled = !ud.liveLyricsEnabled;
            ud.textChannelId = interaction.channelId;
            await interaction.update(buildNowPlayingPayload(player, false)).catch(() => undefined);
            if (ud.liveLyricsEnabled && player.currentTrack) {
                const cached = ud.cachedLyrics;
                if (cached && !cached.synced && cached.text) {
                    await interaction
                        .followUp({
                        embeds: [buildFullLyricsEmbed(player.currentTrack, cached)],
                        flags: MessageFlags.Ephemeral,
                    })
                        .catch(() => undefined);
                }
            }
            break;
        }
    }
}
export function registerInteractionHandler(engine, actions) {
    engine.client.on("interactionCreate", async (interaction) => {
        try {
            if (interaction.isAutocomplete()) {
                await handleAutocomplete(engine, interaction);
                return;
            }
            if ((interaction.isButton() || interaction.isStringSelectMenu()) &&
                interaction.customId.startsWith("zi:")) {
                await handleControllerComponent(engine, interaction);
                return;
            }
            if (!interaction.isChatInputCommand())
                return;
            // Acknowledge first: guild/member fetches and TTS/voice setup may take longer
            // than Discord's initial interaction deadline.
            console.log(`[Slash] /${interaction.commandName} received (guild: ${interaction.guildId ?? "DM"})`);
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferReply();
            }
            const resolvedCtx = await createSlashContext(interaction);
            if (!resolvedCtx.ok) {
                await replyToSlashInteraction(interaction, {
                    content: resolvedCtx.message,
                    ephemeral: true,
                });
                return;
            }
            const { ctx } = resolvedCtx;
            switch (interaction.commandName) {
                case "play":
                    await actions.play(ctx, interaction.options.getString("query") ?? undefined, interaction.options.getAttachment("file")?.url);
                    break;
                case "playnext":
                    await actions.playNext(ctx, interaction.options.getString("query", true));
                    break;
                case "tts":
                    await actions.tts(ctx, interaction.options.getString("text", true));
                    break;
                case "pause":
                    await actions.pause(ctx);
                    break;
                case "resume":
                    await actions.resume(ctx);
                    break;
                case "skip":
                    await actions.skip(ctx, interaction.options.getInteger("to") ?? undefined);
                    break;
                case "previous":
                    await actions.previous(ctx);
                    break;
                case "stop":
                    await actions.stop(ctx);
                    break;
                case "leave":
                    await actions.leave(ctx);
                    break;
                case "nowplaying":
                    await actions.nowPlaying(ctx);
                    break;
                case "queue":
                    await actions.queue(ctx, interaction.options.getInteger("page") ?? 1);
                    break;
                case "shuffle":
                    await actions.shuffle(ctx);
                    break;
                case "loop":
                    await actions.loop(ctx, interaction.options.getString("mode", true));
                    break;
                case "autoplay":
                    await actions.autoPlay(ctx);
                    break;
                case "seek":
                    await actions.seek(ctx, interaction.options.getString("time", true));
                    break;
                case "volume":
                    await actions.volume(ctx, interaction.options.getInteger("level") ?? undefined);
                    break;
                case "move":
                    await actions.move(ctx, interaction.options.getInteger("from", true), interaction.options.getInteger("to", true));
                    break;
                case "swap":
                    await actions.swap(ctx, interaction.options.getInteger("first", true), interaction.options.getInteger("second", true));
                    break;
                case "remove":
                    await actions.remove(ctx, interaction.options.getInteger("index", true));
                    break;
                case "clear":
                    await actions.clear(ctx);
                    break;
                case "filter":
                    await actions.filter(ctx, interaction.options.getString("action", true), interaction.options.getString("name") ?? undefined);
                    break;
                case "lyrics":
                    await actions.lyrics(ctx, interaction.options.getString("mode") ?? "show");
                    break;
                case "save":
                    await actions.save(ctx, interaction.options.getString("filter") ?? undefined);
                    break;
                case "mirror":
                    await actions.mirror(ctx, interaction.options.getString("leader_guild_id", true));
                    break;
                case "stats":
                    await actions.stats(ctx);
                    break;
                case "help":
                    await actions.help(ctx);
                    break;
                default:
                    await ctx.reply({ content: "❌ Lệnh này chưa được hỗ trợ. Vui lòng thử /help.", ephemeral: true });
                    break;
            }
        }
        catch (err) {
            console.error("[InteractionHandler] Unhandled error:", err);
            if (!interaction.isRepliable())
                return;
            const content = "❌ Đã xảy ra lỗi khi xử lý lệnh. Hãy thử lại và kiểm tra log Botkeep nếu lỗi tiếp diễn.";
            if (interaction.isChatInputCommand()) {
                // This also completes a previously deferred response instead of leaving
                // Discord displaying a permanent "thinking" indicator after an error.
                await replyToSlashInteraction(interaction, { content, ephemeral: true }).catch((replyErr) => {
                    console.error("[InteractionHandler] Failed to send error response:", replyErr);
                });
            }
            else if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
            }
        }
    });
}
//# sourceMappingURL=interactionHandler.js.map