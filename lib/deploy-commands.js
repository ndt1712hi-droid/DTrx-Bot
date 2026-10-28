import { fileURLToPath } from "node:url";
import { REST, Routes } from "discord.js";
import { assertBotCredentials, loadConfig } from "./config.js";
import { buildSlashCommands } from "./handlers/slashDefinitions.js";
export async function deploySlashCommands(config, fallbackClientId) {
    const appId = config.clientId && config.clientId !== "your_discord_application_client_id_here"
        ? config.clientId
        : fallbackClientId;
    if (!appId) {
        throw new Error("Thiếu DISCORD_CLIENT_ID để đăng ký Slash Commands.");
    }
    const rest = new REST({ version: "10" }).setToken(config.discordToken);
    const body = buildSlashCommands();
    if (config.guildId) {
        await rest.put(Routes.applicationGuildCommands(appId, config.guildId), { body });
        console.log(`✅ Đã đăng ký ${body.length} Slash Commands cho Guild ${config.guildId}.`);
    }
    else {
        await rest.put(Routes.applicationCommands(appId), { body });
        console.log(`✅ Đã đăng ký ${body.length} Slash Commands toàn cục (Global).`);
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