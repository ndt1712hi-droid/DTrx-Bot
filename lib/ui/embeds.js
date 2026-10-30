import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, } from "discord.js";
import { PREDEFINED_FILTERS } from "ziplayer";
import { getPlaybackFallback } from "../core/streamProvenance.js";
import { formatDuration, formatLoopMode, formatSourceBadge, truncate } from "../utils/format.js";
export const COLORS = {
    PRIMARY: 0x5865f2,
    PLAYING: 0x57f287,
    PAUSED: 0xfee75c,
    LYRICS: 0xeb459e,
    WARNING: 0xfaa61a,
    ERROR: 0xed4245,
    INFO: 0x00b0f4,
};
export const CONTROL_IDS = {
    PREV: "zi:prev",
    TOGGLE: "zi:toggle",
    SKIP: "zi:skip",
    STOP: "zi:stop",
    LOOP: "zi:loop",
    SHUFFLE: "zi:shuffle",
    AUTOPLAY: "zi:autoplay",
    VOLDOWN: "zi:voldown",
    VOLUP: "zi:volup",
    LYRICS: "zi:lyrics",
    FILTER_SELECT: "zi:filter_select",
};
const FEATURED_FILTER_KEYS = [
    "bassboost",
    "nightcore",
    "8D",
    "lofi",
    "vaporwave",
    "karaoke",
    "reverb",
    "echo",
    "trebleboost",
    "chorus",
    "slow",
    "fast",
    "normalize",
    "compressor",
];
function isValidHttpUrl(url) {
    if (!url)
        return false;
    return /^https?:\/\/\S+$/i.test(url);
}
function formatRequester(requestedBy) {
    if (!requestedBy || requestedBy === "unknown" || requestedBy === "autoplay") {
        return requestedBy === "autoplay" ? "♾️ Autoplay" : "Hệ thống";
    }
    return /^\d{15,22}$/.test(requestedBy) ? `<@${requestedBy}>` : truncate(requestedBy, 40);
}
/**
 * Builds the interactive "Now Playing" controller message payload (Embed + 3 ActionRows).
 */
