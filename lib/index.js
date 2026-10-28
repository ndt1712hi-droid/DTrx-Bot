import { ActivityType, Client, Events, GatewayIntentBits } from "discord.js";
import { assertBotCredentials, loadConfig } from "./config.js";
import { ZiMusicBotEngine } from "./core/musicEngine.js";
import { deploySlashCommands } from "./deploy-commands.js";
import { registerInteractionHandler } from "./handlers/interactionHandler.js";
import { MusicCommandActions } from "./handlers/musicActions.js";
import { registerPrefixHandler } from "./handlers/prefixHandler.js";
export function createBotInstance(customEnv) {
    const config = loadConfig(customEnv);
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildVoiceStates,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
    });
    const engine = new ZiMusicBotEngine(client, config);
    const actions = new MusicCommandActions(engine);
    registerInteractionHandler(engine, actions);
    registerPrefixHandler(engine, actions);
    client.once(Events.ClientReady, async (readyClient) => {
        console.log(`🚀 ZiPlayer Bot đã đăng nhập thành công: ${readyClient.user.tag}`);
        console.log(`🔌 Plugins: ${engine.manager
            .getPlugins()
            .map((p) => p.name)
            .join(", ")} | FFmpeg: ${config.ffmpegPath ? "Sẵn sàng" : "Chưa tìm thấy"}`);
        readyClient.user.setPresence({
            activities: [
                {
                    name: `/play • ${config.prefix}help • ZiPlayer`,
                    type: ActivityType.Listening,
                },
            ],
            status: "online",
        });
        if (config.autoDeployCommands) {
            try {
                await deploySlashCommands(config, readyClient.user.id);
            }
            catch (err) {
                console.warn("⚠️ Không thể tự động đăng ký Slash Commands:", err instanceof Error ? err.message : err);
            }
        }
        engine.persistence.startPeriodicSave(engine.manager, 30_000);
        const restored = await engine.restorePersistedSessions();
        if (restored > 0) {
            console.log(`🔄 Đã khôi phục ${restored} phiên phát nhạc từ lần chạy trước.`);
        }
    });
    return { client, config, engine, actions };
}
async function main() {
    const precheckConfig = loadConfig();
    assertBotCredentials(precheckConfig);
    const { client, config, engine } = createBotInstance();
    let shuttingDown = false;
    const gracefulExit = async (signal) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        console.log(`\n🛑 Nhận tín hiệu ${signal}, đang lưu phiên phát nhạc và đóng kết nối...`);
        try {
            await engine.shutdown();
            await client.destroy();
        }
        catch (err) {
            console.error("Lỗi khi tắt bot:", err);
        }
        finally {
            process.exit(0);
        }
    };
    process.on("SIGINT", () => void gracefulExit("SIGINT"));
    process.on("SIGTERM", () => void gracefulExit("SIGTERM"));
    process.on("unhandledRejection", (reason) => {
        console.error("[UnhandledRejection]", reason);
    });
    process.on("uncaughtException", (error) => {
        console.error("[UncaughtException]", error);
    });
    try {
        await client.login(config.discordToken);
    }
    catch (err) {
        await engine.shutdown().catch(() => undefined);
        await client.destroy().catch(() => undefined);
        throw err;
    }
}
// Only auto-start when executed as main entry
const isDirectRun = process.argv[1] &&
    (process.argv[1].endsWith("/index.js") ||
        process.argv[1].endsWith("\\index.js") ||
        process.argv[1].endsWith("/index.ts") ||
        process.argv[1].endsWith("\\index.ts"));
if (isDirectRun) {
    main().catch((err) => {
        console.error("❌ Không thể khởi động Bot:", err instanceof Error ? err.message : err);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=index.js.map