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
  - **33 Slash Commands (`/play`, `/filter`...)** có **Autocomplete tìm kiếm bài hát & bộ lọc trực tiếp**.
  - **Prefix Commands (`!play`, `!skip`, `!np`...)** nhanh gọn.
  - **Bảng điều khiển Nút bấm & Menu chọn Filter (Interactive Controller)** tự động cập nhật trạng thái và bảo vệ quyền điều khiển theo kênh thoại.
- 👋 **Welcome / Goodbye:** Chọn kênh và nội dung riêng cho từng server; banner cá nhân hóa tên, avatar, tên server và số thành viên; tự tải nền riêng qua Discord.
- 🔒 **Khóa kênh chữ:** `/lock` chặn nhắn tin và chủ đề của @everyone; `/unlock` khôi phục các quyền trước đó.
- 🔔 **Nhắc tag có giới hạn:** `/spam` chọn một người, bắt đầu ngay với giới hạn và có lệnh dừng, xóa cấu hình hoặc dọn tin bot.
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

Tối thiểu bạn chỉ cần điền `DISCORD_TOKEN` trong `.env` (Bot sẽ tự nhận diện `CLIENT_ID` và đăng ký toàn bộ 33 Slash Commands khi khởi động nếu `AUTO_DEPLOY_COMMANDS=true`):

```env
DISCORD_TOKEN=your_discord_bot_token_here
# Tùy chọn: điền ID Server test để Slash Commands cập nhật ngay lập tức
DISCORD_GUILD_ID=
```

### 3. Cài đặt & Khởi chạy