export function buildNowPlayingPayload(player, disabled = false) {
    const track = player.currentTrack;
    const userdata = (player.userdata ?? {});
    const activeFilters = player.filter.getActiveFilters().map((f) => f.name);
    const loopMode = player.queue.getLoopMode();
    const autoPlay = player.autoPlay();
    const isPaused = player.isPaused;
    const liveLyrics = Boolean(userdata.liveLyricsEnabled);
    const embed = new EmbedBuilder()
        .setColor(disabled ? COLORS.INFO : isPaused ? COLORS.PAUSED : COLORS.PLAYING)
        .setAuthor({
        name: disabled ? "⏹️ Phiên phát nhạc đã kết thúc" : isPaused ? "⏸️ Đang tạm dừng" : "🎶 Đang phát nhạc • ZiPlayer",
    });
    if (track) {
        const title = truncate(track.title || "Bài hát không tên", 240);
        if (isValidHttpUrl(track.url)) {
            embed.setTitle(title).setURL(track.url);
        }
        else {
            embed.setTitle(title);
        }
        if (isValidHttpUrl(track.thumbnail)) {
            embed.setThumbnail(track.thumbnail);
        }
        const progress = disabled
            ? "`────────────────────` 00:00"
            : player.getProgressBar({
                size: 18,
                barChar: "─",
                progressChar: "🔘",
                timeFormat: "compact",
                showPercentage: true,
            });
        const nextTrack = player.queue.nextTrack;
        const fallback = getPlaybackFallback(player, track);
        const descriptionLines = [
            track.author ? `👤 **Nghệ sĩ / Kênh:** ${truncate(track.author, 100)}` : null,
            `📡 **Nguồn yêu cầu:** ${formatSourceBadge(track.source)} • ⏱️ **Thời lượng:** \`${formatDuration(track.duration, track.isLive)}\``,
            fallback ? `⚠️ **Bản dự phòng:** ${truncate(fallback.title, 120)} — ${formatSourceBadge(fallback.source)} (có thể khác phiên bản)` : null,
            `🙋 **Yêu cầu bởi:** ${formatRequester(track.requestedBy)}`,
            "",
            `${progress}`,
        ].filter(Boolean);
        embed.setDescription(descriptionLines.join("\n"));
        embed.addFields({
            name: "🔊 Âm lượng",
            value: `\`${player.volume}%\``,
            inline: true,
        }, {
            name: "🔁 Chế độ lặp",
            value: formatLoopMode(loopMode),
            inline: true,
        }, {
            name: "♾️ Autoplay",
            value: autoPlay ? "`Bật`" : "`Tắt`",
            inline: true,
        }, {
            name: "🎛️ Bộ lọc (Filters)",
            value: activeFilters.length > 0 ? activeFilters.map((f) => `\`${f}\``).join(", ") : "`Mặc định`",
            inline: true,
        }, {
            name: "📋 Hàng đợi",
            value: `\`${player.queueSize}\` bài chờ`,
            inline: true,
        }, {
            name: "⏭️ Tiếp theo",
            value: nextTrack ? truncate(nextTrack.title, 60) : autoPlay ? "*Tự động gợi ý*" : "*Trống*",
            inline: true,
        });
    }
    else {
        embed.setDescription("Hiện không có bài hát nào đang phát.");
    }
    embed.setFooter({
        text: `ZiPlayer Engine • Karaoke Live: ${liveLyrics ? "BẬT" : "TẮT"}`,
    });
    embed.setTimestamp();
    // Row 1: Primary Playback Controls
    const row1 = new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(CONTROL_IDS.PREV)
        .setEmoji("⏮️")
        .setLabel("Trước")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || player.previousTracks.length === 0), new ButtonBuilder()
        .setCustomId(CONTROL_IDS.TOGGLE)
        .setEmoji(isPaused ? "▶️" : "⏸️")
        .setLabel(isPaused ? "Tiếp tục" : "Tạm dừng")
        .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary)
        .setDisabled(disabled), new ButtonBuilder()
        .setCustomId(CONTROL_IDS.SKIP)
        .setEmoji("⏭️")
        .setLabel("Bỏ qua")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled), new ButtonBuilder()
        .setCustomId(CONTROL_IDS.STOP)
        .setEmoji("⏹️")
        .setLabel("Dừng")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled), new ButtonBuilder()
        .setCustomId(CONTROL_IDS.LOOP)
        .setEmoji(loopMode === "track" ? "🔂" : "🔁")
        .setLabel(loopMode === "off" ? "Lặp: Tắt" : loopMode === "track" ? "Lặp: Bài" : "Lặp: Queue")
        .setStyle(loopMode === "off" ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(disabled));
    // Row 2: Queue, Volume & Lyrics Controls
    const row2 = new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(CONTROL_IDS.SHUFFLE)
        .setEmoji("🔀")
        .setLabel("Trộn bài")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || player.queueSize < 2), new ButtonBuilder()
        .setCustomId(CONTROL_IDS.AUTOPLAY)
        .setEmoji("♾️")
        .setLabel(autoPlay ? "Auto: Bật" : "Auto: Tắt")
        .setStyle(autoPlay ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(disabled), new ButtonBuilder()
        .setCustomId(CONTROL_IDS.VOLDOWN)
        .setEmoji("🔉")
        .setLabel("-10%")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || player.volume <= 0), new ButtonBuilder()
        .setCustomId(CONTROL_IDS.VOLUP)
        .setEmoji("🔊")
        .setLabel("+10%")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || player.volume >= 100), new ButtonBuilder()
        .setCustomId(CONTROL_IDS.LYRICS)
        .setEmoji("📜")
        .setLabel(liveLyrics ? "Lyrics: Live" : "Lyrics")
        .setStyle(liveLyrics ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(disabled));
    // Row 3: Quick Audio Filter Select Menu
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(CONTROL_IDS.FILTER_SELECT)
        .setPlaceholder(activeFilters.length > 0
        ? `🎛️ Đang bật: ${truncate(activeFilters.join(", "), 70)}`
        : "🎛️ Chọn hiệu ứng âm thanh (Bassboost, Nightcore, 8D...)")
        .setDisabled(disabled)
        .addOptions(new StringSelectMenuOptionBuilder()
        .setLabel("Tắt toàn bộ hiệu ứng (Clear Filters)")
        .setValue("clear")
        .setDescription("Khôi phục âm thanh gốc không qua bộ lọc")
        .setEmoji("🧹"), ...FEATURED_FILTER_KEYS.filter((key) => key in PREDEFINED_FILTERS).map((key) => {
        const def = PREDEFINED_FILTERS[key];
        const isActive = activeFilters.includes(key);
        return new StringSelectMenuOptionBuilder()
            .setLabel(`${isActive ? "✅ " : ""}${def.name} (${def.description})`)
            .setValue(key)
            .setDescription(truncate(`FFmpeg [${def.category ?? "fx"}]: ${def.ffmpegFilter}`, 95))
            .setEmoji(isActive ? "🟢" : "🎚️");
    }));
    const row3 = new ActionRowBuilder().addComponents(selectMenu);
    return {
        embeds: [embed],
        components: [row1, row2, row3],
    };
}
/**
 * Builds a paginated queue Embed.
 */
