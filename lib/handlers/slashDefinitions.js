import { ApplicationIntegrationType, ChannelType, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder, } from "discord.js";
function greetingCommand(name) {
    return new SlashCommandBuilder()
        .setName(name)
        .setDescription(name === "welcome" ? "Thiết lập chào thành viên mới kèm banner" : "Thiết lập tạm biệt thành viên kèm banner")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((cmd) => cmd.setName("set").setDescription("Bật thông báo và chọn kênh gửi")
        .addChannelOption((opt) => opt.setName("channel").setDescription("Kênh nhận thông báo").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addStringOption((opt) => opt.setName("message").setDescription("Nội dung: {user}, {name}, {server}, {count} (tùy chọn)").setMaxLength(500)))
        .addSubcommand((cmd) => cmd.setName("off").setDescription("Tắt thông báo, giữ lại cấu hình"))
        .addSubcommand((cmd) => cmd.setName("status").setDescription("Xem kênh và trạng thái hiện tại"))
        .addSubcommand((cmd) => cmd.setName("test").setDescription("Gửi thử banner vào kênh đã chọn"))
        .addSubcommand((cmd) => cmd.setName("banner").setDescription("Tải ảnh nền riêng cho server này")
        .addAttachmentOption((opt) => opt.setName("image").setDescription("Ảnh JPG, PNG hoặc WebP tối đa 3 MB").setRequired(true)))
        .addSubcommand((cmd) => cmd.setName("reset-banner").setDescription("Trở về ảnh nền mặc định"));
}
export function buildSlashCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName("play")
            .setDescription("Phát nhạc từ tên bài hát, link YouTube/SoundCloud/Spotify hoặc file đính kèm")
            .addStringOption((opt) => opt
            .setName("query")
            .setDescription("Tên bài hát, URL bài hát/playlist, hoặc tts: <nội dung>")
            .setRequired(false)
            .setAutocomplete(true))
            .addAttachmentOption((opt) => opt.setName("file").setDescription("File âm thanh đính kèm (.mp3, .wav, .ogg, .flac, .m4a)").setRequired(false)),
        new SlashCommandBuilder()
            .setName("playnext")
            .setDescription("Chèn bài hát lên đầu hàng đợi để phát ngay kế tiếp")
            .addStringOption((opt) => opt.setName("query").setDescription("Tên bài hát hoặc URL").setRequired(true).setAutocomplete(true)),
        new SlashCommandBuilder()
            .setName("tts")
            .setDescription("Đọc văn bản thành tiếng nói trong kênh thoại (Text-to-Speech ngắt thông minh)")
            .addStringOption((opt) => opt.setName("text").setDescription("Nội dung cần đọc trên kênh thoại").setRequired(true).setMaxLength(300)),
        new SlashCommandBuilder()
            .setName("247")
            .setDescription("Treo bot 24/7 trong kênh thoại, kể cả khi không phát nhạc")
            .addSubcommand((cmd) => cmd.setName("on").setDescription("Bật 24/7 trong kênh thoại bạn đang ở"))
            .addSubcommand((cmd) => cmd.setName("off").setDescription("Tắt chế độ treo 24/7"))
            .addSubcommand((cmd) => cmd.setName("status").setDescription("Xem trạng thái phòng thoại 24/7")),
        new SlashCommandBuilder()
            .setName("autoreply")
            .setDescription("Cấu hình bot tự trả lời khi nhận đúng một câu")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addSubcommand((cmd) => cmd.setName("set").setDescription("Thêm hoặc sửa câu trả lời tự động")
            .addStringOption((opt) => opt.setName("trigger").setDescription("Câu người dùng gửi").setRequired(true).setMaxLength(100))
            .addStringOption((opt) => opt.setName("reply").setDescription("Câu bot sẽ trả lời").setRequired(true).setMaxLength(2000)))
            .addSubcommand((cmd) => cmd.setName("remove").setDescription("Xóa một câu trả lời tự động")
            .addStringOption((opt) => opt.setName("trigger").setDescription("Câu kích hoạt cần xóa").setRequired(true).setMaxLength(100)))
            .addSubcommand((cmd) => cmd.setName("list").setDescription("Xem các câu trả lời tự động")),
        greetingCommand("welcome"),
        greetingCommand("goodbye"),
        new SlashCommandBuilder().setName("pause").setDescription("Tạm dừng bài hát đang phát"),
        new SlashCommandBuilder().setName("resume").setDescription("Tiếp tục phát bài hát đang tạm dừng"),
        new SlashCommandBuilder()
            .setName("skip")
            .setDescription("Bỏ qua bài hiện tại (hoặc nhảy thẳng tới vị trí bài trong hàng đợi)")
            .addIntegerOption((opt) => opt.setName("to").setDescription("Nhảy thẳng tới bài thứ N trong hàng đợi (tùy chọn)").setMinValue(1)),
        new SlashCommandBuilder().setName("previous").setDescription("Quay lại phát bài hát trước đó trong lịch sử"),
        new SlashCommandBuilder().setName("stop").setDescription("Dừng phát nhạc và xóa sạch hàng đợi"),
        new SlashCommandBuilder().setName("leave").setDescription("Ngắt kết nối và đưa bot rời khỏi kênh thoại"),
        new SlashCommandBuilder()
            .setName("nowplaying")
            .setDescription("Hiển thị bài hát đang phát, thanh tiến trình và bảng nút điều khiển"),
        new SlashCommandBuilder()
            .setName("queue")
            .setDescription("Xem danh sách bài hát trong hàng đợi")
            .addIntegerOption((opt) => opt.setName("page").setDescription("Số trang hàng đợi").setMinValue(1)),
        new SlashCommandBuilder().setName("shuffle").setDescription("Trộn ngẫu nhiên thứ tự các bài trong hàng đợi"),
        new SlashCommandBuilder()
            .setName("loop")
            .setDescription("Thiết lập chế độ lặp nhạc")
            .addStringOption((opt) => opt
            .setName("mode")
            .setDescription("Chế độ lặp")
            .setRequired(true)
            .addChoices({ name: "➡️ Tắt lặp (Off)", value: "off" }, { name: "🔂 Lặp 1 bài hiện tại (Track)", value: "track" }, { name: "🔁 Lặp toàn bộ hàng đợi (Queue)", value: "queue" })),
        new SlashCommandBuilder()
            .setName("autoplay")
            .setDescription("Bật / tắt tự động tìm và phát bài gợi ý khi hết hàng đợi"),
        new SlashCommandBuilder()
            .setName("seek")
            .setDescription("Tua bài hát đang phát đến thời điểm chỉ định")
            .addStringOption((opt) => opt.setName("time").setDescription("Mốc thời gian (ví dụ: 1:30, 90, 2m15s)").setRequired(true)),
        new SlashCommandBuilder()
            .setName("volume")
            .setDescription("Xem hoặc điều chỉnh âm lượng trình phát (0 - 100%)")
            .addIntegerOption((opt) => opt.setName("level").setDescription("Mức âm lượng từ 0 đến 100").setMinValue(0).setMaxValue(100)),
        new SlashCommandBuilder()
            .setName("move")
            .setDescription("Di chuyển vị trí 1 bài hát trong hàng đợi")
            .addIntegerOption((opt) => opt.setName("from").setDescription("Vị trí hiện tại (từ 1)").setRequired(true).setMinValue(1))
            .addIntegerOption((opt) => opt.setName("to").setDescription("Vị trí mới (từ 1)").setRequired(true).setMinValue(1)),
        new SlashCommandBuilder()
            .setName("swap")
            .setDescription("Hoán đổi vị trí 2 bài hát trong hàng đợi")
            .addIntegerOption((opt) => opt.setName("first").setDescription("Vị trí bài thứ nhất (từ 1)").setRequired(true).setMinValue(1))
            .addIntegerOption((opt) => opt.setName("second").setDescription("Vị trí bài thứ hai (từ 1)").setRequired(true).setMinValue(1)),
        new SlashCommandBuilder()
            .setName("remove")
            .setDescription("Xóa 1 bài hát khỏi hàng đợi theo số thứ tự")
            .addIntegerOption((opt) => opt.setName("index").setDescription("Số thứ tự bài hát (từ 1)").setRequired(true).setMinValue(1)),
        new SlashCommandBuilder().setName("clear").setDescription("Xóa toàn bộ các bài đang chờ (giữ nguyên bài đang phát)"),
        new SlashCommandBuilder()
            .setName("filter")
            .setDescription("Quản lý 36 hiệu ứng âm thanh FFmpeg thời gian thực (Bassboost, Nightcore, 8D...)")
            .addStringOption((opt) => opt
            .setName("action")
            .setDescription("Thao tác bộ lọc")
            .setRequired(true)
            .addChoices({ name: "🎛️ Bật / Áp dụng hiệu ứng (Apply)", value: "apply" }, { name: "➖ Gỡ 1 hiệu ứng (Remove)", value: "remove" }, { name: "🧹 Tắt toàn bộ hiệu ứng (Clear)", value: "clear" }, { name: "📋 Xem danh sách 36 hiệu ứng (List)", value: "list" }))
            .addStringOption((opt) => opt
            .setName("name")
            .setDescription("Tên hiệu ứng (bắt buộc khi chọn Apply hoặc Remove)")
            .setRequired(false)
            .setAutocomplete(true)),
        new SlashCommandBuilder()
            .setName("lyrics")
            .setDescription("Xem lời bài hát hiện tại hoặc bật/tắt chế độ Karaoke Live nhảy chữ")
            .addStringOption((opt) => opt
            .setName("mode")
            .setDescription("Chế độ hiển thị lời bài hát")
            .setRequired(false)
            .addChoices({ name: "📜 Hiển thị toàn bộ lời bài hát (Show)", value: "show" }, { name: "🎤 Bật / Tắt Karaoke nhảy chữ theo nhạc (Live)", value: "live" })),
        new SlashCommandBuilder()
            .setName("save")
            .setDescription("Xuất và tải bài hát đang phát thành file MP3 gửi vào kênh chat")
            .addStringOption((opt) => opt
            .setName("filter")
            .setDescription("Áp dụng thêm hiệu ứng FFmpeg khi xuất MP3 (tùy chọn)")
            .setRequired(false)
            .setAutocomplete(true)),
        new SlashCommandBuilder()
            .setName("mirror")
            .setDescription("Đồng bộ luồng nhạc thời gian thực từ 1 Server chính (Subscribe Forward Mirror)")
            .addStringOption((opt) => opt
            .setName("leader_guild_id")
            .setDescription("Nhập Guild ID của Server phát chính, hoặc gõ 'off' để ngắt đồng bộ")
            .setRequired(true)),
        new SlashCommandBuilder().setName("stats").setDescription("Xem thông số hoạt động của Bot & ZiPlayer Engine"),
        new SlashCommandBuilder().setName("help").setDescription("Xem danh sách đầy đủ các lệnh và tính năng của Bot"),
    ];
    return commands.map((c) => c
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
        .setContexts(InteractionContextType.Guild)
        .toJSON());
}
//# sourceMappingURL=slashDefinitions.js.map