Cần **Node.js 22.12 trở lên** (khuyến nghị Node 22 LTS hoặc mới hơn); thư viện Discord voice hiện không hỗ trợ Node 20. Trên Botkeep, chọn Node 22 hoặc 24. Nếu dùng GitHub, vào tab **GitHub** của server để cập nhật/pull nhánh `main` trước, rồi redeploy/restart; theo [Botkeep FAQ](https://botkeep.cloud/faq), chỉ Redeploy không tự lấy commit GitHub mới. Giữ thư mục `data/` khi cập nhật để không mất cấu hình 24/7, auto-reply và welcome/goodbye.

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
docker run -d --name ziplayer-bot --env-file .env -v "$(pwd)/data:/app/data" --restart unless-stopped ziplayer-bot
```

---

## 📋 Danh sách Lệnh (Slash & Prefix)

| Lệnh Slash | Lệnh Prefix (`!`) | Mô tả |
| :--- | :--- | :--- |
| `/play [query] [file]` | `!play`, `!p` | Phát nhạc theo tên, URL (YT/SC/Spotify/MP3) hoặc file đính kèm |
| `/playnext <query>` | `!playnext`, `!pn` | Chèn bài hát lên đầu hàng đợi (phát ngay kế tiếp) |
| `/tts <text>` | `!tts`, `!say` | Đọc văn bản thành tiếng nói trong kênh thoại |
| `/247 on`, `/247 off`, `/247 status` | `!247 on`, `!247 off`, `!247 status` | Treo bot trong phòng thoại, tắt chế độ 24/7 hoặc xem trạng thái |
| `/autoreply set`, `/autoreply remove`, `/autoreply list` | — | Quản trị viên thêm, xóa, xem câu trả lời tự động |
| `/welcome set`, `/welcome test`, `/welcome status`, `/welcome off` | — | Cài đặt và thử chào thành viên kèm banner |
| `/welcome banner`, `/welcome reset-banner` | — | Tải ảnh nền welcome hoặc khôi phục nền mặc định |
| `/goodbye set`, `/goodbye test`, `/goodbye status`, `/goodbye off` | — | Cài đặt và thử thông báo tạm biệt kèm banner |
| `/goodbye banner`, `/goodbye reset-banner` | — | Tải ảnh nền goodbye hoặc khôi phục nền mặc định |
| `/lock [channel]`, `/unlock [channel]` | — | Khóa kênh chữ cho @everyone hoặc khôi phục quyền trước khi khóa |
| `/spam set`, `/spam on`, `/spam off`, `/spam delete`, `/spam clear`, `/spam status` | — | Tag một người với giới hạn; dừng, xóa cấu hình hoặc dọn tin bot |
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

### Phát nhạc và kiểm tra khi không có tiếng

1. Vào cùng phòng thoại với bot. Nếu có hàng đợi cũ không mong muốn, dùng `/stop` (lệnh này xóa toàn bộ hàng đợi).
2. Nhập `/play`, dán tên bài hoặc link vào ô `query`, sau đó gửi lệnh. Dùng link chỉ có `watch?v=...` nếu muốn phát một video thay vì cả danh sách Mix. `/playnext` chèn bài vào đầu hàng đợi. Link dài được giữ nguyên; nếu gợi ý hết hạn hoặc bot vừa khởi động lại, dán link và gửi lại.
3. Dùng `/volume level:80` nếu âm lượng bằng 0; dùng `/resume` nếu nhạc đang tạm dừng.
4. Bot phải có quyền **View Channel**, **Connect** và **Speak** trong phòng, và không bị tắt tiếng bởi quản trị viên. Với Stage, bot cần được mời làm diễn giả.
5. Bot thử nguồn gốc trước. Nếu nguồn đó không tải được, bot thử tìm một số bản phù hợp trên YouTube/SoundCloud, ưu tiên cùng bài và ca sĩ khi nhận diện được; kết quả chỉ là so khớp gần đúng và có thể là bản cover, live hoặc ca sĩ khác. Bot báo tên và nguồn bản thực sự được chọn; xem `/nowplaying` hoặc `/queue`. Để tiết kiệm tài nguyên, mỗi nguồn chỉ tìm tối đa 3 lượt và thử tối đa 3 luồng; nếu không tìm thấy bản đủ phù hợp, bot không cố phát bài không liên quan.
6. Không thể bảo đảm phát mọi bài: nội dung riêng tư, bị xóa, giới hạn khu vực, được bảo vệ bản quyền/DRM, hoặc bị chặn bởi nhà cung cấp hay mạng Botkeep có thể không truy cập được. Spotify cung cấp thông tin bài hát; âm thanh phải lấy từ nguồn khác.
7. Nếu bot đã vào phòng nhưng vẫn im lặng, xem log Botkeep có dòng `[Runtime]`, `[Voice]`, `[YouTube]`, `[SoundCloud]`, `[MusicFallback]`, `[Playback]` hoặc `[ZiPlayer]`. Trước khi gửi log cho người khác, xóa token, thông tin đăng nhập và URL có chữ ký. Tiếng chuông vào phòng và thông báo đã thêm vào hàng đợi không chứng minh người nghe đã nhận được âm thanh.

### Trả lời tin nhắn tự động

- Người có quyền **Manage Server** dùng `/autoreply set`, nhập `trigger` là câu người dùng gửi và `reply` là câu bot trả lời. Ví dụ: `trigger: xin chào`, `reply: Chào bạn!`.
- Bot so khớp **toàn bộ tin nhắn**, không phân biệt chữ hoa/thường, bỏ khoảng trắng hai đầu; mỗi server có thể lưu tối đa 20 cặp câu. Bot bỏ qua tin nhắn của chính nó, bot khác và webhook; câu trả lời không tự ping người dùng hay `@everyone`.
- Xem danh sách bằng `/autoreply list`, xóa bằng `/autoreply remove` và nhập câu kích hoạt. Cấu hình lưu ở `data/auto-replies.json` (cùng thư mục với `PERSISTENCE_FILE`; nếu trùng tên file phiên nhạc, dùng `auto-replies.json.rules.json`). Hãy giữ thư mục dữ liệu qua redeploy.
- Bắt buộc bật **Message Content Intent** tại Discord Developer Portal → Bot → Privileged Gateway Intents, lưu và khởi động lại bot. Nếu bot đang chạy chế độ dự phòng không có intent này, `/autoreply set` vẫn lưu được nhưng bot không thể đọc tin nhắn thường.
- Bot chính tự đăng ký lệnh khi `AUTO_DEPLOY_COMMANDS=true`; nếu tắt, chạy `npm run deploy` sau khi cập nhật. Ví dụ ba file chạy riêng nằm ở `examples/auto-reply-bot/`, cấu hình một cặp câu bằng `.env`; ví dụ đó không bao gồm nhạc hay 24/7, không chạy đồng thời với bot chính bằng cùng token.

### Chào và tạm biệt thành viên kèm banner

1. Trong [Discord Developer Portal](https://discord.com/developers/applications), chọn ứng dụng → **Bot** → bật **Server Members Intent** → **Save Changes**, rồi khởi động lại bot. **Message Content Intent** vẫn cần bật riêng nếu dùng auto-reply và lệnh prefix.
2. Cập nhật mã và cài dependency mới trên Botkeep, giữ Node 22.12+ (Node 24 cũng được), rồi redeploy/restart. Để `AUTO_DEPLOY_COMMANDS=true` cho bot tự đăng ký lệnh; nếu để `false`, chạy `npm run deploy` sau `npm run build`. Lệnh global có thể cần thời gian xuất hiện; `DISCORD_GUILD_ID` đăng ký cho một server thử nghiệm.
3. Người có quyền **Manage Server (Quản lý máy chủ)** dùng `/welcome set`, chọn `channel` là kênh chữ và tùy chọn nhập `message`. Tương tự, dùng `/goodbye set` và chọn kênh tạm biệt; có thể dùng chung hoặc khác kênh. Nếu bỏ trống `message`, bot dùng nội dung mặc định, hoặc giữ nội dung cũ khi cấu hình lại.
4. Dùng `/welcome test` và `/goodbye test` để gửi thử banner của chính bạn; `/welcome status` và `/goodbye status` để xem cấu hình; `/welcome off` và `/goodbye off` để tắt mà không xóa thiết lập. Bật lại bằng `set` và chọn kênh.
5. Muốn thay nền, dùng `/welcome banner` rồi tải ảnh ở ô `image`; với goodbye dùng `/goodbye banner`. Hai nền độc lập theo từng server. Ảnh JPG, PNG hoặc WebP tối đa **3 MB**, tối đa **4096 px mỗi chiều và 8 triệu điểm ảnh**; khuyến nghị **1200×420**. Bot tự cắt giữa cho vừa khung, rồi ghép tên, avatar, tên server và số thành viên lên ảnh. Dùng `/welcome reset-banner` hoặc `/goodbye reset-banner` để khôi phục nền mặc định.
6. Ví dụ nội dung: `Chào {user} đến với {server}! Hiện có {count} thành viên.` Biến hỗ trợ: `{user}` (mention thành viên khi welcome; tên khi goodbye), `{name}` (tên hiển thị), `{server}` (tên server), `{count}` (số thành viên). Mỗi nội dung tối đa 500 ký tự; mẫu thử không ping ai, và bot không ping `@everyone`, role hoặc người khác qua mẫu.

- Bot cần quyền **View Channel**, **Send Messages** và **Attach Files** trong kênh. Banner JPG dùng nền mặc định và font tiếng Việt trong `assets/`, hoặc nền do quản trị viên tải lên, cùng tên/avatar thực của thành viên, tên server và số thành viên; khi avatar không tải được sẽ dùng hình mặc định. Nếu không tạo/gửi được ảnh hoặc hàng đợi ảnh quá tải, bot cố gửi lời chào dạng chữ và ghi log `[Greeting]`. Bot tải thư viện ảnh khi cần và chỉ xử lý một banner mỗi lần.
- Welcome/goodbye ban đầu **tắt** và được lưu riêng theo server trong `data/member-greetings.json`, cùng thư mục với `PERSISTENCE_FILE`. Nếu `PERSISTENCE_FILE` trùng tên này, bot dùng `member-greetings.json.settings.json` để tránh ghi đè. Ảnh nền tự tải được tối ưu và lưu riêng trong `data/member-banners/`; nếu đường dẫn đó trùng `PERSISTENCE_FILE`, dùng `member-banners.images/`. Giữ thư mục dữ liệu qua restart/redeploy. Nếu bot offline, các sự kiện xảy ra lúc đó không được phát lại; goodbye cũng áp dụng cho thành viên bị kick/ban.
- Nếu chưa bật Server Members Intent, bot thử khởi động ở chế độ tương thích để nhạc tiếp tục hoạt động, nhưng không tự nhận sự kiện vào/rời; `status`/`set` sẽ nhắc bật intent. `/test` vẫn có thể gửi thử sau khi cấu hình. Nếu vẫn lỗi, kiểm tra log `[Gateway]`/`[Greeting]` và quyền kênh.
- Nếu không thấy `/welcome` hoặc `/goodbye`, dùng tài khoản có quyền **Manage Server** trong server đã thêm bot. Xem Console sau khi khởi động: `[Runtime] DTrx-Bot 1.5.0` cho biết mã phiên bản mới đang chạy; dòng `Đã đăng ký 33 Slash Commands ... gồm /welcome, /goodbye, /lock, /unlock và /spam` cho biết đăng ký thành công. Kiểm tra `AUTO_DEPLOY_COMMANDS=true`; nếu có `DISCORD_GUILD_ID`, lệnh chỉ đăng ký cho server có ID đó, còn lệnh global có thể cần thời gian cập nhật. Tìm lỗi `Không thể tự động đăng ký Slash Commands` nếu không thấy dòng thành công.

### Khóa và mở khóa kênh chữ

1. Người dùng lệnh và bot cần có **Xem kênh** và **Quản lý quyền hạn (Manage Roles)** trong kênh đích. Quyền Manage Roles không nằm trong link mời nhạc mặc định; nhờ chủ server cấp riêng cho bot trong kênh nếu cần. Discord có thể yêu cầu bot có thêm các quyền mà nó đang chỉnh; xem lỗi `[ChannelLock]` khi API từ chối.
2. Trong kênh chữ, chạy `/lock` để khóa kênh hiện tại, hoặc chạy `/lock` và chọn `channel` khác. Kênh thông báo cũng được hỗ trợ; chủ đề, diễn đàn và kênh thoại không được hỗ trợ.
3. Bot chỉ đặt **từ chối** bốn quyền của `@everyone`: **Send Messages**, **Send Messages in Threads**, **Create Public Threads**, **Create Private Threads**. Không thay đổi quyền xem, đọc lịch sử hay các vai trò/thành viên khác. Trước khi khóa, bot phải đã có quyền xem và gửi; bot tạm bảo vệ quyền gửi của chính mình để welcome vẫn có thể hoạt động. Nếu thiếu **Attach Files**, banner có thể chỉ gửi chữ; hãy dùng `/welcome test` sau khi cấu hình.
4. Dùng `/unlock` ở kênh đó hoặc chọn lại `channel` để khôi phục đúng các giá trị quyền trước khi bot khóa (cho phép / từ chối / kế thừa), kể cả sau khi bot khởi động lại. Nếu trước đó một quyền đã bị từ chối thì `/unlock` giữ trạng thái bị từ chối; lệnh không tự cho phép tất cả. Nếu một quyền hiện khác với cả giá trị ban đầu và giá trị bot đặt khi khóa, bot giữ nguyên giá trị đó và cảnh báo thay vì ghi đè.

**Giới hạn Discord:** Khóa `@everyone` không bảo đảm mọi người đều bị chặn: quản trị viên và các vai trò/thành viên có quyền cho phép riêng trong kênh có thể vượt qua ghi đè `@everyone`. Bot chỉ khóa khi được gọi lệnh; không tự khóa kênh welcome. Việc thay đổi quyền có thể làm kênh tạm mất đồng bộ quyền với danh mục; sau mở, bot khôi phục các ghi đè do nó sửa nhưng không ép đồng bộ lại nếu người quản lý đã thay đổi quyền khác.

Bản quyền cũ được ghi **trước** khi bot sửa Discord vào `data/channel-locks.json` cạnh `PERSISTENCE_FILE`; nếu trùng tên file phiên nhạc thì dùng `channel-locks.json.locks.json`. Giữ thư mục `data/` khi cập nhật. Nếu khóa hoặc mở thất bại giữa chừng, bản lưu vẫn giữ; sửa quyền/kết nối rồi thử `/unlock` lại. Nếu mất hoặc hỏng bản lưu, `/unlock` từ chối thay đổi để tránh mở nhầm; khôi phục file từ bản sao lưu hoặc nhờ quản trị viên sửa thủ công. Không chạy nhiều bản bot cùng token/dữ liệu song song.

### Tag một người với giới hạn

1. Người có quyền **Manage Server (Quản lý máy chủ)** chạy `/spam set`, chọn `user` (thành viên thật trong server). Có thể chọn `channel` là kênh chữ/kênh thông báo; nếu bỏ trống, bot dùng kênh hiện tại. Cả người dùng lệnh và người nhận phải xem được kênh; bot cần **View Channel** và **Send Messages**.
2. Tự chọn `interval` là số giây giữa các tag (**1–100**, mặc định **30**), `count` là số lần mỗi đợt (**1–100**, mặc định **100**) và `message` là nội dung tối đa **200 ký tự**. Ví dụ: `/spam set user:@Bạn channel:#chat interval:30 count:100 message:Nhắc bạn nhé`. Nội dung thêm không ping `@everyone`, role hay người khác.
3. Dùng `/spam on` để bắt đầu ngay. Tin mới **không có nút dừng**; người nhận, người bắt đầu hoặc người có Manage Server dùng `/spam off` để dừng. Các lệnh cấu hình, bắt đầu, xóa và xem trạng thái vẫn yêu cầu Manage Server. Quyền dùng lệnh ứng dụng phải được phép trong kênh; tôn trọng yêu cầu dừng của người nhận và quy định server.
4. `/spam off` dừng đợt và **giữ cấu hình**. `/spam delete` dừng rồi **xóa cấu hình**, không tự xóa tin cũ. `/spam clear` dừng rồi dọn các tin đã được chức năng này ghi nhận; bot xác minh từng tin là của chính bot trước khi xóa, không xóa tin người khác. Người dọn phải xem được kênh; bot cần **Read Message History** và **View Channel** để dọn. Tin không thể dọn được giữ lại trong danh sách để thử sau. `/spam status` xem tình trạng.

Tính năng chỉ dùng hẹn giờ khi có đợt đang chạy, không tạo luồng riêng; mỗi đợt tối đa 100 tag và toàn bot tối đa 4 server đang chạy. Khoảng cách tối thiểu 1 giây vẫn được áp dụng nếu bật lại ngay. Discord có thể giới hạn tốc độ, nên khoảng cách thực tế có thể lớn hơn thiết lập. Đây là giới hạn thiết kế, **không phải số RAM/CPU đã đo trên Botkeep**; Discord vẫn có giới hạn tốc độ riêng.

Cấu hình và tối đa 500 ID tin bot mỗi server được lưu tại `data/mention-reminders.json` cạnh `PERSISTENCE_FILE`; nếu trùng tên file phiên nhạc thì dùng `mention-reminders.json.reminders.json`. Giữ thư mục `data/` qua redeploy. Nếu danh sách không đủ chỗ cho một đợt, cần chạy `/spam clear` trước khi mở đợt mới. Bot **không tự tiếp tục** đợt đã chạy sau khi restart; cấu hình vẫn còn nếu host giữ dữ liệu, nhưng cần `/spam on` lại. Nếu cấu hình cũ có khoảng cách lớn hơn 100 giây, bot giữ nguyên dữ liệu nhưng yêu cầu dùng `/spam set` đặt lại trước khi bật. Các nút trên tin cũ không còn hiệu lực nhưng vẫn hiển thị; `/spam clear` xóa cả các tin bot đã theo dõi, không chỉ nút. Không chạy nhiều bản bot dùng chung dữ liệu.

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
│   ├── deploy-commands.ts           # Đăng ký 33 Slash Commands lên Discord API
│   ├── core/
│   │   ├── musicEngine.ts           # Quản lý ZiPlayer, Plugins, Extensions & Discord Events
│   │   ├── persistence.ts           # Tự động lưu & khôi phục phiên nhạc qua JSON nguyên tử
│   │   ├── alwaysOnStore.ts         # Lưu phòng thoại 24/7 riêng cho từng server
│   │   ├── autoReplyStore.ts        # Lưu câu kích hoạt và trả lời theo từng server
│   │   ├── memberGreetingStore.ts   # Lưu cấu hình welcome/goodbye theo server
│   │   ├── memberBanner.ts          # Tạo banner JPG và xử lý ảnh tải lên có giới hạn
│   │   ├── memberBannerStore.ts     # Lưu ảnh nền riêng của từng server
│   │   ├── channelLockStore.ts      # Lưu bản quyền cũ để mở khóa an toàn
│   │   ├── mentionReminderStore.ts  # Lưu cấu hình và các tin nhắc do bot gửi
│   │   └── exporter.ts              # Xuất luồng nhạc ZiPlayer sang MP3 qua FFmpeg
│   ├── handlers/
│   │   ├── slashDefinitions.ts      # Định nghĩa cấu trúc 33 Slash Commands
│   │   ├── musicActions.ts          # Xử lý nghiệp vụ thống nhất & kiểm tra quyền kênh thoại
│   │   ├── autoReplyHandler.ts      # Trả lời tự động và quản lý bằng slash command
│   │   ├── memberGreetingHandler.ts # Sự kiện vào/rời, hàng đợi banner & lệnh quản trị
│   │   ├── channelLockHandler.ts    # Khóa/mở kênh chữ và phục hồi quyền
│   │   ├── mentionReminderHandler.ts # Gửi có giới hạn, dừng và dọn tin
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
├── assets/                          # Nền banner, font tiếng Việt và giấy phép font
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