export function buildQueueEmbed(player, requestedPage = 1) {
    const current = player.currentTrack;
    const upcoming = player.upcomingTracks;
    const perPage = 10;
    const totalPages = Math.max(1, Math.ceil(upcoming.length / perPage));
    const page = Math.min(totalPages, Math.max(1, requestedPage));
    const start = (page - 1) * perPage;
    const slice = upcoming.slice(start, start + perPage);
    const totalDurationMs = upcoming.reduce((acc, t) => acc + (t.isLive ? 0 : Math.max(0, t.duration || 0)), 0);
    const embed = new EmbedBuilder()
        .setColor(COLORS.PRIMARY)
        .setTitle(`📋 Hàng đợi phát nhạc (${upcoming.length} bài chờ)`)
        .setTimestamp();
    const lines = [];
    if (current) {
        const fallback = getPlaybackFallback(player, current);
        lines.push(`**🎶 Đang phát:**`, `[${truncate(current.title, 70)}](${isValidHttpUrl(current.url) ? current.url : "https://discord.com"}) — \`${formatDuration(current.duration, current.isLive)}\` • ${formatRequester(current.requestedBy)}`);
        if (fallback)
            lines.push(`⚠️ Bản dự phòng: ${truncate(fallback.title, 100)} — ${formatSourceBadge(fallback.source)} (có thể khác phiên bản)`);
        lines.push(`${player.getProgressBar({ size: 16, showPercentage: true })}`, "");
    }
    if (slice.length > 0) {
        lines.push(`**⏭️ Danh sách tiếp theo (Trang ${page}/${totalPages}):**`);
        for (const [idx, t] of slice.entries()) {
            const pos = start + idx + 1;
            const titleLink = isValidHttpUrl(t.url) ? `[${truncate(t.title, 58)}](${t.url})` : `**${truncate(t.title, 58)}**`;
            lines.push(`\`${String(pos).padStart(2, "0")}.\` ${titleLink} — \`${formatDuration(t.duration, t.isLive)}\` • ${formatRequester(t.requestedBy)}`);
        }
    }
    else {
        lines.push("*Hàng đợi tiếp theo đang trống. Dùng `/play` để thêm bài hoặc bật `/autoplay`!*");
    }
    embed.setDescription(lines.join("\n"));
    embed.setFooter({
        text: `Trang ${page}/${totalPages} • Tổng thời lượng chờ: ${formatDuration(totalDurationMs)} • Lặp: ${player.queue.getLoopMode()} • Autoplay: ${player.autoPlay() ? "Bật" : "Tắt"}`,
    });
    return embed;
}
/**
 * Builds full static lyrics Embed.
 */
