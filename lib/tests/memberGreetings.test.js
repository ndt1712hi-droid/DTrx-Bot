import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { ChannelType, Client, GatewayIntentBits, Partials, PermissionFlagsBits, Status } from "discord.js";
import { WebSocketServer } from "ws";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { fetchDiscordAvatar, fetchDiscordBannerAttachment, normalizeBannerBackground, renderMemberBanner } from "../core/memberBanner.js";
import { MemberBannerStore } from "../core/memberBannerStore.js";
import { MemberGreetingStore } from "../core/memberGreetingStore.js";
import { GreetingWorkQueue, MemberGreetingActions, MemberGreetingService, formatGreeting } from "../handlers/memberGreetingHandler.js";
import { registerInteractionHandler } from "../handlers/interactionHandler.js";
import { createBotInstance, disposeFailedLogin, loginWithIntentFallback } from "../index.js";
import { mockBackgroundMediaInitialization } from "./offlineMedia.js";
const restoreMediaInitialization = mockBackgroundMediaInitialization();
test.after(restoreMediaInitialization);
function fakeGuild(guildId = "guild-1") {
    const sent = [];
    const channel = {
        id: "channel-1", guildId, type: ChannelType.GuildText,
        isSendable: () => true, isTextBased: () => true,
        async send(payload) { sent.push(payload); return {}; },
    };
    const guild = {
        id: guildId, name: "Cộng đồng Việt", ownerId: "owner-1", memberCount: 123,
        channels: { cache: new Map([[channel.id, channel]]), fetch: async (id) => id === channel.id ? channel : null },
    };
    function member(id = "123456789012345678", admin = true) {
        return {
            id, guild, displayName: "Nguyễn Đông Thành", user: { username: "member", globalName: "Thành viên" },
            displayAvatarURL: () => "https://cdn.discordapp.com/avatars/123/avatar.png?size=256",
            permissions: { has: (permission) => admin && permission === PermissionFlagsBits.ManageGuild },
        };
    }
    return { guild, channel, sent, member };
}
async function tempStore() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dtrx-greeting-"));
    const file = path.join(directory, "greetings.json");
    return { directory, file, store: new MemberGreetingStore(file) };
}
test("greeting settings persist per guild and kind; concurrent changes are atomic", async () => {
    const { directory, file, store } = await tempStore();
    try {
        await Promise.all([
            store.configure("g1", "welcome", "c1", "Xin chào {user}!"),
            store.configure("g1", "goodbye", "c2", "Tạm biệt {name}!"),
            store.configure("g2", "welcome", "c3"),
        ]);
        await store.disable("g1", "welcome");
        assert.equal((await store.get("g1", "welcome"))?.enabled, false);
        assert.equal((await store.get("g1", "goodbye"))?.channelId, "c2");
        assert.equal((await store.get("g2", "welcome"))?.channelId, "c3");
        const enabled = await store.configure("g1", "welcome", "new-channel");
        assert.equal(enabled.message, "Xin chào {user}!", "Re-enabling preserves a custom template");
        await store.flush();
        const reloaded = new MemberGreetingStore(file);
        assert.deepEqual(await reloaded.get("g1", "welcome"), enabled);
        assert.equal(JSON.parse(await fs.readFile(file, "utf8")).length, 3);
        await assert.rejects(store.configure("g1", "welcome", "c1", " "));
        await assert.rejects(store.configure("g1", "welcome", "c1", "x".repeat(501)));
    }
    finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
test("corrupt or unwritable greeting settings are not silently overwritten", async () => {
    const { directory, file } = await tempStore();
    try {
        await fs.writeFile(file, "not valid json");
        const corrupt = new MemberGreetingStore(file);
        await assert.rejects(corrupt.configure("g", "welcome", "c"));
        assert.equal(await fs.readFile(file, "utf8"), "not valid json");
        await fs.unlink(file);
        const bad = new MemberGreetingStore(file);
        await bad.ready();
        await fs.mkdir(file);
        await assert.rejects(bad.configure("g", "welcome", "c"));
        assert.equal(await bad.get("g", "welcome"), undefined);
        assert.deepEqual(await fs.readdir(directory), ["greetings.json"]);
    }
    finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
test("avatar fetching accepts only Discord HTTPS, enforces size and tolerates failures", async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return new Response(Buffer.from("image"), { headers: { "content-type": "image/png" } }); };
    assert.equal(await fetchDiscordAvatar("https://cdn.discordapp.com.attacker.test/a.png", fetcher), null);
    assert.equal(await fetchDiscordAvatar("http://cdn.discordapp.com/a.png", fetcher), null);
    assert.equal(calls, 0);
    assert.deepEqual(await fetchDiscordAvatar("https://cdn.discordapp.com/a.png", fetcher), Buffer.from("image"));
    const oversized = async () => new Response(Buffer.alloc(1_000_001), { headers: { "content-type": "image/png" } });
    assert.equal(await fetchDiscordAvatar("https://cdn.discordapp.com/a.png", oversized), null);
    const wrongType = async () => new Response("hi", { headers: { "content-type": "text/html" } });
    assert.equal(await fetchDiscordAvatar("https://cdn.discordapp.com/a.png", wrongType), null);
    const failure = async () => { throw new Error("network failed"); };
    assert.equal(await fetchDiscordAvatar("https://cdn.discordapp.com/a.png", failure), null);
    let cancelled = false;
    const stalled = async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(Uint8Array.from([1, 2, 3])); },
        cancel() { cancelled = true; },
    }), { headers: { "content-type": "image/png" } });
    assert.equal(await fetchDiscordAvatar("https://cdn.discordapp.com/a.png", stalled, 30), null);
    assert.equal(cancelled, true, "A stalled body is cancelled at the deadline");
});
test("custom banner downloads accept only Discord attachment URLs and bounded image bodies", async () => {
    let calls = 0;
    const fetcher = async (_url, init) => {
        calls++;
        assert.equal(init?.redirect, "error");
        return new Response(Uint8Array.from([1, 2, 3]), { headers: { "content-type": "image/png" } });
    };
    assert.equal(await fetchDiscordBannerAttachment("https://evil.test/attachments/1/2/image.png", fetcher), null);
    assert.equal(await fetchDiscordBannerAttachment("https://cdn.discordapp.com/avatars/1/2.png", fetcher), null);
    assert.equal(calls, 0);
    assert.deepEqual(await fetchDiscordBannerAttachment("https://cdn.discordapp.com/attachments/1/2/image.png?ex=abc", fetcher), Buffer.from([1, 2, 3]));
    const large = async () => new Response(Buffer.alloc(3_000_001), { headers: { "content-type": "image/png" } });
    assert.equal(await fetchDiscordBannerAttachment("https://cdn.discordapp.com/attachments/1/2/image.png", large), null);
});
test("custom image normalization crops to a compact JPEG and rejects invalid or huge images", async () => {
    const source = createCanvas(180, 450);
    const ctx = source.getContext("2d");
    ctx.fillStyle = "#dd8a55";
    ctx.fillRect(0, 0, 180, 450);
    const normalized = await normalizeBannerBackground(await source.encode("png"));
    const decoded = await loadImage(normalized);
    assert.equal(decoded.width, 1200);
    assert.equal(decoded.height, 420);
    assert.equal(normalized[0], 0xff);
    assert.equal(normalized[1], 0xd8);
    assert.ok(normalized.length < 1_000_000);
    await assert.rejects(normalizeBannerBackground(Buffer.from("not an image")), /ảnh/i);
    await assert.rejects(normalizeBannerBackground(Buffer.alloc(3_000_001)), /3 MB/);
    const hugePngHeader = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(hugePngHeader);
    hugePngHeader.writeUInt32BE(13, 8);
    hugePngHeader.write("IHDR", 12, "ascii");
    hugePngHeader.writeUInt32BE(4096, 16);
    hugePngHeader.writeUInt32BE(4096, 20);
    await assert.rejects(normalizeBannerBackground(hugePngHeader), /8 triệu/);
    const data = { kind: "welcome", displayName: "Nguyễn Việt", serverName: "Cộng đồng", memberCount: 20, avatarUrl: null };
    assert.notDeepEqual(await renderMemberBanner(data), await renderMemberBanner({ ...data, background: normalized }));
});
test("custom backgrounds persist independently by guild and greeting kind", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dtrx-banners-"));
    const store = new MemberBannerStore(path.join(directory, "banners"));
    try {
        await Promise.all([store.set("guild-1", "welcome", Buffer.from("one")), store.set("guild-1", "goodbye", Buffer.from("two")), store.set("guild-2", "welcome", Buffer.from("three"))]);
        const reopened = new MemberBannerStore(path.join(directory, "banners"));
        assert.deepEqual(await reopened.get("guild-1", "welcome"), Buffer.from("one"));
        assert.deepEqual(await reopened.get("guild-1", "goodbye"), Buffer.from("two"));
        assert.deepEqual(await reopened.get("guild-2", "welcome"), Buffer.from("three"));
        assert.equal(await reopened.reset("guild-1", "welcome"), true);
        assert.equal(await reopened.reset("guild-1", "welcome"), false);
        assert.equal(await reopened.has("guild-1", "goodbye"), true);
        await reopened.set("../../unsafe", "welcome", Buffer.from("safe"));
        assert.equal((await fs.readdir(path.join(directory, "banners"))).length, 3, "Hashed names cannot escape the storage directory");
    }
    finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
test("welcome and goodbye banners render real JPEGs with Unicode and avatar fallback", async () => {
    const avatarCanvas = createCanvas(64, 64);
    const avatarContext = avatarCanvas.getContext("2d");
    avatarContext.fillStyle = "#fa6040";
    avatarContext.fillRect(0, 0, 64, 64);
    const avatar = await avatarCanvas.encode("png");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(Uint8Array.from(avatar), { headers: { "content-type": "image/png" } }));
    try {
        const data = { displayName: "Nguyễn Đặng Ngọc Ánh", serverName: "Cộng đồng Việt Nam", memberCount: 42 };
        const welcome = await renderMemberBanner({ ...data, kind: "welcome", avatarUrl: "https://cdn.discordapp.com/a.png" });
        const goodbye = await renderMemberBanner({ ...data, kind: "goodbye", avatarUrl: null });
        for (const buffer of [welcome, goodbye]) {
            assert.equal(buffer[0], 0xff);
            assert.equal(buffer[1], 0xd8);
            const image = await loadImage(buffer);
            assert.equal(image.width, 1200);
            assert.equal(image.height, 420);
            assert.ok(buffer.length < 1_000_000, "Banner should stay within a reasonable upload size");
        }
        assert.notDeepEqual(welcome, goodbye);
    }
    finally {
        globalThis.fetch = originalFetch;
    }
});
test("greeting templates substitute once and cannot ping everyone or unrelated users", async () => {
    const { guild, member } = fakeGuild();
    const person = member();
    person.displayName = "@everyone {server} <@999999999999999999>";
    const setting = { guildId: guild.id, kind: "welcome", channelId: "channel-1", enabled: true, message: "{user} | {name} | {server} | {count} @everyone" };
    const result = formatGreeting(setting, person);
    assert.match(result.content, /<@123456789012345678>/);
    assert.match(result.content, /@everyone \{server\}/, "A member name is not reinterpreted as a template");
    assert.deepEqual(result.allowedMentions.parse, []);
    assert.deepEqual(result.allowedMentions.users, [person.id]);
    assert.deepEqual(formatGreeting(setting, person, true).allowedMentions.users, []);
    assert.deepEqual(formatGreeting({ ...setting, kind: "goodbye" }, person).allowedMentions.users, []);
});
test("bounded work queue renders one image at a time and recovers after failure", async () => {
    const queue = new GreetingWorkQueue(2);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let running = 0, maxRunning = 0;
    const one = queue.tryRun(async () => { running++; maxRunning = Math.max(maxRunning, running); await gate; running--; return 1; });
    const two = queue.tryRun(async () => { running++; maxRunning = Math.max(maxRunning, running); running--; throw new Error("bad image"); });
    assert.equal(queue.tryRun(async () => 3), null);
    release?.();
    assert.equal(await one, 1);
    await assert.rejects(two);
    assert.equal(maxRunning, 1);
    assert.equal(await queue.tryRun(async () => 4), 4);
});
test("member events send banners, respect per-kind settings, deduplicate and degrade gracefully", async () => {
    const { directory, store } = await tempStore();
    const { guild, channel, sent, member } = fakeGuild();
    const client = new EventEmitter();
    let renders = 0;
    const service = new MemberGreetingService(client, store, true, async () => { renders++; return Buffer.from("jpeg"); });
    service.register();
    try {
        assert.equal(client.listenerCount("guildMemberAdd"), 1);
        assert.equal(client.listenerCount("guildMemberRemove"), 1);
        await service.handleEvent("welcome", member());
        assert.equal(sent.length, 0, "Events are opt-in until configured");
        await store.configure(guild.id, "welcome", channel.id, "Chào {user}!");
        await store.configure(guild.id, "goodbye", channel.id, "Tạm biệt {name}!");
        const person = member("123456789012345679");
        await service.handleEvent("welcome", person);
        await service.handleEvent("welcome", person);
        assert.equal(sent.length, 1, "Duplicate add events are ignored");
        assert.equal(sent[0].files[0].name, "welcome.jpg");
        assert.deepEqual(sent[0].allowedMentions.users, [person.id]);
        await service.handleEvent("goodbye", person);
        assert.equal(sent[1].files[0].name, "goodbye.jpg");
        assert.deepEqual(sent[1].allowedMentions.users, []);
        await service.handleEvent("welcome", person);
        assert.equal(sent.length, 3, "A genuine leave then rejoin is not deduplicated");
        const preview = await service.sendTest("welcome", person);
        assert.equal(preview, "banner");
        assert.deepEqual(sent.at(-1).allowedMentions.users, [], "Preview does not ping the admin");
        assert.equal(renders, 4);
        const fallback = new MemberGreetingService(client, store, true, async () => { throw new Error("renderer unavailable"); });
        await fallback.handleEvent("welcome", member("123456789012345680"));
        assert.equal(sent.at(-1).files, undefined, "If image generation fails, text still sends");
        let attempts = 0;
        channel.send = async (payload) => { attempts++; if (payload.files)
            throw new Error("Missing Attach Files"); sent.push(payload); };
        assert.equal(await service.sendTest("welcome", person), "text-only");
        assert.equal(attempts, 2, "A failed attachment is retried as text only");
    }
    finally {
        service.close();
        await fs.rm(directory, { recursive: true, force: true });
    }
});
test("a burst larger than the banner queue immediately falls back to text", async () => {
    const { directory, store } = await tempStore();
    const { guild, channel, sent, member } = fakeGuild();
    let release;
    let started;
    const gate = new Promise((resolve) => { release = resolve; });
    const renderingStarted = new Promise((resolve) => { started = resolve; });
    let renders = 0;
    const service = new MemberGreetingService(new EventEmitter(), store, true, async () => {
        renders++;
        started?.();
        await gate;
        return Buffer.from("jpg");
    });
    try {
        await store.configure(guild.id, "welcome", channel.id);
        const events = Array.from({ length: 33 }, (_, i) => service.handleEvent("welcome", member(String(123456789012345000n + BigInt(i)))));
        await renderingStarted;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(sent.length, 1);
        assert.equal(sent[0].files, undefined);
        release?.();
        await Promise.all(events);
        assert.equal(renders, 32);
        assert.equal(sent.length, 33);
    }
    finally {
        release?.();
        service.close();
        await fs.rm(directory, { recursive: true, force: true });
    }
});
test("registered gateway listeners deliver member add and remove events", async () => {
    const { directory, store } = await tempStore();
    const { guild, channel, sent, member } = fakeGuild();
    const client = new EventEmitter();
    const delivery = new EventEmitter();
    const oldSend = channel.send;
    channel.send = async (payload) => { await oldSend(payload); delivery.emit("sent"); };
    const service = new MemberGreetingService(client, store, true, async () => Buffer.from("jpg"));
    service.register();
    try {
        await store.configure(guild.id, "welcome", channel.id);
        await store.configure(guild.id, "goodbye", channel.id);
        for (const event of ["guildMemberAdd", "guildMemberRemove"]) {
            const done = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("event handler timed out")), 1_000);
                delivery.once("sent", () => { clearTimeout(timeout); resolve(); });
            });
            client.emit(event, member());
            await done;
        }
        assert.deepEqual(sent.map((payload) => payload.files[0].name), ["welcome.jpg", "goodbye.jpg"]);
    }
    finally {
        service.close();
        await fs.rm(directory, { recursive: true, force: true });
    }
});
test("disabling settings while a banner renders takes effect before send", async () => {
    const { directory, store } = await tempStore();
    const { guild, channel, sent, member } = fakeGuild();
    let release;
    let started;
    const renderingStarted = new Promise((resolve) => { started = resolve; });
    const service = new MemberGreetingService(new EventEmitter(), store, true, () => {
        started?.();
        return new Promise((resolve) => { release = resolve; });
    });
    try {
        await store.configure(guild.id, "welcome", channel.id);
        const event = service.handleEvent("welcome", member());
        await renderingStarted;
        await store.disable(guild.id, "welcome");
        release?.(Buffer.from("banner"));
        await event;
        assert.equal(sent.length, 0, "No stale welcome after it is disabled");
    }
    finally {
        release?.(Buffer.from("banner"));
        service.close();
        await fs.rm(directory, { recursive: true, force: true });
    }
});
test("changing the greeting channel while rendering uses the new channel", async () => {
    const { directory, store } = await tempStore();
    const { guild, channel, sent, member } = fakeGuild();
    const redirected = [];
    const second = { ...channel, id: "channel-2", send: async (payload) => { redirected.push(payload); } };
    guild.channels.cache.set(second.id, second);
    let release;
    let started;
    const renderingStarted = new Promise((resolve) => { started = resolve; });
    const service = new MemberGreetingService(new EventEmitter(), store, true, () => {
        started?.();
        return new Promise((resolve) => { release = resolve; });
    });
    try {
        await store.configure(guild.id, "welcome", channel.id);
        const event = service.handleEvent("welcome", member());
        await renderingStarted;
        await store.configure(guild.id, "welcome", second.id, "New: {name}");
        release?.(Buffer.from("banner"));
        await event;
        assert.equal(sent.length, 0);
        assert.equal(redirected.length, 1);
        assert.match(redirected[0].content, /^New:/);
    }
    finally {
        release?.(Buffer.from("banner"));
        service.close();
        await fs.rm(directory, { recursive: true, force: true });
    }
});
test("greeting commands require managers, configure channels, and warn when member intent is absent", async () => {
    const { directory, store } = await tempStore();
    const { guild, channel, sent, member } = fakeGuild();
    const client = new EventEmitter();
    const service = new MemberGreetingService(client, store, false, async () => Buffer.from("jpg"));
    service.register();
    const actions = new MemberGreetingActions(store, service, false);
    const replies = [];
    const ctx = { guild, member: member("123456789012345678", false), userId: "123456789012345678", textChannelId: channel.id, reply: async (r) => replies.push(r), defer: async () => undefined };
    try {
        assert.equal(client.listenerCount("guildMemberAdd"), 0);
        await actions.manage(ctx, "welcome", "set", channel);
        assert.match(replies.at(-1).content, /Quản lý máy chủ/);
        assert.equal(await store.get(guild.id, "welcome"), undefined);
        ctx.member.permissions.has = () => true;
        await actions.manage(ctx, "welcome", "set", { ...channel, guildId: "other" });
        assert.match(replies.at(-1).content, /kênh văn bản/);
        await actions.manage(ctx, "welcome", "set", channel, "Hi {user}");
        assert.match(replies.at(-1).content, /Server Members Intent/);
        await actions.manage(ctx, "welcome", "status");
        assert.match(replies.at(-1).content, /Hi/);
        await actions.manage(ctx, "welcome", "test");
        assert.equal(sent.length, 1, "Manual preview works even when event intent is missing");
        assert.match(replies.at(-1).content, /gửi thử/);
        await actions.manage(ctx, "welcome", "off");
        assert.equal((await store.get(guild.id, "welcome"))?.enabled, false);
    }
    finally {
        service.close();
        await fs.rm(directory, { recursive: true, force: true });
    }
});
test("managers can upload, preview, isolate and reset their own banner backgrounds", async () => {
    const { directory, store } = await tempStore();
    const { guild, channel, sent, member } = fakeGuild();
    const backgrounds = new MemberBannerStore(path.join(directory, "images"));
    const rendered = [];
    const service = new MemberGreetingService(new EventEmitter(), store, true, async (data) => { rendered.push(data); return Buffer.from("jpg"); }, backgrounds);
    const actions = new MemberGreetingActions(store, service, true);
    const replies = [];
    const ctx = { guild, member: member(), userId: "123456789012345678", textChannelId: channel.id, reply: async (r) => replies.push(r), defer: async () => undefined };
    const image = createCanvas(500, 200);
    const drawing = image.getContext("2d");
    drawing.fillStyle = "#20c0ee";
    drawing.fillRect(0, 0, 500, 200);
    const bytes = await image.encode("png");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(Uint8Array.from(bytes), { headers: { "content-type": "image/png" } }));
    const attachment = { url: "https://cdn.discordapp.com/attachments/11/22/background.png?ex=abc", size: bytes.length };
    try {
        await store.configure(guild.id, "welcome", channel.id);
        ctx.member.permissions.has = () => false;
        await actions.manage(ctx, "welcome", "banner", null, undefined, attachment);
        assert.equal(await backgrounds.has(guild.id, "welcome"), false, "Only managers can change a banner");
        ctx.member.permissions.has = () => true;
        await actions.manage(ctx, "welcome", "banner", null, undefined, attachment);
        assert.match(replies.at(-1).content, /Đã thay ảnh nền/);
        assert.equal(await backgrounds.has(guild.id, "welcome"), true);
        assert.equal(await backgrounds.has(guild.id, "goodbye"), false);
        assert.equal(await backgrounds.has("another-guild", "welcome"), false);
        await actions.manage(ctx, "welcome", "status");
        assert.match(replies.at(-1).content, /Tùy chỉnh/);
        await actions.manage(ctx, "welcome", "test");
        assert.equal(sent.length, 1);
        assert.deepEqual(rendered[0].background, await backgrounds.get(guild.id, "welcome"));
        const previous = await backgrounds.get(guild.id, "welcome");
        await actions.manage(ctx, "welcome", "banner", null, undefined, { ...attachment, size: 3_000_001 });
        assert.match(replies.at(-1).content, /3 MB/);
        assert.deepEqual(await backgrounds.get(guild.id, "welcome"), previous, "Invalid upload leaves the old image untouched");
        await actions.manage(ctx, "goodbye", "banner", null, undefined, attachment);
        assert.equal(await backgrounds.has(guild.id, "goodbye"), true);
        await actions.manage(ctx, "welcome", "reset-banner");
        assert.equal(await backgrounds.has(guild.id, "welcome"), false);
        assert.equal(await backgrounds.has(guild.id, "goodbye"), true);
        const update = service.setBackground(guild.id, "welcome", attachment);
        const reset = service.resetBackground(guild.id, "welcome");
        await Promise.all([update, reset]);
        assert.equal(await backgrounds.has(guild.id, "welcome"), false, "Reset queued after upload wins");
    }
    finally {
        globalThis.fetch = originalFetch;
        service.close();
        await fs.rm(directory, { recursive: true, force: true });
    }
});
test("/welcome and /goodbye route their channel, message and attachments through the interaction handler", async () => {
    const client = new EventEmitter();
    const calls = [];
    registerInteractionHandler({ client }, {}, {}, { manage: async (...args) => { calls.push(args); } });
    const listener = client.listeners("interactionCreate")[0];
    const { guild, channel, member } = fakeGuild();
    guild.members = { cache: new Map([["user-1", member("user-1")]]) };
    const attachment = { url: "https://cdn.discordapp.com/attachments/1/2/a.png", size: 50 };
    for (const kind of ["welcome", "goodbye"]) {
        for (const mode of ["set", "banner"]) {
            const interaction = {
                commandName: kind, guildId: guild.id, guild, user: { id: "user-1" }, channelId: channel.id,
                deferred: false, replied: false, isAutocomplete: () => false, isButton: () => false,
                isStringSelectMenu: () => false, isChatInputCommand: () => true, inGuild: () => true,
                options: { getSubcommand: () => mode, getChannel: () => channel, getString: () => "Hello {name}", getAttachment: () => attachment },
                async deferReply() { this.deferred = true; },
            };
            await listener(interaction);
        }
    }
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.map((call) => [call[1], call[2], call[3]?.id, call[4], call[5]]), [
        ["welcome", "set", "channel-1", "Hello {name}", undefined], ["welcome", "banner", undefined, undefined, attachment],
        ["goodbye", "set", "channel-1", "Hello {name}", undefined], ["goodbye", "banner", undefined, undefined, attachment],
    ]);
});
test("privileged-intent fallback keeps whichever features Discord allows", async () => {
    const combinations = [
        { content: true, members: true }, { content: true, members: false },
        { content: false, members: true }, { content: false, members: false },
    ];
    for (const allowed of combinations) {
        let created = 0, disposed = 0;
        const chosen = await loginWithIntentFallback((options) => { created++; return options; }, async (options) => {
            if ((options.includeMessageContentIntent && !allowed.content) || (options.includeGuildMembersIntent && !allowed.members))
                throw new Error("Used disallowed intents");
        }, async () => { disposed++; });
        assert.equal(chosen.includeMessageContentIntent, allowed.content);
        assert.equal(chosen.includeGuildMembersIntent, allowed.members);
        assert.equal(disposed, created - 1);
    }
    let created = 0;
    await assert.rejects(loginWithIntentFallback((options) => { created++; return options; }, async () => { throw new Error("invalid token"); }, async () => undefined), /invalid token/);
    assert.equal(created, 1, "Non-intent failures do not trigger repeated logins");
});
test("discord.js login retries a 4014 response from a local fake Gateway", { timeout: 10_000 }, async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `ws://127.0.0.1:${address.port}`;
    const observedIntents = [];
    server.on("connection", (socket) => {
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
        socket.on("message", (data) => {
            const payload = JSON.parse(data.toString());
            if (payload.op === 1)
                socket.send(JSON.stringify({ op: 11, d: null }));
            if (payload.op !== 2)
                return;
            observedIntents.push(payload.d.intents);
            if (payload.d.intents & GatewayIntentBits.GuildMembers) {
                socket.close(4014, "Disallowed intent");
                return;
            }
            socket.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: {
                    v: 10, user: { id: "100000000000000001", username: "FakeBot", discriminator: "0001", avatar: null, bot: true },
                    guilds: [], session_id: "mock-session", resume_gateway_url: url,
                    application: { id: "100000000000000001", flags: 0 },
                } }));
        });
    });
    let client;
    try {
        client = await loginWithIntentFallback((options) => {
            const instance = new Client({ intents: [GatewayIntentBits.Guilds,
                    ...(options.includeMessageContentIntent ? [GatewayIntentBits.MessageContent] : []),
                    ...(options.includeGuildMembersIntent ? [GatewayIntentBits.GuildMembers] : []),
                ] });
            instance.rest.get = async () => ({ url, shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 1000, max_concurrency: 1 } });
            return instance;
        }, (instance) => instance.login("fake-local-only-token"), (instance) => instance.destroy());
        assert.equal(observedIntents.length, 2);
        assert.ok(observedIntents[0] & GatewayIntentBits.GuildMembers);
        assert.ok(!(observedIntents[1] & GatewayIntentBits.GuildMembers));
        assert.ok(observedIntents[1] & GatewayIntentBits.MessageContent);
        assert.equal(client.user?.username, "FakeBot");
    }
    finally {
        await client?.destroy();
        for (const socket of server.clients)
            socket.terminate();
        await new Promise((resolve) => server.close(() => resolve()));
    }
});
test("join and uncached leave reach the greeting service through a local fake Gateway", { timeout: 10_000 }, async () => {
    const { directory, store } = await tempStore();
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `ws://127.0.0.1:${address.port}`;
    let connection;
    server.on("connection", (socket) => {
        connection = socket;
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
        socket.on("message", (data) => {
            const payload = JSON.parse(data.toString());
            if (payload.op === 1)
                socket.send(JSON.stringify({ op: 11, d: null }));
            if (payload.op !== 2)
                return;
            socket.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: {
                    v: 10, user: { id: "100000000000000001", username: "FakeBot", discriminator: "0001", avatar: null, bot: true },
                    guilds: [], session_id: "mock-session", resume_gateway_url: url, application: { id: "100000000000000001", flags: 0 },
                } }));
        });
    });
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers], partials: [Partials.GuildMember] });
    client.rest.get = async () => ({ url, shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 1000, max_concurrency: 1 } });
    const sent = [];
    const deliveries = new EventEmitter();
    const service = new MemberGreetingService(client, store, true, async () => Buffer.from("jpg"));
    service.register();
    try {
        await client.login("fake-local-only-token");
        const guild = client.guilds._add({ id: "111111111111111111", name: "Fake guild", member_count: 20,
            owner_id: "222222222222222222", roles: [], emojis: [], features: [] });
        const channel = { id: "444444444444444444", isSendable: () => true, isTextBased: () => true,
            send: async (payload) => { sent.push(payload); deliveries.emit("sent"); } };
        guild.channels.cache.set(channel.id, channel);
        await store.configure(guild.id, "welcome", channel.id);
        await store.configure(guild.id, "goodbye", channel.id);
        const user = { id: "333333333333333333", username: "MockMember", discriminator: "0001", avatar: null };
        let delivered = once(deliveries, "sent", { signal: AbortSignal.timeout(2_000) });
        connection.send(JSON.stringify({ op: 0, s: 2, t: "GUILD_MEMBER_ADD", d: { guild_id: guild.id, user, roles: [], joined_at: new Date().toISOString(), deaf: false, mute: false } }));
        await delivered;
        assert.equal(sent[0].files[0].name, "welcome.jpg");
        assert.ok(guild.members.cache.has(user.id));
        guild.members.cache.delete(user.id);
        delivered = once(deliveries, "sent", { signal: AbortSignal.timeout(2_000) });
        connection.send(JSON.stringify({ op: 0, s: 3, t: "GUILD_MEMBER_REMOVE", d: { guild_id: guild.id, user } }));
        await delivered;
        assert.equal(sent[1].files[0].name, "goodbye.jpg", "Uncached departures still receive goodbye");
    }
    finally {
        service.close();
        await client.destroy();
        for (const socket of server.clients)
            socket.terminate();
        await new Promise((resolve) => server.close(() => resolve()));
        await fs.rm(directory, { recursive: true, force: true });
    }
});
test("a real failed-login cleanup preserves existing music session snapshots before retry", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dtrx-intent-retry-"));
    const sessions = path.join(directory, "sessions.json");
    const previous = '[{"guildId":"g","voiceChannelId":"v","savedAt":123}]';
    await fs.writeFile(sessions, previous);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
        if (String(input).includes("voices/list"))
            return new Response("[]", { headers: { "content-type": "application/json" } });
        return originalFetch(input, init);
    });
    let success;
    try {
        success = await loginWithIntentFallback((options) => createBotInstance({ DISCORD_TOKEN: "dummy", ENABLE_PERSISTENCE: "true", PERSISTENCE_FILE: sessions }, options), async (bot) => {
            if (bot.client.options.intents.has(GatewayIntentBits.GuildMembers))
                throw new Error("Used disallowed intents");
        }, disposeFailedLogin);
        assert.equal(success.client.options.intents.has(GatewayIntentBits.MessageContent), true);
        assert.equal(success.client.options.intents.has(GatewayIntentBits.GuildMembers), false);
        assert.equal(await fs.readFile(sessions, "utf8"), previous, "Retry must not replace saved sessions with an empty array");
    }
    finally {
        if (success)
            await disposeFailedLogin(success);
        globalThis.fetch = originalFetch;
        await fs.rm(directory, { recursive: true, force: true });
    }
});
test("bot registers member intent when enabled and avoids greeting-store path collisions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dtrx-greeting-collision-"));
    const sessionFile = path.join(directory, "member-greetings.json");
    await fs.writeFile(sessionFile, "[]");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
        if (String(input).includes("voices/list"))
            return new Response("[]", { headers: { "content-type": "application/json" } });
        return originalFetch(input, init);
    });
    const bot = createBotInstance({ DISCORD_TOKEN: "dummy", ENABLE_PERSISTENCE: "false", PERSISTENCE_FILE: sessionFile }, { includeGuildMembersIntent: true, includeMessageContentIntent: false });
    try {
        assert.equal(bot.client.options.intents.has(GatewayIntentBits.GuildMembers), true);
        assert.equal(bot.client.options.intents.has(GatewayIntentBits.MessageContent), false);
        assert.ok(bot.client.options.partials?.includes(Partials.GuildMember));
        const guild = bot.client.guilds._add({ id: "111111111111111111", name: "Test", member_count: 5,
            owner_id: "222222222222222222", roles: [], emojis: [], features: [] });
        const removedId = "333333333333333333";
        assert.equal(guild.members.cache.has(removedId), false);
        let removed;
        bot.client.once("guildMemberRemove", (value) => { removed = value; });
        bot.client.actions.GuildMemberRemove.handle({ guild_id: guild.id,
            user: { id: removedId, username: "uncached", discriminator: "0001", avatar: null } }, { status: Status.Ready });
        assert.equal(removed?.id, removedId, "discord.js emits a goodbye even for an uncached member");
        assert.equal(removed?.displayName, "uncached");
        await bot.greetingStore.configure("g", "welcome", "c");
        assert.equal(await fs.readFile(sessionFile, "utf8"), "[]");
        assert.equal(JSON.parse(await fs.readFile(`${sessionFile}.settings.json`, "utf8"))[0].kind, "welcome");
    }
    finally {
        bot.greetingService.close();
        await bot.engine.shutdown();
        await bot.client.destroy();
        globalThis.fetch = originalFetch;
        await fs.rm(directory, { recursive: true, force: true });
    }
});
test("custom image directory cannot overwrite a same-named music persistence file", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dtrx-banner-collision-"));
    const sessionFile = path.join(directory, "member-banners");
    await fs.writeFile(sessionFile, "[]");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("[]", { headers: { "content-type": "application/json" } }));
    const bot = createBotInstance({ DISCORD_TOKEN: "dummy", ENABLE_PERSISTENCE: "false", PERSISTENCE_FILE: sessionFile });
    try {
        await bot.bannerStore.set("guild", "welcome", Buffer.from("banner"));
        assert.equal(await fs.readFile(sessionFile, "utf8"), "[]");
        assert.equal((await fs.readdir(`${sessionFile}.images`)).length, 1);
    }
    finally {
        await disposeFailedLogin(bot);
        globalThis.fetch = originalFetch;
        await fs.rm(directory, { recursive: true, force: true });
    }
});
//# sourceMappingURL=memberGreetings.test.js.map