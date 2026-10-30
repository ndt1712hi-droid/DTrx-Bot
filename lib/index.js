import path from "node:path";
import { createRequire } from "node:module";
import { generateDependencyReport } from "@discordjs/voice";
import { ActivityType, Client, Events, GatewayIntentBits, Options, Partials } from "discord.js";
import { assertBotCredentials, ensureFfmpegInstalled, loadConfig } from "./config.js";
import { ZiMusicBotEngine } from "./core/musicEngine.js";
import { AutoReplyStore } from "./core/autoReplyStore.js";
import { MemberGreetingStore } from "./core/memberGreetingStore.js";
import { MemberBannerStore } from "./core/memberBannerStore.js";
import { deploySlashCommands } from "./deploy-commands.js";
import { registerInteractionHandler } from "./handlers/interactionHandler.js";
import { AutoReplyActions, registerAutoReplyHandler } from "./handlers/autoReplyHandler.js";
import { MusicCommandActions } from "./handlers/musicActions.js";
import { MemberGreetingActions, MemberGreetingService } from "./handlers/memberGreetingHandler.js";
import { registerPrefixHandler } from "./handlers/prefixHandler.js";
export function createBotInstance(customEnv, options = {}) {
    const config = loadConfig(customEnv);
    const includeMessageContent = options.includeMessageContentIntent ?? true;
    const includeGuildMembers = options.includeGuildMembersIntent ?? true;
    const intents = [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        ...(includeMessageContent ? [GatewayIntentBits.MessageContent] : []),
        ...(includeGuildMembers ? [GatewayIntentBits.GuildMembers] : []),
    ];
    // Memory-optimized Discord.js cache profile so the bot runs smoothly on free-tier hosts (e.g. botkeep.cloud)
    const client = new Client({
        intents,
        // Goodbye must also fire when a departing member is outside the 200-member cache.
        partials: [Partials.GuildMember],
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
    const replyPath = path.resolve(path.dirname(config.persistenceFile), "auto-replies.json");
    const autoReplyStore = new AutoReplyStore(replyPath === path.resolve(config.persistenceFile) ? `${replyPath}.rules.json` : replyPath);
    const autoReplyActions = new AutoReplyActions(autoReplyStore, includeMessageContent);
    const greetingPath = path.resolve(path.dirname(config.persistenceFile), "member-greetings.json");
    const greetingStore = new MemberGreetingStore(greetingPath === path.resolve(config.persistenceFile) ? `${greetingPath}.settings.json` : greetingPath);
    const bannerDirectory = path.resolve(path.dirname(config.persistenceFile), "member-banners");
    const bannerStore = new MemberBannerStore(bannerDirectory === path.resolve(config.persistenceFile) ? `${bannerDirectory}.images` : bannerDirectory);
    const greetingService = new MemberGreetingService(client, greetingStore, includeGuildMembers, undefined, bannerStore);
    const greetingActions = new MemberGreetingActions(greetingStore, greetingService, includeGuildMembers);
    registerInteractionHandler(engine, actions, autoReplyActions, greetingActions);
    registerPrefixHandler(engine, actions);
    registerAutoReplyHandler(client, autoReplyStore, includeMessageContent);
    greetingService.register();
    client.once(Events.ClientReady, async (readyClient) => {
        const guildCount = readyClient.guilds.cache.size;
        const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${readyClient.user.id}&permissions=36752384&integration_type=0&scope=bot+applications.commands`;
        console.log(`🚀 ZiPlayer Bot đã đăng nhập thành công: ${readyClient.user.tag} (ID: ${readyClient.user.id})`);
        console.log(`🏠 Số Server (Guilds) Bot đang có mặt: ${guildCount}`);
        if (guildCount === 0) {
            console.warn("⚠️ CHÚ Ý: Bot hiện chưa được mời vào Server nào dưới tư cách Bot thành viên (nên trên Discord sẽ thấy Offline và không vào Voice được)!");
        }
        console.log(`🔗 Link mời chuẩn (Add to Server): ${inviteUrl}`);
        console.log(`⚡ Chế độ tiết kiệm RAM (Free-Tier): ${config.lowPerformance ? "BẬT" : "TẮT"} | Prefix Intent: ${includeMessageContent ? `BẬT (${config.prefix}play)` : "TẮT (Dùng /play hoặc @Bot play)"}`);
        console.log(`🔌 Plugins: ${engine.manager
            .getPlugins()
            .map((p) => p.name)
            .join(", ")} | FFmpeg: ${config.ffmpegPath ? "Sẵn sàng" : "Chưa tìm thấy"}`);
        void autoReplyStore.ready().catch((err) => {
            console.error("[AutoReply] Không thể tải cấu hình:", err instanceof Error ? err.message : err);
        });
        if (!includeMessageContent) {
            console.warn("[AutoReply] Đang tắt: hãy bật Message Content Intent trong Discord Developer Portal rồi khởi động lại.");
        }
        void greetingStore.ready().catch((err) => {
            console.error("[Greeting] Không thể tải cấu hình:", err instanceof Error ? err.message : err);
        });
        if (!includeGuildMembers) {
            console.warn("[Greeting] Welcome/goodbye chưa nhận sự kiện: bật Server Members Intent trong Discord Developer Portal rồi khởi động lại.");
        }
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
        // Do not delay slash-command deployment while Discord voice reconnects.
        const alwaysOnStartup = engine.startAlwaysOnVoice().then((savedRooms) => {
            if (savedRooms > 0)
                console.log(`🔁 Chế độ 24/7: đã tải ${savedRooms} phòng thoại đã lưu.`);
        }).catch((err) => {
            console.error("[24/7] Không thể tải cấu hình phòng thoại:", err instanceof Error ? err.message : err);
        });
        if (config.autoDeployCommands) {
            try {
                await deploySlashCommands(config, readyClient.user.id);
            }
            catch (err) {
                console.warn("⚠️ Không thể tự động đăng ký Slash Commands:", err instanceof Error ? err.message : err);
            }
        }
        else {
            console.warn("[Commands] Tự đăng ký lệnh đang TẮT (AUTO_DEPLOY_COMMANDS=false); bật lại hoặc chạy npm run deploy.");
        }
        engine.persistence.startPeriodicSave(engine.manager, 30_000);
        await alwaysOnStartup;
        const restored = await engine.restorePersistedSessions();
        if (restored > 0) {
            console.log(`🔄 Đã khôi phục ${restored} phiên phát nhạc từ lần chạy trước.`);
        }
    });
    return { client, config, engine, actions, autoReplyStore, autoReplyActions, greetingStore, bannerStore, greetingService, greetingActions };
}
/** Clean up an instance that failed before login without erasing saved music. */
export async function disposeFailedLogin(bot) {
    bot.greetingService.close();
    await bot.engine.shutdown({ saveSessions: false }).catch(() => undefined);
    await bot.client.destroy().catch(() => undefined);
}
function isDisallowedIntentsError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    return /disallowed intents/i.test(msg);
}
/** Discord's 4014 error does not identify which privileged intent is missing.
 * Try all combinations, preserving Message Content first so adding welcome
 * cannot accidentally disable an already-working auto-reply bot. */
export async function loginWithIntentFallback(create, login, dispose) {
    const attempts = [
        { includeMessageContentIntent: true, includeGuildMembersIntent: true },
        { includeMessageContentIntent: true, includeGuildMembersIntent: false },
        { includeMessageContentIntent: false, includeGuildMembersIntent: true },
        { includeMessageContentIntent: false, includeGuildMembersIntent: false },
    ];
    for (let index = 0; index < attempts.length; index++) {
        const bot = create(attempts[index]);
        try {
            await login(bot);
            return bot;
        }
        catch (err) {
            await dispose(bot).catch(() => undefined);
            if (!isDisallowedIntentsError(err) || index === attempts.length - 1)
                throw err;
            console.warn("[Gateway] Một hoặc nhiều privileged intent chưa được cấp; thử cấu hình tương thích để bot vẫn hoạt động.");
        }
    }
    throw new Error("Không còn cấu hình Gateway để thử");
}
export function supportsVoiceRuntime(version = process.versions.node) {
    const [major, minor] = version.split(".").map(Number);
    return Number.isFinite(major) && Number.isFinite(minor) && (major > 22 || (major === 22 && minor >= 12));
}
async function main() {
    let release = "không rõ";
    try {
        release = createRequire(import.meta.url)("../package.json").version ?? release;
    }
    catch { /* Continue running if package metadata is unavailable. */ }
    console.log(`[Runtime] DTrx-Bot ${release} | Node.js ${process.version}`);
    if (!supportsVoiceRuntime()) {
        console.warn("[Runtime] Voice yêu cầu Node.js 22.12 trở lên. Hãy chọn Node 22 hoặc mới hơn trên Botkeep.");
    }
    ensureFfmpegInstalled();
    try {
        console.log(`[Voice] Kiểm tra thư viện âm thanh:\n${generateDependencyReport()}`);
    }
    catch (err) {
        console.warn("[Voice] Không thể kiểm tra đầy đủ thư viện âm thanh:", err instanceof Error ? err.message : err);
    }
    const precheckConfig = loadConfig();
    assertBotCredentials(precheckConfig);
    let active;
    let activeLoggedIn = false;
    let shuttingDown = false;
    const gracefulExit = async (signal) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        console.log(`\n🛑 Nhận tín hiệu ${signal}, đang lưu phiên phát nhạc và đóng kết nối...`);
        try {
            const bot = active;
            if (bot) {
                bot.greetingService.close();
                await bot.autoReplyStore.flush().catch((err) => {
                    console.error("[AutoReply] Không thể hoàn tất lưu cấu hình:", err instanceof Error ? err.message : err);
                });
                await bot.greetingStore.flush().catch((err) => {
                    console.error("[Greeting] Không thể hoàn tất lưu cấu hình:", err instanceof Error ? err.message : err);
                });
                await bot.bannerStore.flush().catch((err) => {
                    console.error("[Greeting] Không thể hoàn tất lưu ảnh nền:", err instanceof Error ? err.message : err);
                });
                await bot.engine.shutdown({ saveSessions: activeLoggedIn });
                await bot.client.destroy();
            }
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
    await loginWithIntentFallback((options) => { activeLoggedIn = false; active = createBotInstance(undefined, options); return active; }, async (bot) => {
        const result = await bot.client.login(bot.config.discordToken);
        activeLoggedIn = true;
        return result;
    }, async (bot) => {
        if (active === bot)
            active = undefined;
        await disposeFailedLogin(bot);
    });
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