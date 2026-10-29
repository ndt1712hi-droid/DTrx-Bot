import "dotenv/config";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client, Events, GatewayIntentBits } from "discord.js";

/** Compare the whole message, ignoring case and whitespace at the ends. */
export function normalizeText(text) {
  return text.trim().normalize("NFC").toLocaleLowerCase("vi");
}

/** Returns a handler that responds only to human messages in Discord servers. */
export function createMessageHandler(client, trigger, reply) {
  if (typeof trigger !== "string" || !trigger.trim() || trigger.trim().length > 100) {
    throw new Error("AUTO_REPLY_TRIGGER phải có từ 1 đến 100 ký tự.");
  }
  if (typeof reply !== "string" || !reply.trim() || reply.length > 2000) {
    throw new Error("AUTO_REPLY_RESPONSE phải có từ 1 đến 2000 ký tự.");
  }
  const expected = normalizeText(trigger);

  return async (message) => {
    // Ignore all bot accounts, this bot itself, and webhook messages.
    if (!message.guildId || !message.author || message.author.bot || message.webhookId ||
        message.author.id === client.user?.id || typeof message.content !== "string") return;
    if (normalizeText(message.content) !== expected) return;

    try {
      await message.reply({
        content: reply,
        // Do not ping the sender, @everyone, roles or users in the configured reply.
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch (error) {
      console.error("[AutoReply] Không gửi được câu trả lời:", error instanceof Error ? error.message : error);
    }
  };
}

export async function startBot(env = process.env) {
  const token = env.DISCORD_TOKEN?.trim();
  if (!token || token === "your_discord_bot_token_here") {
    throw new Error("Hãy đặt DISCORD_TOKEN trong .env hoặc biến môi trường của host.");
  }
  const trigger = env.AUTO_REPLY_TRIGGER;
  const reply = env.AUTO_REPLY_RESPONSE;
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  const handleMessage = createMessageHandler(client, trigger, reply);
  client.once(Events.ClientReady, (readyClient) => console.log(`✅ Đã đăng nhập: ${readyClient.user.tag}`));
  client.on(Events.MessageCreate, handleMessage);
  try {
    await client.login(token);
    return client;
  } catch (error) {
    await client.destroy();
    throw error;
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  startBot().catch((error) => {
    console.error("[Startup] Không thể khởi động bot:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
