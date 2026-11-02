import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ChannelType, Client, ClientUser, Collection, MessageFlags, PermissionFlagsBits as P, PermissionsBitField, SnowflakeUtil } from "discord.js";
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
async function waitFor(condition, timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(condition(), true, "Timed out waiting for the expected test state");
}
async function fixture(options = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dtrx-reminder-"));
    const file = path.join(directory, "reminders.json");
    const guildId = "100000000000000001", channelId = "200000000000000002", targetId = "300000000000000003";
    const callerId = "400000000000000004", botId = "500000000000000005", otherId = "600000000000000006";
    const all = new PermissionsBitField(P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.ManageMessages);
    const caller = { id: callerId, permissions: new PermissionsBitField(options.callerCanManage === false ? 0n : P.ManageGuild), user: { id: callerId, bot: false } };
    const target = { id: targetId, permissions: new PermissionsBitField(0n), user: { id: targetId, bot: Boolean(options.targetBot) } };
    const bot = { id: botId, user: { id: botId, bot: true } };
    const messages = new Map();
    const sent = [];
    const bulkCalls = [];
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
            const message = { id, author: { id: botId }, createdTimestamp: Date.now(), async delete() {
                    if (deleteFailure.has(id))
                        throw Object.assign(new Error("missing permissions"), { code: 50013 });
                    messages.delete(id);
                } };
            messages.set(id, message);
            sent.push({ payload, message });
            return message;
        },
        async bulkDelete(ids) {
            bulkCalls.push([...ids]);
            if (ids.some((id) => deleteFailure.has(id)))
                throw Object.assign(new Error("bulk delete failed"), { code: 50013 });
            for (const id of ids)
                messages.delete(id);
        },
        messages: { async fetch(options) {
                if (options.message) {
                    const found = messages.get(options.message);
                    if (!found)
                        throw Object.assign(new Error("unknown message"), { code: 10008 });
                    return found;
                }
                const sorted = [...messages.values()].sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));
                const anchor = sorted.findIndex((message) => message.id >= (options.around ?? ""));
                const count = options.limit ?? 100;
                const start = Math.max(0, Math.min(sorted.length - count, (anchor < 0 ? sorted.length - 1 : anchor) - Math.floor(count / 2)));
                return new Collection(sorted.slice(start, start + count).map((message) => [message.id, message]));
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
    async function configure(input = {}) {
        await service.manage(ctx, "set", { targetId, count: 3, ...input });
    }
    async function start() {
        await service.manage(ctx, "on");
    }
    async function clear() {
        let finished = false;
        const operation = service.manage(ctx, "clear").finally(() => { finished = true; });
        const deadline = Date.now() + 2_000;
        while (!finished && scheduler.count(5_000) === 0 && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 1));
        if (scheduler.count(5_000))
            await scheduler.fire(5_000);
        else
            assert.equal(finished, true, "clear should finish or schedule its delay");
        await operation;
    }
    async function restart() { await service.close(); store = new MentionReminderStore(file); service = new MentionReminderService(client, store, scheduler.schedule); }
    async function dispose() { await service.close().catch(() => undefined); await fs.rm(directory, { recursive: true, force: true }); }
    return { directory, file, guildId, channelId, targetId, callerId, otherId, botId, guild, caller, target, bot, channel, messages, sent, bulkCalls, replies, ctx,
        scheduler, configure, start, clear, restart, dispose,
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
        assert.equal(f.sent[0].payload.components, undefined, "New mentions have no stop button");
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
        await f.configure({ count: 100, intervalSeconds: 1 });
        await f.start();
        assert.equal(await f.scheduler.fire(0), true);
        for (let i = 1; i < 100; i++)
            assert.equal(await f.scheduler.fire(1_000), true);
        assert.equal(f.sent.length, 100);
        assert.equal((await f.store.get(f.guildId))?.messages.length, 100);
        assert.equal(f.scheduler.count(1_000), 0);
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
            assert.match(f.replies.at(-1).content, /đặt lại từ 1 đến 100 giây/);
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
test("the target can stop by slash command without admin rights, but a stranger cannot", async () => {
    const f = await fixture();
    try {
        await f.configure();
        await f.start();
        await f.scheduler.fire(0);
        assert.equal(f.sent[0].payload.components, undefined);
        const strangerCtx = { ...f.ctx, userId: f.otherId };
        await f.service.manage(strangerCtx, "off");
        assert.match(f.replies.at(-1).content, /Quản lý máy chủ/);
        assert.equal(f.scheduler.count(30_000), 1);
        const targetCtx = { ...f.ctx, userId: f.targetId, member: f.target };
        await f.service.manage(targetCtx, "off");
        assert.match(f.replies.at(-1).content, /Đã dừng nhắc tag/);
        assert.equal(f.scheduler.count(30_000), 0);
    }
    finally {
        await f.dispose();
    }
});
test("the recipient cannot configure, start, delete, clear or inspect as an ordinary member", async () => {
    const f = await fixture();
    try {
        await f.configure();
        await f.start();
        const targetCtx = { ...f.ctx, userId: f.targetId, member: f.target };
        for (const mode of ["set", "on", "delete", "clear", "status"]) {
            await f.service.manage(targetCtx, mode, { targetId: f.targetId });
            assert.match(f.replies.at(-1).content, /Quản lý máy chủ/, `${mode} must stay admin-only`);
        }
        assert.equal(f.scheduler.count(0), 1);
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
        await f.clear();
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
        await f.clear();
        assert.equal(otherDeleted, false);
        assert.match(f.replies.at(-1).content, /Còn 2 tin chưa dọn/);
        assert.equal((await f.store.get(f.guildId))?.messages.length, 2);
        f.setDeleteFailure([]);
        f.messages.delete(otherId); // already deleted outside the bot; a Discord 10008 is safe to forget
        await f.clear();
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
test("legacy approval and stop buttons are inert and point to /spam off", async () => {
    const f = await fixture();
    try {
        await f.configure();
        await f.start();
        for (const action of ["yes", "no", "stop"]) {
            const click = { guildId: f.guildId, customId: `tagremind:${action}:00000000-0000-4000-8000-000000000000`,
                response: "", flags: undefined, async reply(payload) { this.response = payload.content; this.flags = payload.flags; } };
            await f.service.handleButton(click);
            assert.match(click.response, /không còn hiệu lực/);
            assert.match(click.response, /\/spam off/);
            assert.equal(click.flags, MessageFlags.Ephemeral);
        }
        assert.equal(f.scheduler.count(0), 1, "Old buttons cannot stop the active run");
        assert.equal(f.sent.length, 0);
    }
    finally {
        await f.dispose();
    }
});
test("invalid frequencies, unprivileged callers, inaccessible channels and bot targets are rejected", async () => {
    const invalid = await fixture();
    try {
        for (const input of [{ intervalSeconds: 0 }, { intervalSeconds: 101 }, { count: 0 }, { count: 101 }, { text: "x".repeat(201) }]) {
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
test("the recipient's /spam off waits for an in-flight send and prevents further sends", async () => {
    const f = await fixture();
    let release, entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const inSend = new Promise((resolve) => { entered = resolve; });
    try {
        await f.configure({ intervalSeconds: 1 });
        await f.start();
        f.setGate(gate, entered);
        const tick = f.scheduler.fire(0);
        await inSend;
        const targetCtx = { ...f.ctx, userId: f.targetId, member: f.target };
        let offFinished = false;
        const off = f.service.manage(targetCtx, "off").then(() => { offFinished = true; });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(offFinished, false);
        release();
        await Promise.all([tick, off]);
        assert.equal(f.sent.length, 1, "Only the already-submitted send may finish");
        assert.equal(f.scheduler.count(1_000), 0);
        assert.match(f.replies.at(-1).content, /Đã dừng/);
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
        await f.configure({ count: 1, intervalSeconds: 1 });
        await f.start();
        await f.scheduler.fire(0);
        await f.start();
        const pending = f.scheduler.tasks.filter((task) => !task.cancelled && task.delay < 120_000);
        assert.equal(pending.length, 1);
        assert.ok(pending[0].delay > 0 && pending[0].delay <= 1_000, "New run waits until one second have elapsed");
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
test("the initiator can stop by slash command after losing admin rights", async () => {
    const f = await fixture();
    try {
        await f.configure();
        await f.start();
        await f.scheduler.fire(0);
        f.caller.permissions = new PermissionsBitField(0n);
        await f.service.manage(f.ctx, "off");
        assert.match(f.replies.at(-1).content, /Đã dừng/);
        assert.equal(f.scheduler.count(30_000), 0);
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
            mention_everyone: false, mentions: [], mention_roles: [], attachments: [], embeds: [], type: 0, components: body.components ?? [] };
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
        assert.ok(!ping.body.components || ping.body.components.length === 0, "Real discord.js REST payload contains no button components");
        const clearing = service.manage(ctx, "clear");
        for (let i = 0; i < 100 && timer.count(5_000) === 0; i++)
            await new Promise((resolve) => setImmediate(resolve));
        assert.equal(timer.count(5_000), 1);
        await timer.fire(5_000);
        await clearing;
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
        await f.clear();
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
test("spam clear waits five seconds and deletes recent tracked bot messages in one bulk request", async () => {
    const f = await fixture();
    let clear = Promise.resolve();
    try {
        await f.configure({ count: 3, intervalSeconds: 1 });
        await f.start();
        await f.scheduler.fire(0);
        await f.scheduler.fire(1_000);
        await f.scheduler.fire(1_000);
        const tracked = (await f.store.get(f.guildId)).messages.map((ref) => ref.messageId);
        const bulkCalls = [];
        f.channel.bulkDelete = async (ids) => {
            bulkCalls.push([...ids]);
            for (const id of ids)
                f.messages.delete(id);
        };
        let finished = false;
        clear = f.service.manage(f.ctx, "clear").finally(() => { finished = true; });
        for (let i = 0; i < 50 && !finished && f.scheduler.count(5_000) === 0; i++)
            await new Promise((resolve) => setImmediate(resolve));
        assert.equal(f.scheduler.count(5_000), 1, "One five-second delay is scheduled");
        assert.match(f.replies.at(-1).content, /5 giây/);
        assert.equal(f.messages.size, 3, "Nothing is deleted during the delay");
        assert.equal(bulkCalls.length, 0);
        assert.equal(await f.scheduler.fire(4_999), false);
        await f.scheduler.fire(5_000);
        await clear;
        assert.equal(bulkCalls.length, 1, "Delete all eligible messages with a single request");
        assert.deepEqual(new Set(bulkCalls[0]), new Set(tracked));
        assert.equal(f.messages.size, 0);
        assert.equal((await f.store.get(f.guildId))?.messages.length, 0);
        assert.match(f.replies.at(-1).content, /Đã dọn 3 tin/);
    }
    finally {
        await f.scheduler.fire(5_000);
        await Promise.allSettled([clear]);
        await f.dispose();
    }
});
test("clear batches 250 messages into concurrent requests of at most 100 after one delay", async () => {
    const f = await fixture();
    let clearing = Promise.resolve();
    let release = () => undefined;
    const gate = new Promise((resolve) => { release = resolve; });
    try {
        await f.configure({ count: 1 });
        const ids = [];
        for (let i = 0; i < 250; i++) {
            const id = SnowflakeUtil.generate({ timestamp: Date.now() - 5_000 + i }).toString();
            ids.push(id);
            f.messages.set(id, { id, author: { id: f.botId }, createdTimestamp: Date.now() - 5_000 + i, async delete() { f.messages.delete(id); } });
            await f.store.addMessage(f.guildId, { channelId: f.channelId, messageId: id });
        }
        const batches = [];
        f.channel.bulkDelete = async (values) => { batches.push([...values]); await gate; for (const id of values)
            f.messages.delete(id); };
        clearing = f.service.manage(f.ctx, "clear");
        await waitFor(() => f.scheduler.count(5_000) === 1);
        assert.equal(f.messages.size, 250);
        await f.scheduler.fire(5_000);
        await waitFor(() => batches.length === 3);
        assert.equal(f.messages.size, 250, "All three batch requests were launched before any completed");
        assert.deepEqual(batches.map((batch) => batch.length).sort((a, b) => a - b), [50, 100, 100]);
        assert.deepEqual(new Set(batches.flat()), new Set(ids));
        release();
        await clearing;
        assert.equal(f.messages.size, 0);
        assert.equal((await f.store.get(f.guildId))?.messages.length, 0);
        assert.match(f.replies.at(-1).content, /Đã dọn 250 tin/);
    }
    finally {
        release();
        await f.scheduler.fire(5_000);
        await Promise.allSettled([clearing]);
        await f.dispose();
    }
});
test("clear bulk-deletes recent bot messages only, handles old ones separately, and retains a foreign message", async () => {
    const f = await fixture();
    try {
        await f.configure({ count: 1 });
        const now = Date.now();
        const recent = [now - 10_000, now - 9_000].map((timestamp) => SnowflakeUtil.generate({ timestamp }).toString());
        const oldTime = now - 15 * 24 * 60 * 60 * 1_000;
        const oldId = SnowflakeUtil.generate({ timestamp: oldTime }).toString();
        const foreignId = SnowflakeUtil.generate({ timestamp: now - 8_000 }).toString();
        const missingId = SnowflakeUtil.generate({ timestamp: now - 7_000 }).toString();
        let oldDeletes = 0, foreignDeletes = 0;
        for (const id of recent)
            f.messages.set(id, { id, author: { id: f.botId }, createdTimestamp: now - 10_000, async delete() { f.messages.delete(id); } });
        f.messages.set(oldId, { id: oldId, author: { id: f.botId }, createdTimestamp: oldTime, async delete() { oldDeletes++; f.messages.delete(oldId); } });
        f.messages.set(foreignId, { id: foreignId, author: { id: f.otherId }, createdTimestamp: now - 8_000, async delete() { foreignDeletes++; } });
        for (const id of [...recent, oldId, foreignId, missingId])
            await f.store.addMessage(f.guildId, { channelId: f.channelId, messageId: id });
        await f.clear();
        assert.equal(f.bulkCalls.length, 1);
        assert.deepEqual(new Set(f.bulkCalls[0]), new Set(recent));
        assert.equal(oldDeletes, 1);
        assert.equal(foreignDeletes, 0);
        assert.equal(f.messages.has(foreignId), true);
        assert.deepEqual((await f.store.get(f.guildId))?.messages.map((ref) => ref.messageId), [foreignId]);
        assert.match(f.replies.at(-1).content, /Còn 1 tin chưa dọn/);
        assert.match(f.replies.at(-1).content, /14 ngày/);
    }
    finally {
        await f.dispose();
    }
});
test("clear falls back safely and reports when the bot lacks Manage Messages", async () => {
    const f = await fixture();
    try {
        await f.configure({ count: 3, intervalSeconds: 1 });
        await f.start();
        await f.scheduler.fire(0);
        await f.scheduler.fire(1_000);
        await f.scheduler.fire(1_000);
        const permissionsFor = f.channel.permissionsFor;
        f.channel.permissionsFor = (member) => member.id === f.botId
            ? new PermissionsBitField(P.ViewChannel | P.SendMessages | P.ReadMessageHistory)
            : permissionsFor(member);
        await f.clear();
        assert.equal(f.bulkCalls.length, 0);
        assert.equal(f.messages.size, 0, "The bot can still delete its own messages individually");
        assert.match(f.replies.at(-1).content, /thiếu quyền \*\*Quản lý tin nhắn\*\*/);
    }
    finally {
        await f.dispose();
    }
});
test("a failed bulk request falls back to individual deletions and keeps failed IDs", async () => {
    const f = await fixture();
    try {
        await f.configure({ count: 3, intervalSeconds: 1 });
        await f.start();
        await f.scheduler.fire(0);
        await f.scheduler.fire(1_000);
        await f.scheduler.fire(1_000);
        const failedId = f.sent[0].message.id;
        f.setDeleteFailure([failedId]);
        await f.clear();
        assert.equal(f.bulkCalls.length, 1);
        assert.deepEqual([...f.messages.keys()], [failedId]);
        assert.deepEqual((await f.store.get(f.guildId))?.messages.map((ref) => ref.messageId), [failedId]);
        assert.match(f.replies.at(-1).content, /Còn 1 tin chưa dọn/);
        assert.match(f.replies.at(-1).content, /thử xóa riêng/);
    }
    finally {
        await f.dispose();
    }
});
test("clear rechecks the manager's rights after the five-second delay", async () => {
    const f = await fixture();
    let clearing = Promise.resolve();
    try {
        await f.configure({ count: 2, intervalSeconds: 1 });
        await f.start();
        await f.scheduler.fire(0);
        await f.scheduler.fire(1_000);
        clearing = f.service.manage(f.ctx, "clear");
        await waitFor(() => f.scheduler.count(5_000) === 1);
        f.caller.permissions = new PermissionsBitField(0n);
        await f.scheduler.fire(5_000);
        await clearing;
        assert.equal(f.messages.size, 2);
        assert.equal(f.bulkCalls.length, 0);
        assert.equal((await f.store.get(f.guildId))?.messages.length, 2);
        assert.match(f.replies.at(-1).content, /không còn quyền/);
    }
    finally {
        await f.scheduler.fire(5_000);
        await Promise.allSettled([clearing]);
        await f.dispose();
    }
});
test("shutting down during the five-second wait cancels deletion and preserves the ledger", async () => {
    const f = await fixture();
    let clearing = Promise.resolve();
    try {
        await f.configure({ count: 2, intervalSeconds: 1 });
        await f.start();
        await f.scheduler.fire(0);
        await f.scheduler.fire(1_000);
        clearing = f.service.manage(f.ctx, "clear");
        await waitFor(() => f.scheduler.count(5_000) === 1);
        await f.service.close();
        await clearing;
        assert.equal(f.scheduler.count(5_000), 0);
        assert.equal(f.bulkCalls.length, 0);
        assert.equal(f.messages.size, 2);
        assert.equal((await f.store.get(f.guildId))?.messages.length, 2);
    }
    finally {
        await f.scheduler.fire(5_000);
        await Promise.allSettled([clearing]);
        await f.dispose();
    }
});
test("clear waits for an in-flight spam send before the five-second batch", async () => {
    const f = await fixture();
    let release = () => undefined, entered = () => undefined;
    const gate = new Promise((resolve) => { release = resolve; });
    const blocked = new Promise((resolve) => { entered = resolve; });
    let tick = Promise.resolve(), clearing = Promise.resolve();
    try {
        await f.configure({ count: 2, intervalSeconds: 1 });
        await f.start();
        f.setGate(gate, entered);
        tick = f.scheduler.fire(0);
        await blocked;
        clearing = f.service.manage(f.ctx, "clear");
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(f.scheduler.count(5_000), 0, "Clear must first wait for the outstanding send");
        release();
        await tick;
        await waitFor(() => f.scheduler.count(5_000) === 1);
        assert.equal(f.messages.size, 1);
        await f.scheduler.fire(5_000);
        await clearing;
        assert.equal(f.messages.size, 0);
        assert.equal((await f.store.get(f.guildId))?.messages.length, 0);
        assert.equal(f.scheduler.count(1_000), 0);
    }
    finally {
        release();
        await f.scheduler.fire(5_000);
        await Promise.allSettled([tick, clearing]);
        await f.dispose();
    }
});
test("the real five-second timer sends no deletes early and then removes a batch", { timeout: 10_000 }, async () => {
    const f = await fixture();
    let service;
    let operation = Promise.resolve();
    const keepAlive = setTimeout(() => undefined, 9_000);
    try {
        await f.configure({ count: 3, intervalSeconds: 1 });
        await f.start();
        await f.scheduler.fire(0);
        await f.scheduler.fire(1_000);
        await f.scheduler.fire(1_000);
        await f.service.close();
        service = new MentionReminderService({ user: { id: f.botId } }, f.store);
        let acknowledgedAt = 0, deletedAt = 0;
        const ctx = { ...f.ctx, reply: async (payload) => {
                f.replies.push(payload);
                if (/5 giây/.test(payload.content ?? ""))
                    acknowledgedAt = Date.now();
            } };
        const bulkDelete = f.channel.bulkDelete;
        f.channel.bulkDelete = async (ids) => { deletedAt = Date.now(); return bulkDelete(ids); };
        operation = service.manage(ctx, "clear");
        await waitFor(() => acknowledgedAt > 0);
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        assert.equal(f.messages.size, 3, "No message may be deleted before the delay expires");
        assert.equal(deletedAt, 0);
        await operation;
        assert.ok(deletedAt - acknowledgedAt >= 5_000, `deletion started only ${deletedAt - acknowledgedAt}ms after acknowledgement`);
        assert.equal(f.messages.size, 0);
        assert.equal(f.bulkCalls.length, 1);
    }
    finally {
        clearTimeout(keepAlive);
        await service?.close().catch(() => undefined);
        await Promise.allSettled([operation]);
        await f.dispose();
    }
});
test("real discord.js serializes only verified tracked IDs into a bulk-delete REST payload", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dtrx-discordjs-bulk-"));
    const ids = { guild: "100000000000000001", channel: "200000000000000002", target: "300000000000000003",
        admin: "400000000000000004", bot: "500000000000000005", role: "600000000000000006", other: "700000000000000007" };
    const client = new Client({ intents: [] });
    const rawUser = (id, bot = false) => ({ id, username: `user-${id.slice(-2)}`, discriminator: "0001", avatar: null, bot });
    client.user = new ClientUser(client, rawUser(ids.bot, true));
    const rawMember = (user, roles = []) => ({ user, roles, joined_at: "2024-01-01T00:00:00.000Z", deaf: false, mute: false, flags: 0 });
    const members = {
        [ids.admin]: rawMember(rawUser(ids.admin), [ids.role]), [ids.target]: rawMember(rawUser(ids.target)), [ids.bot]: rawMember(rawUser(ids.bot, true)),
    };
    const everyone = { id: ids.guild, name: "@everyone", permissions: (P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.ManageMessages).toString(),
        position: 0, color: 0, hoist: false, managed: false, mentionable: false };
    const moderator = { ...everyone, id: ids.role, name: "Manager", permissions: P.ManageGuild.toString(), position: 1 };
    const rawChannel = { id: ids.channel, guild_id: ids.guild, type: ChannelType.GuildText, name: "reminders", position: 0, permission_overwrites: [] };
    const guild = client.guilds._add({ id: ids.guild, name: "Test", owner_id: "999999999999999999", roles: [everyone, moderator],
        channels: [rawChannel], members: Object.values(members) });
    const rawMessages = new Map();
    const calls = [];
    const rawMessage = (author) => {
        const id = SnowflakeUtil.generate().toString();
        const message = { id, channel_id: ids.channel, guild_id: ids.guild, author: rawUser(author, author === ids.bot),
            content: "test", timestamp: new Date().toISOString(), edited_timestamp: null, tts: false, mention_everyone: false,
            mentions: [], mention_roles: [], attachments: [], embeds: [], type: 0, components: [] };
        rawMessages.set(id, message);
        return id;
    };
    const tracked = [rawMessage(ids.bot), rawMessage(ids.bot), rawMessage(ids.bot)];
    const foreign = rawMessage(ids.other);
    const untracked = rawMessage(ids.bot);
    client.rest.get = async (route, options = {}) => {
        calls.push({ method: "GET", route, query: options.query });
        if (route === `/channels/${ids.channel}`)
            return rawChannel;
        if (route.startsWith(`/guilds/${ids.guild}/members/`))
            return members[route.split("/").at(-1)];
        if (route === `/channels/${ids.channel}/messages`)
            return [...rawMessages.values()];
        const match = new RegExp(`^/channels/${ids.channel}/messages/(.+)$`).exec(route);
        if (match && rawMessages.has(match[1]))
            return rawMessages.get(match[1]);
        throw Object.assign(new Error(`Unexpected GET ${route}`), { code: 10008 });
    };
    client.rest.post = async (route, { body }) => {
        calls.push({ method: "POST", route, body });
        if (route !== `/channels/${ids.channel}/messages/bulk-delete`)
            throw new Error(`Unexpected POST ${route}`);
        for (const id of body.messages)
            rawMessages.delete(id);
    };
    client.rest.delete = async (route) => { calls.push({ method: "DELETE", route }); rawMessages.delete(route.split("/").at(-1)); };
    const store = new MentionReminderStore(path.join(directory, "state.json"));
    const timer = manualScheduler();
    const service = new MentionReminderService(client, store, timer.schedule);
    const replies = [];
    const ctx = { guild, userId: ids.admin, member: guild.members.cache.get(ids.admin), textChannelId: ids.channel,
        reply: async (payload) => { replies.push(payload); } };
    let clearing = Promise.resolve();
    try {
        await store.setConfig({ guildId: ids.guild, channelId: ids.channel, targetId: ids.target, intervalSeconds: 1, count: 1, text: "test" });
        for (const messageId of [...tracked, foreign])
            await store.addMessage(ids.guild, { channelId: ids.channel, messageId });
        clearing = service.manage(ctx, "clear");
        await waitFor(() => timer.count(5_000) === 1);
        assert.equal(calls.some((call) => call.method === "POST" || call.method === "DELETE"), false);
        await timer.fire(5_000);
        await clearing;
        const bulk = calls.filter((call) => call.method === "POST" && call.route.endsWith("/bulk-delete"));
        assert.equal(bulk.length, 1);
        assert.deepEqual(new Set(bulk[0].body.messages), new Set(tracked));
        assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);
        assert.equal(rawMessages.has(foreign), true, "A foreign author must never be bulk-deleted");
        assert.equal(rawMessages.has(untracked), true, "An untracked bot message must never be bulk-deleted");
        assert.deepEqual((await store.get(ids.guild))?.messages.map((ref) => ref.messageId), [foreign]);
        assert.match(replies.at(-1).content, /Còn 1 tin chưa dọn/);
    }
    finally {
        await timer.fire(5_000);
        await Promise.allSettled([clearing]);
        await service.close();
        await client.destroy();
        await fs.rm(directory, { recursive: true, force: true });
    }
});
test("batched verification efficiently finds interleaved reminders without touching other users", async () => {
    const f = await fixture();
    try {
        await f.configure({ count: 1 });
        const base = Date.now() - 300_000;
        const tracked = [], untracked = [];
        for (let i = 0; i < 100; i++) {
            const time = base + i * 2_000;
            const id = SnowflakeUtil.generate({ timestamp: time }).toString();
            const otherId = SnowflakeUtil.generate({ timestamp: time + 1_000 }).toString();
            tracked.push(id);
            untracked.push(otherId);
            f.messages.set(id, { id, author: { id: f.botId }, createdTimestamp: time, async delete() { f.messages.delete(id); } });
            f.messages.set(otherId, { id: otherId, author: { id: f.otherId }, createdTimestamp: time + 1_000, async delete() { throw new Error("unrelated message deleted"); } });
            await f.store.addMessage(f.guildId, { channelId: f.channelId, messageId: id });
        }
        const fetchMessages = f.channel.messages.fetch;
        let pages = 0, singleFetches = 0;
        f.channel.messages.fetch = async (options) => {
            if (options.message)
                singleFetches++;
            else
                pages++;
            return fetchMessages(options);
        };
        await f.clear();
        assert.ok(pages <= 4, `Expected efficient page verification; got ${pages} pages`);
        assert.ok(singleFetches <= 1, `Unexpected ${singleFetches} individual fetches`);
        assert.equal(f.bulkCalls.length, 1);
        assert.deepEqual(new Set(f.bulkCalls[0]), new Set(tracked));
        assert.ok(untracked.every((id) => f.messages.has(id)));
        assert.equal((await f.store.get(f.guildId))?.messages.length, 0);
    }
    finally {
        await f.dispose();
    }
});
test("clear groups tracked messages by channel and never combines IDs from different channels", async () => {
    const f = await fixture();
    try {
        await f.configure({ count: 1 });
        const secondId = "200000000000000003";
        const secondMessages = new Map();
        const secondCalls = [];
        const second = {
            id: secondId, guildId: f.guildId, type: ChannelType.GuildText,
            permissionsFor: f.channel.permissionsFor,
            messages: { async fetch(options) {
                    if (options.message) {
                        const message = secondMessages.get(options.message);
                        if (!message)
                            throw Object.assign(new Error("unknown message"), { code: 10008 });
                        return message;
                    }
                    return new Collection([...secondMessages.entries()]);
                } },
            async bulkDelete(values) { secondCalls.push([...values]); for (const id of values)
                secondMessages.delete(id); },
        };
        const originalFetch = f.guild.channels.fetch;
        f.guild.channels.fetch = async (id, options) => id === secondId ? second : originalFetch(id, options);
        const firstIds = [], secondIds = [];
        for (let i = 0; i < 4; i++) {
            const id = SnowflakeUtil.generate({ timestamp: Date.now() - 2_000 + i }).toString();
            const target = i < 2 ? f.messages : secondMessages;
            (i < 2 ? firstIds : secondIds).push(id);
            target.set(id, { id, author: { id: f.botId }, createdTimestamp: Date.now(), async delete() { target.delete(id); } });
            await f.store.addMessage(f.guildId, { channelId: i < 2 ? f.channelId : secondId, messageId: id });
        }
        await f.clear();
        assert.equal(f.bulkCalls.length, 1);
        assert.equal(secondCalls.length, 1);
        assert.deepEqual(new Set(f.bulkCalls[0]), new Set(firstIds));
        assert.deepEqual(new Set(secondCalls[0]), new Set(secondIds));
        assert.equal(f.messages.size + secondMessages.size, 0);
    }
    finally {
        await f.dispose();
    }
});
test("clear rechecks per-channel viewing rights after the delay", async () => {
    const f = await fixture();
    let clearing = Promise.resolve();
    try {
        await f.configure({ count: 2, intervalSeconds: 1 });
        await f.start();
        await f.scheduler.fire(0);
        await f.scheduler.fire(1_000);
        clearing = f.service.manage(f.ctx, "clear");
        await waitFor(() => f.scheduler.count(5_000) === 1);
        const permissionsFor = f.channel.permissionsFor;
        f.channel.permissionsFor = (member) => member.id === f.callerId ? new PermissionsBitField(0n) : permissionsFor(member);
        await f.scheduler.fire(5_000);
        await clearing;
        assert.equal(f.bulkCalls.length, 0);
        assert.equal(f.messages.size, 2);
        assert.equal((await f.store.get(f.guildId))?.messages.length, 2);
        assert.match(f.replies.at(-1).content, /Còn 2 tin chưa dọn/);
    }
    finally {
        await f.scheduler.fire(5_000);
        await Promise.allSettled([clearing]);
        await f.dispose();
    }
});
test("closing while verification is blocked cancels deletion without waiting for the network", async () => {
    const f = await fixture();
    let release = () => undefined, entered = () => undefined;
    const gate = new Promise((resolve) => { release = resolve; });
    const blocked = new Promise((resolve) => { entered = resolve; });
    let clearing = Promise.resolve();
    try {
        await f.configure({ count: 2, intervalSeconds: 1 });
        await f.start();
        await f.scheduler.fire(0);
        await f.scheduler.fire(1_000);
        const fetch = f.channel.messages.fetch;
        f.channel.messages.fetch = async (options) => { entered(); await gate; return fetch(options); };
        clearing = f.service.manage(f.ctx, "clear");
        await blocked;
        assert.equal(f.scheduler.count(5_000), 1);
        const close = f.service.close();
        await Promise.race([close, new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown waited for verification")), 500))]);
        await clearing;
        assert.equal(f.messages.size, 2);
        assert.equal(f.bulkCalls.length, 0);
        assert.equal((await f.store.get(f.guildId))?.messages.length, 2);
        release();
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(f.messages.size, 2, "A late fetch result cannot start deletion");
    }
    finally {
        release();
        await f.scheduler.fire(5_000);
        await Promise.allSettled([clearing]);
        await f.dispose();
    }
});
test("missing read access does not cause one failing Discord request per tracked message", async () => {
    const f = await fixture();
    try {
        await f.configure({ count: 1 });
        for (let i = 0; i < 100; i++) {
            const id = SnowflakeUtil.generate({ timestamp: Date.now() - 10_000 + i }).toString();
            f.messages.set(id, { id, author: { id: f.botId }, createdTimestamp: Date.now(), async delete() { throw new Error("should not delete"); } });
            await f.store.addMessage(f.guildId, { channelId: f.channelId, messageId: id });
        }
        let fetches = 0;
        f.channel.messages.fetch = async () => { fetches++; throw Object.assign(new Error("missing access"), { code: 50001, status: 403 }); };
        await f.clear();
        assert.ok(fetches <= 4, `Expected to stop after a few denied requests, got ${fetches}`);
        assert.equal(f.bulkCalls.length, 0);
        assert.equal(f.messages.size, 100);
        assert.equal((await f.store.get(f.guildId))?.messages.length, 100);
        assert.match(f.replies.at(-1).content, /Còn 100 tin chưa dọn/);
    }
    finally {
        await f.dispose();
    }
});
test("slash spam clear acknowledges privately before the delay and follows up with the result", async () => {
    const f = await fixture();
    let task = Promise.resolve();
    try {
        await f.configure({ count: 2, intervalSeconds: 1 });
        await f.start();
        await f.scheduler.fire(0);
        await f.scheduler.fire(1_000);
        f.guild.members.cache = new Map([[f.callerId, f.caller]]);
        const interactionClient = new EventEmitter();
        registerInteractionHandler({ client: interactionClient }, {}, {}, undefined, undefined, f.service);
        const listener = interactionClient.listeners("interactionCreate")[0];
        const replies = [];
        const interaction = {
            commandName: "spam", guildId: f.guildId, guild: f.guild, user: { id: f.callerId }, channelId: f.channelId,
            member: f.caller, deferred: false, replied: false, ephemeral: false,
            isAutocomplete: () => false, isButton: () => false, isStringSelectMenu: () => false,
            isChatInputCommand: () => true, inGuild: () => true,
            options: { getSubcommand: () => "clear" },
            async deferReply(payload) { this.deferred = true; this.ephemeral = payload.flags === MessageFlags.Ephemeral; replies.push({ type: "defer", payload }); },
            async editReply(payload) { this.replied = true; replies.push({ type: "edit", payload }); },
            async followUp(payload) { replies.push({ type: "followup", payload }); },
        };
        task = listener(interaction);
        await waitFor(() => f.scheduler.count(5_000) === 1);
        assert.deepEqual(replies.map((entry) => entry.type), ["defer", "edit"]);
        assert.equal(replies[0].payload.flags, MessageFlags.Ephemeral);
        assert.match(replies[1].payload.content, /5 giây/);
        assert.equal(f.messages.size, 2);
        await f.scheduler.fire(5_000);
        await task;
        assert.equal(replies.at(-1).type, "followup");
        assert.equal(replies.at(-1).payload.flags, MessageFlags.Ephemeral);
        assert.match(replies.at(-1).payload.content, /Đã dọn 2 tin/);
    }
    finally {
        await f.scheduler.fire(5_000);
        await Promise.allSettled([task]);
        await f.dispose();
    }
});
test("clear supports the full 500-message ledger with five batches", async () => {
    const f = await fixture();
    try {
        await f.configure({ count: 1 });
        const ids = [];
        for (let i = 0; i < MAX_TRACKED_REMINDER_MESSAGES; i++) {
            const time = Date.now() - 20_000 + i;
            const id = SnowflakeUtil.generate({ timestamp: time }).toString();
            ids.push(id);
            f.messages.set(id, { id, author: { id: f.botId }, createdTimestamp: time, async delete() { f.messages.delete(id); } });
            await f.store.addMessage(f.guildId, { channelId: f.channelId, messageId: id });
        }
        await f.clear();
        assert.deepEqual(f.bulkCalls.map((batch) => batch.length), [100, 100, 100, 100, 100]);
        assert.deepEqual(new Set(f.bulkCalls.flat()), new Set(ids));
        assert.equal(f.messages.size, 0);
        assert.equal((await f.store.get(f.guildId))?.messages.length, 0);
    }
    finally {
        await f.dispose();
    }
});
test("shutdown also cancels when verification is still pending after the five seconds", async () => {
    const f = await fixture();
    let release = () => undefined, entered = () => undefined;
    const gate = new Promise((resolve) => { release = resolve; });
    const blocked = new Promise((resolve) => { entered = resolve; });
    let clearing = Promise.resolve();
    try {
        await f.configure({ count: 2, intervalSeconds: 1 });
        await f.start();
        await f.scheduler.fire(0);
        await f.scheduler.fire(1_000);
        const fetch = f.channel.messages.fetch;
        f.channel.messages.fetch = async (options) => { entered(); await gate; return fetch(options); };
        clearing = f.service.manage(f.ctx, "clear");
        await blocked;
        await f.scheduler.fire(5_000);
        const close = f.service.close();
        let timeout;
        try {
            await Promise.race([close, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("shutdown waited for verification")), 500); })]);
        }
        finally {
            if (timeout)
                clearTimeout(timeout);
        }
        await clearing;
        assert.equal(f.bulkCalls.length, 0);
        assert.equal(f.messages.size, 2);
        assert.equal((await f.store.get(f.guildId))?.messages.length, 2);
        release();
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(f.messages.size, 2);
    }
    finally {
        release();
        await f.scheduler.fire(5_000);
        await Promise.allSettled([clearing]);
        await f.dispose();
    }
});
//# sourceMappingURL=mentionReminder.test.js.map