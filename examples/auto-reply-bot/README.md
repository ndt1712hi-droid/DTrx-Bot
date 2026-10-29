# Bot Discord trả lời tự động — bản độc lập

Đây là **một bot mẫu chạy riêng**, không thay thế bot nhạc/24-7 trong thư mục chính. Không chạy song song với bot chính bằng cùng token nếu không muốn bot trả lời hai lần. Bot chính đã tích hợp `/autoreply set`, `/autoreply remove`, `/autoreply list`; bản độc lập này cấu hình một cặp câu qua `.env` và cần khởi động lại khi đổi câu.

1. Dùng Node.js 20.20 trở lên, chạy `npm install`.
2. Sao chép `.env.example` thành `.env`, điền `DISCORD_TOKEN`, `AUTO_REPLY_TRIGGER` và `AUTO_REPLY_RESPONSE` (hoặc đặt ba biến này trong panel host). Không chia sẻ token thật.
3. Vào Discord Developer Portal → ứng dụng → **Bot** → **Privileged Gateway Intents**, bật **Message Content Intent**, lưu thay đổi.
4. Chạy `npm start`. Để kiểm thử xử lý tin nhắn mà không kết nối Discord, chạy `npm test`.

Bot so khớp toàn bộ nội dung, không phân biệt chữ hoa/thường và bỏ khoảng trắng hai đầu. Bot bỏ qua tin nhắn của chính nó, bot khác và webhook; câu trả lời không tự ping ai. Bot chỉ trả lời trong server, không trả lời tin nhắn riêng.
