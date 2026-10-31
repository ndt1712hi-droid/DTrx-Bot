import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ChannelType, Client, ClientUser, MessageFlags, PermissionFlagsBits as P, PermissionsBitField } from "discord.js";
import { DEFAULT_INTERVAL_SECONDS, MAX_TRACKED_REMINDER_MESSAGES, MentionReminderStore, } from "../core/mentionReminderStore.js";
import { MentionReminderService, isMentionReminderButton } from "../handlers/mentionReminderHandler.js";
import { registerInteractionHandler } from "../handlers/interactionHandler.js";
function manualScheduler() {
    const tasks = [];
    const schedule = (run, delay) => {
        const task = { run, delay, cancelled: false };
        tasks.push(task);
        return () => { task.cancelled = true; };
    };
    async function fire(delay) {
        const task = tasks.find((item) => !item.cancelled && item.delay === delay);
        if (!task)
            return false;
        task.cancelled = true;
        await task.run();
        return true;
    }
    return { schedule, tasks, fire, count: (delay) => tasks.filter((item) => !item.cancelled && item.delay === delay).length };
}
async function fixture(options = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dtrx-reminder-"));
    const file = path.join(directory, "reminders.json");
    const guildId = "100000000000000001", channelId = "200000000000000002", targetId = "300000000000000003";
    const callerId = "400000000000000004", botId = "500000000000000005", otherId = "600000000000000006";
    const all = new PermissionsBitField(P.ViewChannel | P.SendMessages | P.ReadMessageHistory);
    const caller = { id: callerId, permissions: new PermissionsBitField(options.callerCanManage === false ? 0n : P.ManageGuild), user: { id: callerId, bot: false } };
    const target = { id: targetId, user: { id: targetId, bot: Boolean(options.targetBot) } };
    const bot = { id: botId, user: { id: botId, bot: true } };
    const messages = new Map();
    const sent = [];
    let seq = 0;
    let sendGate;
    let onBlockedSend;
    let deleteFailure = new Set();
    const channel = {
        id: channelId, guildId, type: ChannelType.GuildText,
        permissionsFor(person) {
            if (person.id === targetId && options.targetCanView === false)
                return new PermissionsBitField(0n);
            if (person.id === botId && options.botCanSend === false)
                return new PermissionsBitField(P.ViewChannel);
            return all;
        },
        async send(payload) {
            if (sendGate) {
                onBlockedSend?.();
                await sendGate;
            }
            const id = `700000000000000${String(++seq).padStart(3, "0")}`;
            const message = { id, author: { id: botId }, async delete() {
                    if (deleteFailure.has(id))
                        throw Object.assign(new Error("missing permissions"), { code: 50013 });
                    messages.delete(id);
                } };
            messages.set(id, message);
            sent.push({ payload, message });
            return message;
        },
        messages: { async fetch({ message }) {
                const found = messages.get(message);
                if (!found)
                    throw Object.assign(new Error("unknown message"), { code: 10008 });
                return found;
            } },
    };
    const guild = {
        id: guildId, ownerId: "900000000000000009",
        members: { async fetch({ user }) { return user === callerId ? caller : user === targetId ? target : null; }, async fetchMe() { return bot; } },
        channels: { async fetch(id) { return id === channelId ? channel : null; } },
    };
    const client = { user: { id: botId } };
    const replies = [];
    const ctx = { guild, member: caller, userId: callerId, textChannelId: channelId,
        defer: async () => undefined, reply: async (payload) => { replies.push(payload); } };
    const scheduler = manualScheduler();
    let store = new MentionReminderStore(file);
    let service = new MentionReminderService(client, store, scheduler.schedule);
    function button(action, entry, actor = targetId) {
        const row = entry.payload.components[0].toJSON();
        const component = row.components.find((item) => item.custom_id.startsWith(`tagremind:${action}:`));
        assert.ok(component, `Button ${action} missing`);
        const result = { guildId, customId: component.custom_id, user: { id: actor }, message: { id: entry.message.id,
                async edit(payload) { entry.payload = { ...entry.payload, ...payload }; } },
            memberPermissions: new PermissionsBitField(0n), response: undefined, flags: undefined,
            async deferReply(payload) { this.flags = payload.flags; },
            async editReply(payload) { this.response = payload.content; },
            async reply(payload) { this.response = payload.content; this.flags = payload.flags; },
        };
        return result;
    }
    async function configure(input = {}) {
        await service.manage(ctx, "set", { targetId, count: 3, ...input });
    }
    async function start() {
        await service.manage(ctx, "on");
    }
    async function restart() { await service.close(); store = new MentionReminderStore(file); service = new MentionReminderService(client, store, scheduler.schedule); }
    async function dispose() { await service.close().catch(() => undefined); await fs.rm(directory, { recursive: true, force: true }); }
    return { directory, file, guildId, channelId, targetId, callerId, otherId, botId, guild, caller, target, bot, channel, messages, sent, replies, ctx,
        scheduler, button, configure, start, restart, dispose,
        setGate: (gate, signal) => { sendGate = gate; onBlockedSend = signal; },
        setDeleteFailure: (ids) => { deleteFailure = new Set(ids); },
        get store() { return store; }, get service() { return service; } };
}
test("configuration defaults to 100 and starts directly with only the chosen user pinged", async () => {
    const f = await fixture();
    try {
        await f.configure({ count: undefined, text: "Nhắc nhé @everyone <@600000000000000006>" });
        const record = await f.store.get(f.guildId);
        assert.equal(record?.config?.intervalSeconds, DEFAULT_INTERVAL_SECONDS);
        assert.equal(record?.config?.count, 100);
        assert.equal(f.sent.length, 0, "/set does not send anything");
        await f.start();
        assert.match(f.replies.at(-1).content, /Đã bắt đầu/);
        assert.equal(f.sent.length, 0, "No consent prompt is sent");
        assert.equal(f.scheduler.count(0), 1, "/on immediately schedules the first ping without a button press");
        assert.equal(await f.scheduler.fire(0), true);
        assert.equal(f.sent.length, 1);
        assert.deepEqual(f.sent[0].payload.allowedMentions, { parse: [], users: [f.targetId], repliedUser: false });
        assert.match(f.sent[0].payload.content, new RegExp(`<@${f.targetId}>`));
        assert.ok(f.button("stop", f.sent[0]));
        assert.equal(f.scheduler.count(30_000), 1);
    }
    finally {
        await f.dispose();
    }
});
test("runs a bounded count on a single timer and stops automatically", async () => {
    const f = await fixture();
    try {
        await f.configure({ count: 3, intervalSeconds: 10 });
        await f.start();
        assert.equal(await f.scheduler.fire(0), true);
        assert.equal(await f.scheduler.fire(10_000), true);
        assert.equal(await f.scheduler.fire(10_000), true);
        assert.equal(f.sent.length, 3, "Exactly three mentions and no consent prompt");
        assert.equal(f.scheduler.count(10_000), 0);
        await f.service.manage(f.ctx, "status");
        assert.match(f.replies.at(-1).content, /Đang dừng/);
        assert.equal((await f.store.get(f.guildId))?.messages.length, 3);
    }
    finally {
        await f.dispose();
    }
});
test("a custom 100-message run ends automatically and retains cleanup references", async () => {
    const f = await fixture();
    try {
        await f.configure({ count: 100, intervalSeconds: 5 });
        await f.start();
        assert.equal(await f.scheduler.fire(0), true);
        for (let i = 1; i < 100; i++)
            assert.equal(await f.scheduler.fire(5_000), true);
        assert.equal(f.sent.length, 100);
        assert.equal((await f.store.get(f.guildId))?.messages.length, 100);
        assert.equal(f.scheduler.count(5_000), 0);
        await f.service.manage(f.ctx, "status");
        assert.match(f.replies.at(-1).content, /Đang dừng/);
        assert.ok(f.sent.every(({ payload }) => payload.allowedMentions.users.length === 1 && payload.allowedMentions.users[0] === f.targetId));
    }
    finally {
        await f.dispose();
    }
});
test("custom maximum interval is converted to milliseconds without a hidden fixed time", async () => {
    const f = await fixture();
    try {
        await f.configure({ count: 2, intervalSeconds: 100 });
        assert.equal((await f.store.get(f.guildId))?.config?.intervalSeconds, 100);
        await f.start();
        await f.scheduler.fire(0);
        assert.equal(f.scheduler.count(100_000), 1);
        assert.equal(await f.scheduler.fire(100_000), true);
        assert.equal(f.sent.length, 2);
    }
    finally {
        await f.dispose();
    }
});
test("configurations saved by version 1.3 remain usable after upgrade", async () => {
    const f = await fixture();
    try {
        await f.service.close();
        await fs.writeFile(f.file, JSON.stringify([{ guildId: f.guildId,
                config: { guildId: f.guildId, channelId: f.channelId, targetId: f.targetId, intervalSeconds: 45, count: 10, text: "Cũ" },
                messages: [] }]));
        const store = new MentionReminderStore(f.file);
        const service = new MentionReminderService({ user: { id: f.botId } }, store, f.scheduler.schedule);
        try {
            assert.equal((await store.get(f.guildId))?.config?.count, 10);
            await service.manage(f.ctx, "on");
            await f.scheduler.fire(0);
            assert.equal(f.sent.length, 1);
            assert.equal(f.scheduler.count(45_000), 1);
        }
        finally {
            await service.close();
        }
    }
    finally {
        await f.dispose();
    }
});
test("legacy intervals above 100 seconds load safely but require reconfiguration before starting", async () => {
    const f = await fixture();
    try {
        await f.service.close();
        await fs.writeFile(f.file, JSON.stringify([{ guildId: f.guildId,
                config: { guildId: f.guildId, channelId: f.channelId, targetId: f.targetId, intervalSeconds: 3600, count: 10, text: "Cũ" },
                messages: [{ channelId: f.channelId, messageId: "older-message" }] }]));
        const store = new MentionReminderStore(f.file);
        const service = new MentionReminderService({ user: { id: f.botId } }, store, f.scheduler.schedule);
        try {
            assert.equal((await store.get(f.guildId))?.config?.intervalSeconds, 3600, "Preserve the old value");
            await service.manage(f.ctx, "on");
            assert.match(f.replies.at(-1).content, /đặt lại từ 5 đến 100 giây/);
            assert.equal(f.scheduler.count(0), 0);
            assert.equal(f.sent.length, 0);
            await service.manage(f.ctx, "set", { targetId: f.targetId, intervalSeconds: 100, count: 1 });
            await service.manage(f.ctx, "on");
            await f.scheduler.fire(0);
            assert.equal(f.sent.length, 1);
            assert.equal((await store.get(f.guildId))?.messages.length, 2, "Old cleanup references remain");
        }
        finally {
            await service.close();
        }
    }
    finally {
        await f.dispose();
    }
});
test("a failed start acknowledgement cancels its scheduled run", async () => {
    const f = await fixture();
    try {
        await f.configure();
        const originalReply = f.ctx.reply;
        let first = true;
        f.ctx.reply = async (payload) => { if (first) {
            first = false;
            throw new Error("reply failed");
        } await originalReply(payload); };
        await f.start();
        assert.match(f.replies.at(-1).content, /Không thể xử lý/);
        assert.equal(f.scheduler.count(0), 0);
        assert.equal(f.sent.length, 0);
    }
    finally {
        await f.dispose();
    }
});
test("the target can stop without being an administrator but a stranger cannot", async () => {
    const f = await fixture();
    try {
        await f.configure();
        await f.start();
        await f.scheduler.fire(0);
        const firstPing = f.sent.at(-1);
        const stranger = f.button("stop", firstPing, f.otherId);
        await f.service.handleButton(stranger);
        assert.match(stranger.response, /Chỉ người nhận/);
        const stop = f.button("stop", firstPing);
        await f.service.handleButton(stop);
        assert.equal(stop.flags, MessageFlags.Ephemeral);
        assert.match(stop.response, /Đã dừng tag/);
        assert.equal(f.scheduler.count(30_000), 0);
    }
    finally {
        await f.dispose();
    }
});
test("/off cancels an immediate run and /delete stops the run but retains cleanup references", async () => {
    const f = await fixture();
    try {
        await f.configure();
        await f.start();
        await f.service.manage(f.ctx, "off");
        assert.equal(f.scheduler.count(0), 0);
        assert.equal(f.sent.length, 0);
        await f.start();
        await f.scheduler.fire(0);
        await f.service.manage(f.ctx, "delete");
        assert.match(f.replies.at(-1).content, /Đã dừng và xóa cấu hình/);
        assert.equal((await f.store.get(f.guildId))?.config, null);
        assert.equal((await f.store.get(f.guildId))?.messages.length, 1);
        assert.equal(f.scheduler.count(30_000), 0);
        await f.service.manage(f.ctx, "clear");
        assert.equal(f.messages.size, 0);
        assert.equal(await f.store.get(f.guildId), undefined);
    }
    finally {
        await f.dispose();
    }
});
test("cleanup deletes only tracked messages authored by this bot, retaining failures", async () => {
    const f = await fixture();
    try {
        await f.configure();
        await f.start();
        await f.scheduler.fire(0);
        const refs = (await f.store.get(f.guildId)).messages;
        const otherId = "888888888888888888";
        let otherDeleted = false;
        f.messages.set(otherId, { id: otherId, author: { id: f.otherId }, async delete() { otherDeleted = true; } });
        await f.store.addMessage(f.guildId, { channelId: f.channelId, messageId: otherId });
        f.setDeleteFailure([refs[0].messageId]);
        await f.service.manage(f.ctx, "clear");
        assert.equal(otherDeleted, false);
        assert.match(f.replies.at(-1).content, /Còn 2 tin chưa dọn/);
        assert.equal((await f.store.get(f.guildId))?.messages.length, 2);
        f.setDeleteFailure([]);
        f.messages.delete(otherId); // already deleted outside the bot; a Discord 10008 is safe to forget
        await f.service.manage(f.ctx, "clear");
        assert.equal((await f.store.get(f.guildId))?.messages.length, 0);
    }
    finally {
        await f.dispose();
    }
});
test("restart does not resume active reminders but preserves config and tracked messages", async () => {
    const f = await fixture();
    try {
        await f.configure();
        await f.start();
        await f.scheduler.fire(0);
        assert.equal(f.scheduler.count(30_000), 1);
        await f.restart();
        assert.equal(f.scheduler.count(30_000), 0);
        await f.service.manage(f.ctx, "status");
        assert.match(f.replies.at(-1).content, /Đang dừng/);
        assert.ok((await f.store.get(f.guildId))?.config);
        assert.equal((await f.store.get(f.guildId))?.messages.length, 1);
    }
    finally {
        await f.dispose();
    }
});
test("legacy consent buttons from an older deployment are inert", async () => {
    const f = await fixture();
    try {
        await f.configure();
        for (const action of ["yes", "no"]) {
            const click = { guildId: f.guildId, customId: `tagremind:${action}:00000000-0000-4000-8000-000000000000`,
                response: "", flags: undefined, async reply(payload) { this.response = payload.content; this.flags = payload.flags; } };
            await f.service.handleButton(click);
            assert.match(click.response, /hết hiệu lực/);
            assert.equal(click.flags, MessageFlags.Ephemeral);
        }
        assert.equal(f.scheduler.count(0), 0);
        assert.equal(f.sent.length, 0);
    }
    finally {
        await f.dispose();
    }
});
test("invalid frequencies, unprivileged callers, inaccessible channels and bot targets are rejected", async () => {
    const invalid = await fixture();
    try {
        for (const input of [{ intervalSeconds: 4 }, { intervalSeconds: 101 }, { count: 0 }, { count: 101 }, { text: "x".repeat(201) }]) {
            await invalid.configure(input);
            assert.match(invalid.replies.at(-1).content, /❌/);
        }
        assert.equal(await invalid.store.get(invalid.guildId), undefined);
    }
    finally {
        await invalid.dispose();
    }
    for (const options of [{ callerCanManage: false }, { botCanSend: false }, { targetCanView: false }, { targetBot: true }]) {
        const f = await fixture(options);
        try {
            await f.configure();
            assert.match(f.replies.at(-1).content, /❌/);
            assert.equal(f.sent.length, 0);
        }
        finally {
            await f.dispose();
        }
    }
});
test("corrupt storage is not overwritten and no approval or ping is sent", async () => {
    const f = await fixture();
    try {
        await f.service.close();
        await fs.writeFile(f.file, "not json");
        const store = new MentionReminderStore(f.file);
        const service = new MentionReminderService({ user: { id: f.botId } }, store, f.scheduler.schedule);
        await service.manage(f.ctx, "set", { targetId: f.targetId });
        assert.match(f.replies.at(-1).content, /Không thể xử lý/);
        assert.equal(await fs.readFile(f.file, "utf8"), "not json");
        assert.equal(f.sent.length, 0);
        await service.close().catch(() => undefined);
    }
    finally {
        await f.dispose();
    }
});
test("a full message ledger refuses new runs instead of forgetting messages", async () => {
    const f = await fixture();
    try {
        await f.configure({ count: 2 });
        for (let i = 0; i < MAX_TRACKED_REMINDER_MESSAGES - 1; i++)
            await f.store.addMessage(f.guildId, { channelId: f.channelId, messageId: `tracked-${i}` });
        await f.service.manage(f.ctx, "on");
        assert.match(f.replies.at(-1).content, /danh sách tin bot đã đầy/i);
        assert.equal(f.sent.length, 0);
    }
    finally {
        await f.dispose();
    }
});
test("button routing recognizes only the reminder prefix", () => {
    assert.equal(isMentionReminderButton("tagremind:yes:abc"), true);
    assert.equal(isMentionReminderButton("zi:prev"), false);
});
test("/off waits for an in-flight Discord send and prevents any later tick", async () => {
    const f = await fixture();
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const inSend = new Promise((resolve) => { entered = resolve; });
    try {
        await f.configure();
        await f.start();
        f.setGate(gate, entered);
        const tick = f.scheduler.fire(0);
        await inSend;
        let offFinished = false;
        const off = f.service.manage(f.ctx, "off").then(() => { offFinished = true; });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(offFinished, false, "Stop acknowledges only after the outstanding Discord request resolves");
        release();
        await tick;
        await off;
        assert.equal(offFinished, true);
        assert.equal(f.sent.length, 1, "The already-submitted send may complete, but no new send is scheduled");
        assert.equal(f.scheduler.count(30_000), 0);
        assert.equal((await f.store.get(f.guildId))?.messages.length, 1);
    }
    finally {
        release();
        await f.dispose();
    }
});
test("concurrent starts reserve slots before network work, limiting the bot to four guilds", async () => {
    const fixtures = await Promise.all(Array.from({ length: 5 }, () => fixture()));
    const first = fixtures[0];
    const shared = new MentionReminderService({ user: { id: first.botId } }, first.store, first.scheduler.schedule);
    const releases = [];
    try {
        for (let i = 0; i < fixtures.length; i++) {
            const f = fixtures[i];
            f.guild.id = `1000000000000000${String(i + 10)}`;
            f.channel.guildId = f.guild.id;
            await shared.manage(f.ctx, "set", { targetId: f.targetId, count: 1 });
        }
        const waits = [];
        const requests = [];
        for (let i = 0; i < 4; i++) {
            const f = fixtures[i];
            let release, entered;
            const gate = new Promise((resolve) => { release = resolve; });
            const wait = new Promise((resolve) => { entered = resolve; });
            releases.push(release);
            waits.push(wait);
            const originalFetch = f.guild.members.fetch;
            f.guild.members.fetch = async (input) => {
                if (input.user === f.targetId) {
                    entered();
                    await gate;
                }
                return originalFetch(input);
            };
            requests.push(shared.manage(f.ctx, "on"));
        }
        await Promise.all(waits);
        await shared.manage(fixtures[4].ctx, "on");
        assert.match(fixtures[4].replies.at(-1).content, /đủ số đợt/);
        assert.equal(fixtures[4].sent.length, 0);
        for (const release of releases)
            release();
        await Promise.all(requests);
        assert.ok(fixtures.slice(0, 4).every((f) => /Đã bắt đầu/.test(f.replies.at(-1).content)));
        assert.equal(first.scheduler.count(0), 4);
    }
    finally {
        for (const release of releases)
            release();
        await shared.close();
        await Promise.all(fixtures.map((f) => f.dispose()));
    }
});
test("store serializes concurrent guild changes and keeps separate configurations across reloads", async () => {
    const f = await fixture();
    try {
        await Promise.all(Array.from({ length: 10 }, (_, i) => f.store.setConfig({
            guildId: `guild-${i}`, channelId: f.channelId, targetId: f.targetId,
            intervalSeconds: 30, count: 3, text: `Nhắc ${i}`,
        })));
        const another = new MentionReminderStore(f.file);
        for (let i = 0; i < 10; i++)
            assert.equal((await another.get(`guild-${i}`))?.config?.text, `Nhắc ${i}`);
        await another.flush();
    }
    finally {
        await f.dispose();
    }
});
test("a new run cannot bypass the minimum gap by being restarted immediately", async () => {
    const f = await fixture();
    try {
        await f.configure({ count: 1, intervalSeconds: 5 });
        await f.start();
        await f.scheduler.fire(0);
        await f.start();
        const pending = f.scheduler.tasks.filter((task) => !task.cancelled && task.delay < 120_000);
        assert.equal(pending.length, 1);
        assert.ok(pending[0].delay > 0 && pending[0].delay <= 5_000, "New run waits until five seconds have elapsed");
        assert.equal(f.sent.length, 1, "Only the first run has pinged");
    }
    finally {
        await f.dispose();
    }
});
test("closing during target validation prevents a late start", async () => {
    const f = await fixture();
    let release, entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    try {
        await f.configure();
        const originalFetch = f.guild.members.fetch;
        f.guild.members.fetch = async (input) => {
            if (input.user === f.targetId) {
                entered();
                await gate;
            }
            return originalFetch(input);
        };
        const on = f.start();
        await started;
        const closing = f.service.close();
        release();
        await Promise.all([on, closing]);
        assert.equal(f.sent.length, 0);
        assert.equal(f.scheduler.count(0), 0);
    }
    finally {
        release();
        await f.dispose();
    }
});
test("slash inputs and reminder buttons route with private acknowledgements", async () => {
    const client = new EventEmitter();
    const calls = [], buttonCalls = [], deferrals = [];
    registerInteractionHandler({ client }, {}, {}, undefined, undefined, {
        manage: async (...args) => { calls.push(args); },
        handleButton: async (interaction) => { buttonCalls.push(interaction); },
    });
    const listener = client.listeners("interactionCreate")[0];
    const member = { id: "caller" }, guild = { id: "guild", members: { cache: new Map([["caller", member]]) } };
    for (const mode of ["set", "on", "off", "delete", "clear", "status"]) {
        const interaction = {
            commandName: "spam", guildId: guild.id, guild, user: { id: "caller" }, channelId: "channel",
            deferred: false, replied: false, isAutocomplete: () => false, isButton: () => false,
            isStringSelectMenu: () => false, isChatInputCommand: () => true, inGuild: () => true,
            options: { getSubcommand: () => mode, getUser: () => ({ id: "chosen" }), getChannel: () => ({ id: "selected-channel" }),
                getInteger: (key) => key === "interval" ? 60 : 4, getString: () => "Test" },
            async deferReply(options) { deferrals.push(options); this.deferred = true; },
        };
        await listener(interaction);
    }
    assert.equal(calls.length, 6);
    assert.deepEqual(calls.map((call) => call[1]), ["set", "on", "off", "delete", "clear", "status"]);
    assert.deepEqual(calls[0][2], { targetId: "chosen", channelId: "selected-channel", intervalSeconds: 60, count: 4, text: "Test" });
    assert.ok(deferrals.every((value) => value.flags === MessageFlags.Ephemeral));
    const button = { customId: "tagremind:stop:token", isAutocomplete: () => false, isButton: () => true };
    await listener(button);
    assert.deepEqual(buttonCalls, [button]);
});
test("a manager can stop an immediately scheduled run before the first mention", async () => {
    const f = await fixture();
    try {
        await f.configure();
        await f.start();
        assert.equal(f.scheduler.count(0), 1);
        await f.service.manage(f.ctx, "off");
        assert.equal(f.scheduler.count(0), 0);
        assert.equal(f.sent.length, 0);
    }
    finally {
        await f.dispose();
    }
});
test("a stale stop button from a previous run cannot stop a later run", async () => {
    const f = await fixture();
    try {
        await f.configure({ count: 1 });
        await f.start();
        await f.scheduler.fire(0);
        const old = f.button("stop", f.sent[0]);
        await f.start();
        await f.service.handleButton(old);
        assert.match(old.response, /đã dừng/);
        assert.equal(f.scheduler.tasks.filter((task) => !task.cancelled).length, 1);
    }
    finally {
        await f.dispose();
    }
});
test("a later /off cannot overtake a slow /on during its permission lookup", async () => {
    const f = await fixture();
    let release, entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    try {
        await f.configure();
        const fetchMember = f.guild.members.fetch;
        let block = true;
        f.guild.members.fetch = async (input) => {
            if (input.user === f.callerId && block) {
                block = false;
                entered();
                await gate;
            }
            return fetchMember(input);
        };
        const on = f.service.manage(f.ctx, "on");
        await started;
        let offFinished = false;
        const off = f.service.manage(f.ctx, "off").then(() => { offFinished = true; });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(offFinished, false, "The later stop waits behind the earlier start");
        release();
        await Promise.all([on, off]);
        assert.equal(f.sent.length, 0);
        assert.equal(f.scheduler.count(0), 0);
    }
    finally {
        release();
        await f.dispose();
    }
});
test("real discord.js objects serialize immediate mention and cleanup REST payloads offline", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dtrx-discordjs-reminder-"));
    const ids = { guild: "100000000000000001", channel: "200000000000000002", target: "300000000000000003",
        admin: "400000000000000004", bot: "500000000000000005", role: "600000000000000006" };
    const client = new Client({ intents: [] });
    const rawUser = (id, bot = false) => ({ id, username: `user-${id.slice(-2)}`, discriminator: "0001", avatar: null, bot });
    client.user = new ClientUser(client, rawUser(ids.bot, true));
    const rawMember = (user, roles = []) => ({ user, roles, joined_at: "2024-01-01T00:00:00.000Z", deaf: false, mute: false, flags: 0 });
    const members = {
        [ids.admin]: rawMember(rawUser(ids.admin), [ids.role]), [ids.target]: rawMember(rawUser(ids.target)), [ids.bot]: rawMember(rawUser(ids.bot, true)),
    };
    const everyone = { id: ids.guild, name: "@everyone", permissions: (P.ViewChannel | P.SendMessages | P.ReadMessageHistory).toString(),
        position: 0, color: 0, hoist: false, managed: false, mentionable: false };
    const moderator = { ...everyone, id: ids.role, name: "Manager", permissions: P.ManageGuild.toString(), position: 1 };
    const rawChannel = { id: ids.channel, guild_id: ids.guild, type: ChannelType.GuildText, name: "reminders", position: 0, permission_overwrites: [] };
    const guild = client.guilds._add({ id: ids.guild, name: "Test", owner_id: "999999999999999999", roles: [everyone, moderator],
        channels: [rawChannel], members: Object.values(members) });
    const messages = new Map();
    const calls = [];
    let sequence = 0;
    client.rest.get = async (route) => {
        calls.push({ method: "GET", route });
        if (route === `/channels/${ids.channel}`)
            return rawChannel;
        if (route.startsWith(`/guilds/${ids.guild}/members/`))
            return members[route.split("/").at(-1)];
        const match = new RegExp(`^/channels/${ids.channel}/messages/(.+)$`).exec(route);
        if (match && messages.has(match[1]))
            return messages.get(match[1]);
        throw new Error(`Unexpected fake GET ${route}`);
    };
    client.rest.post = async (route, { body }) => {
        calls.push({ method: "POST", route, body });
        const message = { id: `700000000000000${String(++sequence).padStart(3, "0")}`, channel_id: ids.channel, guild_id: ids.guild,
            author: rawUser(ids.bot, true), content: body.content, timestamp: "2024-01-01T00:00:00.000Z", edited_timestamp: null, tts: false,
            mention_everyone: false, mentions: [], mention_roles: [], attachments: [], embeds: [], type: 0, components: body.components };
        messages.set(message.id, message);
        return message;
    };
    client.rest.patch = async (route, { body }) => {
        calls.push({ method: "PATCH", route, body });
        const id = route.split("/").at(-1);
        const defined = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
        const message = { ...messages.get(id), ...defined };
        messages.set(id, message);
        return message;
    };
    client.rest.delete = async (route) => { calls.push({ method: "DELETE", route }); messages.delete(route.split("/").at(-1)); };
    const store = new MentionReminderStore(path.join(directory, "state.json"));
    const timer = manualScheduler();
    const service = new MentionReminderService(client, store, timer.schedule);
    const replies = [];
    const ctx = { guild, userId: ids.admin, member: guild.members.cache.get(ids.admin), textChannelId: ids.channel, reply: async (payload) => { replies.push(payload); } };
    try {
        await service.manage(ctx, "set", { targetId: ids.target, count: 2, text: "@everyone" });
        assert.match(replies.at(-1).content, /Đã lưu/);
        await service.manage(ctx, "on");
        assert.equal(calls.filter((call) => call.method === "POST").length, 0, "No consent prompt is posted");
        await timer.fire(0);
        const ping = calls.find((call) => call.method === "POST");
        assert.deepEqual(ping.body.allowed_mentions, { parse: [], users: [ids.target], replied_user: false });
        assert.match(ping.body.components[0].components[0].custom_id, /^tagremind:stop:/);
        await service.manage(ctx, "clear");
        assert.equal(messages.size, 0);
        assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
        assert.match(replies.at(-1).content, /Đã dọn 1 tin/);
    }
    finally {
        await service.close();
        await client.destroy();
        await fs.rm(directory, { recursive: true, force: true });
    }
});
test("cleanup cannot delete messages from a channel the manager cannot view", async () => {
    const f = await fixture();
    try {
        await f.configure();
        await f.start();
        await f.scheduler.fire(0);
        const permissionsFor = f.channel.permissionsFor;
        f.channel.permissionsFor = (member) => member.id === f.callerId ? new PermissionsBitField(0n) : permissionsFor(member);
        await f.service.manage(f.ctx, "clear");
        assert.equal(f.messages.size, 1);
        assert.equal((await f.store.get(f.guildId))?.messages.length, 1);
        assert.match(f.replies.at(-1).content, /Còn 1 tin chưa dọn/);
    }
    finally {
        await f.dispose();
    }
});
test("a failed deferred reminder button receives an error instead of hanging", async () => {
    const client = new EventEmitter();
    registerInteractionHandler({ client }, {}, {}, undefined, undefined, {
        handleButton: async (interaction) => { interaction.deferred = true; throw new Error("simulated button error"); },
    });
    const listener = client.listeners("interactionCreate")[0];
    const interaction = { customId: "tagremind:yes:token", deferred: false, replied: false, response: undefined,
        isAutocomplete: () => false, isButton: () => true, isRepliable: () => true, isChatInputCommand: () => false,
        async editReply(payload) { this.response = payload.content; } };
    await listener(interaction);
    assert.match(interaction.response, /Đã xảy ra lỗi/);
});
//# sourceMappingURL=mentionReminder.test.js.map