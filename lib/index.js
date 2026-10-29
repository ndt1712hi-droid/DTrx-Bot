import { ActivityType, Client, Events, GatewayIntentBits, Options } from "discord.js";
import { assertBotCredentials, ensureFfmpegInstalled, loadConfig } from "./config.js";
import { ZiMusicBotEngine } from "./core/musicEngine.js";
import { deploySlashCommands } from "./deploy-commands.js";
import { registerInteractionHandler } from "./handlers/interactionHandler.js";
import { MusicCommandActions } from "./handlers/musicActions.js";
import { registerPrefixHandler } from "./handlers/prefixHandler.js";
export function createBotInstance(customEnv, options = {}) {
    const config = loadConfig(customEnv);
    const includeMessageContent = options.includeMessageContentIntent ?? true;
    const intents = [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        ...(includeMessageContent ? [GatewayIntentBits.MessageContent] : []),
    ];
    // Memory-optimized Discord.js cache profile so the bot runs smoothly on free-tier hosts (e.g. botkeep.cloud)
    const client = new Client({
        intents,
        makeCache: Options.cacheWithLimits({
            ...Options.DefaultMakeCacheSettings,
            MessageManager: 20,
            ReactionManager: 0,
            ReactionUserManager: 0,
            PresenceManager: 0,
            GuildEmojiManager: 0,
            GuildStickerManager: 0,
            GuildBanManager: 0,
            GuildInviteManager: 0,
            GuildScheduledEventManager: 0,
            StageInstanceManager: 0,
            ThreadManager: 0,
            AutoModerationRuleManager: 0,
            GuildMemberManager: {
                maxSize: 200,
                keepOverLimit: (member) => member.id === member.client.user.id || Boolean(member.voice?.channelId),
            },
        }),
        sweepers: {
            ...Options.DefaultSweeperSettings,
            messages: {
                interval: 300,
                lifetime: 600,
            },
        },
    });
    const engine = new ZiMusicBotEngine(client, config);
    const actions = new MusicCommandActions(engine);
    registerInteractionHandler(engine, actions);
    registerPrefixHandler(engine, actions);
    client.once(Events.ClientReady, async (readyClient) => {
        console.log(`🚀 ZiPlayer Bot đã đăng nhập thành công: ${readyClient.user.tag}`);
        console.log(`⚡ Chế độ tiết kiệm RAM (Free-Tier): ${config.lowPerformance ? "BẬT" : "TẮT"} | Prefix Intent: ${includeMessageContent ? `BẬT (${config.prefix}play)` : "TẮT (Dùng /play hoặc @Bot play)"}`);
        console.log(`🔌 Plugins: ${engine.manager
            .getPlugins()
            .map((p) => p.name)
            .join(", ")} | FFmpeg: ${config.ffmpegPath ? "Sẵn sàng" : "Chưa tìm thấy"}`);
        readyClient.user.setPresence({
            activities: [
                {
                    name: includeMessageContent
                        ? `/play • ${config.prefix}help • ZiPlayer`
                        : `/play • @${readyClient.user.username} help`,
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
function isDisallowedIntentsError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    return /disallowed intents/i.test(msg);
}
async function main() {
    ensureFfmpegInstalled();
    const precheckConfig = loadConfig();
    assertBotCredentials(precheckConfig);
    let active = createBotInstance(undefined, { includeMessageContentIntent: true });
    let shuttingDown = false;
    const gracefulExit = async (signal) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        console.log(`\n🛑 Nhận tín hiệu ${signal}, đang lưu phiên phát nhạc và đóng kết nối...`);
        try {
            await active.engine.shutdown();
            await active.client.destroy();
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
        await active.client.login(active.config.discordToken);
    }
    catch (err) {
        await active.engine.shutdown().catch(() => undefined);
        await active.client.destroy().catch(() => undefined);
        if (isDisallowedIntentsError(err)) {
            console.warn("⚠️ Phát hiện Bot chưa bật 'Message Content Intent' trên Discord Developer Portal -> Tự động chuyển sang chế độ Slash Commands (/play) & @Mention để Bot chạy ngay không bị crash!");
            active = createBotInstance(undefined, { includeMessageContentIntent: false });
            try {
                await active.client.login(active.config.discordToken);
                return;
            }
            catch (retryErr) {
                await active.engine.shutdown().catch(() => undefined);
                await active.client.destroy().catch(() => undefined);
                throw retryErr;
            }
        }
        throw err;
    }
}
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