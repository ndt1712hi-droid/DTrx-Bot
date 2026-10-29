# 🎵 ZiPlayer Discord Music Bot

Bot nghe nhạc Discord đa năng, hiệu năng cao được xây dựng hoàn chỉnh trên hệ sinh thái **[ZiProject/ZiPlayer](https://github.com/ZiProject/ZiPlayer)** (`ziplayer`, `@ziplayer/plugin`, `@ziplayer/extension`, `@discordjs/voice` & `discord.js` v14).

---

## ✨ Tính năng nổi bật

- 🌐 **Đa nguồn phát (`@ziplayer/plugin`)**:
  - **YouTube & YouTube Music** (Video, Playlist, Mix, Search & Related Autoplay)
  - **SoundCloud** (Track, Set/Playlist, Search)
  - **Spotify** (Track, Album, Playlist — tự động fallback luồng âm thanh mượt mà)
  - **TTS (`TTSPlugin`)** — Đọc văn bản thành tiếng nói Tiếng Việt / Tiếng Anh trên kênh thoại với **Interrupt Mode** (tự giảm/tạm ngắt nhạc để đọc rồi phát tiếp)
  - **Attachments (`AttachmentsPlugin`)** — Phát trực tiếp file `.mp3`, `.wav`, `.ogg`, `.flac`, `.m4a` đính kèm trong tin nhắn hoặc link audio trực tiếp
- 🎛️ **36 Hiệu ứng Âm thanh FFmpeg thời gian thực**:
  - `bassboost`, `nightcore`, `8D`, `lofi`, `vaporwave`, `karaoke`, `reverb`, `echo`, `trebleboost`, `chorus`, `slow`, `fast`, `normalize`, `compressor`... (tích hợp sẵn `ffmpeg-static`, không cần cài FFmpeg thủ công trên máy).
- 🧠 **Công nghệ Âm thanh thế hệ mới của ZiPlayer**:
  - **Preload** (tải trước bài kế tiếp giảm độ trễ chuyển bài về 0)
  - **Crossfade & Smart Transition Engine** (chuyển bài mượt theo thể loại & nhịp BPM)
  - **Anti-Stuck Recovery 2.0** (tự động khôi phục khi nghẽn mạng / lỗi luồng mà không skip loạn)
  - **LUFS Loudness Normalization** (cân bằng âm lượng giữa các bài, chống giật mình / vỡ tiếng)
- 🧩 **Extensions cao cấp (`@ziplayer/extension`)**:
  - **Lyrics & Karaoke Live (`lyricsExt`)** — Tự động lấy lời bài hát từ LRCLIB / Lyrics.ovh và nhảy chữ đồng bộ theo từng câu hát.
  - **Voice Commands STT (`voiceExt`)** — Điều khiển bot bằng giọng nói Tiếng Việt / Anh ngay trong kênh thoại (`"zi phát ..."`, `"bot bỏ qua"`, `"zi âm lượng 80"`).
  - **AI Autoplay (`AiAutoplayExtension`)** — Gợi ý nhạc theo gu bằng Gemini khi cấu hình `GEMINI_API_KEY`.
  - **Lavalink (`lavalinkExt`)** — Hỗ trợ kết nối Lavalink Nodes ngoài khi cấu hình `LAVALINK_NODES`.
- 🎮 **3 phương thức điều khiển song song**:
  - **27 Slash Commands (`/play`, `/filter`...)** có **Autocomplete tìm kiếm bài hát & bộ lọc trực tiếp**.
  - **Prefix Commands (`!play`, `!skip`, `!np`...)** nhanh gọn.
  - **Bảng điều khiển Nút bấm & Menu chọn Filter (Interactive Controller)** tự động cập nhật trạng thái và bảo vệ quyền điều khiển theo kênh thoại.
- 💾 **Tự động lưu & khôi phục phiên phát (`SessionPersistence`)**: Lưu hàng đợi định kỳ và khi tắt bot, tự động vào lại phòng phát tiếp khi bot khởi động lại.
- 📥 **Xuất file MP3 trực tiếp (`/save`)**: Chuyển đổi bài đang phát (kèm hiệu ứng FFmpeg tùy chọn) thành file `.mp3` gửi thẳng vào kênh chat.
- 📡 **Multi-Server Forward Mirror (`/mirror`)**: Đồng bộ luồng phát âm thanh trực tiếp từ một Server chính sang các Server phụ với mức tốn CPU cực thấp.

---

## 🚀 Hướng dẫn cài đặt & chạy nhanh

### 1. Chuẩn bị Bot trên Discord Developer Portal
1. Truy cập [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. Vào mục **Bot**:
   - Nhấn **Reset Token** để lấy `DISCORD_TOKEN`.
   - Bật **Message Content Intent** và **Server Members Intent** trong phần *Privileged Gateway Intents* → **Save Changes**.
3. Vào mục **OAuth2 → URL Generator**:
   - Chọn Scopes: `bot`, `applications.commands`.
   - Chọn Bot Permissions: `View Channels`, `Send Messages`, `Embed Links`, `Attach Files`, `Connect`, `Speak`, `Use Voice Activity`.
   - Mở URL tạo ra để mời Bot vào Server của bạn.

### 2. Cấu hình biến môi trường
Sao chép file `.env.example` thành `.env` và điền Token của bạn:

```bash
cp .env.example .env
```

Tối thiểu bạn chỉ cần điền `DISCORD_TOKEN` trong `.env` (Bot sẽ tự nhận diện `CLIENT_ID` và đăng ký toàn bộ 27 Slash Commands khi khởi động nếu `AUTO_DEPLOY_COMMANDS=true`):

```env
DISCORD_TOKEN=your_discord_bot_token_here
# Tùy chọn: điền ID Server test để Slash Commands cập nhật ngay lập tức
DISCORD_GUILD_ID=
```

### 3. Cài đặt & Khởi chạy

```bash
# Cài đặt thư viện
npm install

# Biên dịch TypeScript sang thư mục lib/
npm run build

# Khởi động Bot (Production)
npm start

# Hoặc chạy chế độ tự động reload khi sửa code (Development)
npm run dev
```

*(Tùy chọn)* Chạy bằng **Docker**:
```bash
docker build -t ziplayer-bot .
docker run -d --name ziplayer-bot --env-file .env --restart unless-stopped ziplayer-bot
```

---

## 📋 Danh sách Lệnh (Slash & Prefix)

| Lệnh Slash | Lệnh Prefix (`!`) | Mô tả |
| :--- | :--- | :--- |
| `/play [query] [file]` | `!play`, `!p` | Phát nhạc theo tên, URL (YT/SC/Spotify/MP3) hoặc file đính kèm |
| `/playnext <query>` | `!playnext`, `!pn` | Chèn bài hát lên đầu hàng đợi (phát ngay kế tiếp) |
| `/tts <text>` | `!tts`, `!say` | Đọc văn bản thành tiếng nói trong kênh thoại |
| `/247 on`, `/247 off`, `/247 status` | `!247 on`, `!247 off`, `!247 status` | Treo bot trong phòng thoại, tắt chế độ 24/7 hoặc xem trạng thái |
| `/pause` / `/resume` | `!pause` / `!resume` | Tạm dừng / Tiếp tục phát nhạc |
| `/skip [to]` | `!skip [vị trí]`, `!s` | Bỏ qua bài hiện tại hoặc nhảy thẳng tới bài thứ `N` |
| `/previous` | `!prev`, `!back` | Quay lại phát bài trước đó trong lịch sử |
| `/seek <time>` | `!seek <1:30 \| 90s>` | Tua bài hát tới mốc thời gian |
| `/volume [level]` | `!volume [0-100]`, `!v` | Xem hoặc chỉnh âm lượng (0 - 100%) |
| `/nowplaying` | `!np`, `!status` | Làm mới thẻ điều khiển Đang phát & thanh tiến trình |
| `/queue [page]` | `!queue`, `!q` | Xem danh sách hàng đợi phân trang |
| `/shuffle` | `!shuffle`, `!mix` | Trộn ngẫu nhiên hàng đợi |
| `/loop <mode>` | `!loop <off\|track\|queue>` | Chuyển chế độ lặp (Tắt / 1 bài / Hàng đợi) |
| `/autoplay` | `!autoplay`, `!ap` | Bật / tắt tự động phát bài gợi ý liên quan |
| `/move <from> <to>` | `!move <từ> <đến>` | Di chuyển vị trí bài hát trong hàng đợi |
| `/swap <first> <second>` | `!swap <a> <b>` | Hoán đổi vị trí 2 bài hát trong hàng đợi |
| `/remove <index>` | `!remove <vị trí>`, `!rm` | Xóa 1 bài khỏi hàng đợi |
| `/clear` | `!clear` | Xóa toàn bộ danh sách chờ |
| `/filter <action> [name]` | `!filter <tên\|list\|off>` | Bật/gỡ/xem 36 hiệu ứng FFmpeg (`bassboost`, `nightcore`, `8D`...) |
| `/lyrics [show\|live]` | `!lyrics [show\|live]` | Xem toàn bộ lời bài hát hoặc bật/tắt Karaoke Live nhảy chữ |
| `/save [filter]` | `!save [filter]` | Xuất bài đang phát thành file `.mp3` gửi vào kênh chat |
| `/mirror <leader_id\|off>` | `!mirror <id\|off>` | Đồng bộ luồng nhạc thời gian thực từ Server chính |
| `/stats` / `/help` | `!stats` / `!help` | Xem thông số ZiPlayer Engine & bảng hướng dẫn |

### Treo bot trong phòng thoại 24/7

1. Vào phòng thoại muốn treo bot, sau đó dùng `/247 on`.
2. Bot ở lại khi hết nhạc hoặc không còn người; nếu kết nối bị ngắt, bot sẽ thử vào lại. Khi bot khởi động lại, bot đọc phòng đã lưu và kết nối lại.
3. Dùng `/247 status` để xem trạng thái; `/247 off` để tắt chế độ treo. `/leave` tắt 24/7 và cho bot rời ngay.

Nếu dùng lệnh tin nhắn, có thể dùng `!247 on`, `!247 off`, `!247 status` hoặc `@Bot 247 on`.

Cấu hình phòng được lưu tại `data/voice-24-7.json` (cùng thư mục với `PERSISTENCE_FILE`), độc lập với hàng đợi. Nếu `PERSISTENCE_FILE` trùng tên `voice-24-7.json`, cấu hình phòng được lưu vào `voice-24-7.json.rooms.json` để tránh ghi đè. Để khôi phục sau khi triển khai lại, host phải giữ thư mục này qua các lần redeploy; nếu dữ liệu bị xóa, cần bật `/247 on` lại. Bot chỉ có thể online liên tục khi host đang chạy và kết nối Discord hoạt động.

---

## 🗂️ Cấu trúc dự án

```text
├── src/
│   ├── index.ts                     # Điểm khởi chạy chính & quản lý vòng đời tiến trình
│   ├── config.ts                    # Đọc cấu hình .env & tự động ánh xạ FFmpeg binary
│   ├── deploy-commands.ts           # Đăng ký 27 Slash Commands lên Discord API
│   ├── core/
│   │   ├── musicEngine.ts           # Quản lý ZiPlayer, Plugins, Extensions & Discord Events
│   │   ├── persistence.ts           # Tự động lưu & khôi phục phiên nhạc qua JSON nguyên tử
│   │   ├── alwaysOnStore.ts         # Lưu phòng thoại 24/7 riêng cho từng server
│   │   └── exporter.ts              # Xuất luồng nhạc ZiPlayer sang MP3 qua FFmpeg
│   ├── handlers/
│   │   ├── slashDefinitions.ts      # Định nghĩa cấu trúc 27 Slash Commands
│   │   ├── musicActions.ts          # Xử lý nghiệp vụ thống nhất & kiểm tra quyền kênh thoại
│   │   ├── interactionHandler.ts    # Xử lý Slash, Autocomplete, Nút bấm & Select Menu
│   │   └── prefixHandler.ts         # Xử lý lệnh Prefix văn bản (!play, !skip...)
│   ├── ui/
│   │   └── embeds.ts                # Thiết kế Discord Embeds & Bảng điều khiển trực quan
│   ├── utils/
│   │   └── format.ts                # Phân tích thời gian, giọng nói (Wake-word) & định dạng
│   ├── types/
│   │   └── bot.ts                   # Khai báo kiểu dữ liệu TypeScript
│   └── tests/
│       └── bot.test.ts              # Bộ kiểm thử tự động toàn diện (Node Test Runner)
├── lib/                             # Mã JavaScript đã biên dịch sẵn sàng chạy Production
├── .env.example                     # Mẫu cấu hình biến môi trường đầy đủ
├── Dockerfile                       # Cấu hình đóng gói Container
└── package.json
```

---

## 🧪 Kiểm thử chất lượng

```bash
npm run typecheck
npm test
```
