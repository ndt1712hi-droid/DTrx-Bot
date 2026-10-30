import { fileURLToPath } from "node:url";
import { REST, Routes } from "discord.js";
import { assertBotCredentials, loadConfig } from "./config.js";
import { buildSlashCommands } from "./handlers/slashDefinitions.js";
/** Global-only fields must not be included when targeting a single guild. */
export function buildDeploymentCommands(guildScoped) {
    const commands = buildSlashCommands();
    if (!guildScoped)
        return commands;
    return commands.map(({ contexts, integration_types, dm_permission, ...command }) => command);
}
export async function deploySlashCommands(config, loggedInClientId, restClient) {
    const configuredClientId = config.clientId && config.clientId !== "your_discord_application_client_id_here"
        ? config.clientId
        : undefined;
    // When the bot is logged in, its actual ID is safer than a stale environment variable.
    const appId = loggedInClientId || configuredClientId;
    if (!appId) {
        throw new Error("Thiếu DISCORD_CLIENT_ID để đăng ký Slash Commands.");
    }
    if (loggedInClientId && configuredClientId && loggedInClientId !== configuredClientId) {
        console.warn("[Commands] DISCORD_CLIENT_ID không khớp bot đang đăng nhập; dùng ID của bot đang chạy.");
    }
    const rest = restClient ?? new REST({ version: "10" }).setToken(config.discordToken);
    const body = buildDeploymentCommands(Boolean(config.guildId));
    if (config.guildId) {
        await rest.put(Routes.applicationGuildCommands(appId, config.guildId), { body });
        console.log(`✅ Đã đăng ký ${body.length} Slash Commands cho Guild ${config.guildId}, gồm /welcome và /goodbye.`);
    }
    else {
        await rest.put(Routes.applicationCommands(appId), { body });
        console.log(`✅ Đã đăng ký ${body.length} Slash Commands toàn cục (Global), gồm /welcome và /goodbye.`);
    }
    return body.length;
}
// Run directly via `npm run deploy`
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    const cfg = loadConfig();
    assertBotCredentials(cfg);
    deploySlashCommands(cfg).catch((err) => {
        console.error("❌ Lỗi đăng ký Slash Commands:", err);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=deploy-commands.js.map