export function buildFullLyricsEmbed(track, lyrics) {
    const rawText = (lyrics.text || lyrics.synced || "").trim();
    const body = rawText ? truncate(rawText, 3900) : "*Không tìm thấy nội dung lời bài hát.*";
    const embed = new EmbedBuilder()
        .setColor(COLORS.LYRICS)
        .setTitle(`📜 Lời bài hát: ${truncate(lyrics.trackName || track.title, 200)}`)
        .setDescription(body)
        .setFooter({
        text: `Nguồn: ${lyrics.provider.toUpperCase()}${lyrics.artistName ? ` • Nghệ sĩ: ${lyrics.artistName}` : ""}${lyrics.synced ? " • Hỗ trợ Karaoke đồng bộ" : ""}`,
    })
        .setTimestamp();
    if (isValidHttpUrl(track.thumbnail)) {
        embed.setThumbnail(track.thumbnail);
    }
    return embed;
}
/**
 * Builds real-time karaoke synced 3-line lyrics Embed.
 */
export function buildLiveLyricsEmbed(track, lyrics) {
    const lines = [
        lyrics.previous ? `-# ${truncate(lyrics.previous, 180)}` : "-# ♪ ...",
        `### 🎤 ${truncate(lyrics.current || "♪ ...", 220)}`,
        lyrics.next ? `-# ${truncate(lyrics.next, 180)}` : "-# ...",
    ];
    return new EmbedBuilder()
        .setColor(COLORS.LYRICS)
        .setAuthor({
        name: `🎤 Karaoke Live • ${truncate(track.title, 180)}`,
    })
        .setDescription(lines.join("\n\n"))
        .setFooter({
        text: `Nguồn: ${lyrics.provider.toUpperCase()} • Bấm nút [Lyrics: Live] hoặc gõ /lyrics live để tắt`,
    });
}
/**
 * Builds bot & ZiPlayer telemetry Embed.
 */
export function buildStatsEmbed(manager, client) {
    const stats = manager.getStats();
    const memMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
    const uptimeSec = Math.floor(process.uptime());
    const plugins = manager.getPlugins().map((p) => `\`${p.name}@${p.version}\``);
    return new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle("📊 Trạng thái Hệ thống ZiPlayer Bot")
        .addFields({
        name: "🤖 Discord Client",
        value: [
            `• Ping WS: \`${Math.round(client.ws.ping)}ms\``,
            `• Servers: \`${client.guilds.cache.size}\``,
            `• Uptime: \`${formatDuration(uptimeSec * 1000)}\``,
            `• RAM (RSS): \`${memMb} MB\``,
        ].join("\n"),
        inline: true,
    }, {
        name: "🎵 ZiPlayer Manager",
        value: [
            `• Tổng Players: \`${stats.totalPlayers}\``,
            `• Đang phát: \`${stats.activePlayers}\``,
            `• Tạm dừng: \`${stats.pausedPlayers}\``,
            `• Tổng bài chờ: \`${stats.totalTracksInQueue}\``,
        ].join("\n"),
        inline: true,
    }, {
        name: "🔌 Plugins đang hoạt động",
        value: plugins.length > 0 ? plugins.join(", ") : "`Không có`",
        inline: false,
    }, {
        name: "🎛️ Kho hiệu ứng FFmpeg",
        value: `Hỗ trợ **${Object.keys(PREDEFINED_FILTERS).length}** bộ lọc thời gian thực (Crossfade, Anti-Stuck 2.0, LUFS Normalization, Preload)`,
        inline: false,
    })
        .setTimestamp();
}
/**
 * Builds the comprehensive Help Embed covering Slash, Prefix, TTS, Filters, and Buttons.
 */
