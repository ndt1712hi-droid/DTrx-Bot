import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { REST, Routes } from "discord.js";
import { WebSocketServer } from "ws";
import { buildDeploymentCommands, deploySlashCommands } from "../deploy-commands.js";
import { createBotInstance, disposeFailedLogin } from "../index.js";
import { mockBackgroundMediaInitialization } from "./offlineMedia.js";
const restoreMediaInitialization = mockBackgroundMediaInitialization();
test.after(restoreMediaInitialization);
test("guild command registration omits fields supported only for global commands", () => {
    const globalCommands = buildDeploymentCommands(false);
    const guildCommands = buildDeploymentCommands(true);
    assert.equal(globalCommands.length, 32);
    assert.equal(guildCommands.length, 32);
    assert.deepEqual(globalCommands.map((command) => command.name), guildCommands.map((command) => command.name));
    assert.ok(globalCommands.every((command) => "contexts" in command && "integration_types" in command));
    assert.ok(guildCommands.every((command) => !("contexts" in command) && !("integration_types" in command) && !("dm_permission" in command)));
    for (const name of ["welcome", "goodbye"]) {
        const command = guildCommands.find((entry) => entry.name === name);
        assert.equal(command?.default_member_permissions, "32");
        assert.deepEqual(command?.options?.map((entry) => entry.name), ["set", "off", "status", "test", "banner", "reset-banner"]);
    }
});
test("command deployment uses the logged-in bot ID and selects the correct Discord route", async () => {
    const calls = [];
    const rest = { put: async (route, options) => { calls.push({ route, body: options.body }); return options.body; } };
    const base = { discordToken: "test-only", clientId: "old-client" };
    assert.equal(await deploySlashCommands({ ...base, guildId: "guild-1" }, "actual-bot", rest), 32);
    assert.equal(calls[0].route, Routes.applicationGuildCommands("actual-bot", "guild-1"));
    assert.ok(calls[0].body.some((entry) => entry.name === "welcome"));
    assert.ok(calls[0].body.every((entry) => !("contexts" in entry) && !("integration_types" in entry)));
    assert.equal(await deploySlashCommands({ ...base, guildId: undefined }, "actual-bot", rest), 32);
    assert.equal(calls[1].route, Routes.applicationCommands("actual-bot"));
    assert.ok(calls[1].body.every((entry) => "contexts" in entry && "integration_types" in entry));
});
test("manual deployment requires an application ID and reports REST errors", async () => {
    const rest = { put: async () => { throw new Error("simulated Discord rejection"); } };
    const base = { discordToken: "test-only", clientId: "" };
    await assert.rejects(deploySlashCommands(base, undefined, rest), /Thiếu DISCORD_CLIENT_ID/);
    await assert.rejects(deploySlashCommands({ ...base, clientId: "valid-app-id" }, undefined, rest), /simulated Discord rejection/);
});
test("bot ready event registers greetings and channel lock with the running bot ID", { timeout: 10_000 }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dtrx-deploy-ready-"));
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `ws://127.0.0.1:${address.port}`;
    const actualId = "100000000000000001";
    server.on("connection", (socket) => {
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
        socket.on("message", (data) => {
            const payload = JSON.parse(data.toString());
            if (payload.op === 1)
                socket.send(JSON.stringify({ op: 11, d: null }));
            if (payload.op !== 2)
                return;
            socket.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: {
                    v: 10, user: { id: actualId, username: "FakeBot", discriminator: "0001", avatar: null, bot: true },
                    guilds: [], session_id: "mock-session", resume_gateway_url: url, application: { id: actualId, flags: 0 },
                } }));
        });
    });
    const originalPut = REST.prototype.put;
    const originalFetch = globalThis.fetch;
    let resolveCall;
    const called = new Promise((resolve) => { resolveCall = resolve; });
    REST.prototype.put = async (route, options) => { resolveCall?.({ route, body: options.body }); return options.body; };
    globalThis.fetch = (async (input, init) => {
        if (String(input).includes("voices/list"))
            return new Response("[]", { headers: { "content-type": "application/json" } });
        return originalFetch(input, init);
    });
    const bot = createBotInstance({ DISCORD_TOKEN: "dummy", DISCORD_CLIENT_ID: "old-client", DISCORD_GUILD_ID: "200000000000000002",
        AUTO_DEPLOY_COMMANDS: "true", ENABLE_PERSISTENCE: "false", PERSISTENCE_FILE: path.join(directory, "sessions.json") });
    bot.client.rest.get = async () => ({ url, shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 1000, max_concurrency: 1 } });
    let timeout;
    try {
        await bot.client.login("fake-local-only-token");
        const call = await Promise.race([called, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("command registration timed out")), 2_000); })]);
        assert.equal(call.route, Routes.applicationGuildCommands(actualId, "200000000000000002"));
        assert.equal(call.body.length, 32);
        assert.ok(call.body.some((command) => command.name === "welcome"));
        assert.ok(call.body.some((command) => command.name === "goodbye"));
        assert.ok(call.body.some((command) => command.name === "lock"));
        assert.ok(call.body.some((command) => command.name === "unlock"));
        assert.ok(call.body.every((command) => !("contexts" in command) && !("integration_types" in command)));
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
        await disposeFailedLogin(bot);
        REST.prototype.put = originalPut;
        globalThis.fetch = originalFetch;
        for (const socket of server.clients)
            socket.terminate();
        await new Promise((resolve) => server.close(() => resolve()));
        await fs.rm(directory, { recursive: true, force: true });
    }
});
//# sourceMappingURL=deployCommands.test.js.map