export function buildHelpEmbed(prefix) {
    return new EmbedBuilder()
        .setColor(COLORS.PRIMARY)
        .setTitle("🎧 Hướng dẫn sử dụng ZiPlayer Music Bot")
        .setDescription(`Bot hỗ trợ song song **Slash Commands (\`/...\`)**, **Prefix Commands (\`${prefix}...\`)** và **Bảng nút bấm trực quan**.`)
        .addFields({
        name: "▶️ Phát nhạc & Nguồn phát",
        value: [
            `\`/play <tên/link>\` hoặc \`${prefix}play <tên/link>\` — Phát nhạc từ **YouTube, SoundCloud, Spotify, Link MP3** hoặc đính kèm file nhạc`,
            `\`/playnext <tên/link>\` hoặc \`${prefix}playnext\` — Chèn bài hát phát ngay kế tiếp`,
            `\`/tts <văn bản>\` hoặc \`${prefix}tts <văn bản>\` — Đọc giọng nói Tiếng Việt/Anh trên kênh thoại (chế độ ngắt thông minh)`,
            `\`/247 on\` — Treo bot trong phòng thoại; \`/247 off\` — tắt; \`/247 status\` — xem trạng thái`,
            `\`/autoreply set\`, \`/autoreply remove\`, \`/autoreply list\` — Quản trị viên cấu hình trả lời tự động`,
        ].join("\n"),
    }, {
        name: "⏯️ Điều khiển trình phát",
        value: [
            `\`/pause\`, \`/resume\`, \`/skip [vị trí]\`, \`/previous\`, \`/stop\`, \`/leave\``,
            `\`/seek <thời gian>\` — Tua đến mốc thời gian (VD: \`1:30\`, \`90\`, \`2m15s\`)`,
            `\`/volume <0-100>\` — Chỉnh âm lượng (có cân bằng âm lượng LUFS chống vỡ tiếng)`,
            `\`/nowplaying\` (\`${prefix}np\`) — Mở lại bảng điều khiển & thanh tiến trình`,
        ].join("\n"),
    }, {
        name: "📋 Quản lý hàng đợi (Queue)",
        value: [
            `\`/queue [trang]\` (\`${prefix}q\`) — Xem danh sách chờ`,
            `\`/shuffle\`, \`/loop <off|track|queue>\`, \`/autoplay\``,
            `\`/move <từ> <đến>\`, \`/swap <a> <b>\`, \`/remove <vị trí>\`, \`/clear\``,
        ].join("\n"),
    }, {
        name: "🎛️ Hiệu ứng, Lyrics, Lưu MP3 & Đồng bộ",
        value: [
            `\`/filter <apply|remove|clear|list> [tên]\` — Áp dụng **36 hiệu ứng FFmpeg** (\`bassboost\`, \`nightcore\`, \`8D\`, \`lofi\`, \`karaoke\`...)`,
            `\`/lyrics [show|live]\` — Xem toàn bộ lời bài hát hoặc bật **Karaoke Live** nhảy từng câu theo nhạc`,
            `\`/save [filter]\` — Tải bài đang phát thành file \`.mp3\` gửi thẳng vào kênh chat`,
            `\`/mirror <leaderGuildId|off>\` — Đồng bộ luồng nhạc thời gian thực giữa nhiều Server`,
            `\`/stats\` — Xem thông số hệ thống & ZiPlayer Engine`,
        ].join("\n"),
    })
        .setFooter({
        text: `Mẹo: Gõ ${prefix}play tts: Xin chào anh em — hoặc dùng menu chọn Filter ngay dưới thẻ nhạc!`,
    });
}
//# sourceMappingURL=embeds.js.map