import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	ChannelType,
	Client,
	GatewayIntentBits,
	OverwriteType,
	PermissionFlagsBits as P,
	PermissionOverwrites,
	type PermissionOverwriteOptions,
} from "discord.js";
import { ChannelLockStore, LOCKED_PERMISSIONS } from "../core/channelLockStore.js";
import { ChannelLockActions } from "../handlers/channelLockHandler.js";
import { MemberGreetingStore } from "../core/memberGreetingStore.js";
import { MemberGreetingService } from "../handlers/memberGreetingHandler.js";

// Real discord.js Guild, GuildMember, channel, overwrite and permission models;
// only the REST responses are simulated. No live Discord credentials are used.
const IDS = {
	guild: "100000000000000001", channel: "200000000000000002", owner: "300000000000000003",
	caller: "400000000000000004", bot: "500000000000000005", member: "600000000000000006",
	callerRole: "700000000000000007", botRole: "800000000000000008", trustedRole: "900000000000000009",
};
interface RawOverwrite { id: string; type: number; allow: string; deny: string }
interface FixtureOptions {
	callerManage?: boolean;
	botManage?: boolean;
	botSend?: boolean;
	attachFiles?: boolean;
	initial?: RawOverwrite[];
	botAdmin?: boolean;
	channelType?: ChannelType;
}

function role(id: string, permissions: bigint) {
	return { id, name: id, permissions: permissions.toString(), color: 0, hoist: false, position: 1, managed: false, mentionable: false };
}
function member(id: string, roles: string[]) {
	return { user: { id, username: `user-${id.slice(-3)}`, discriminator: "0001" }, roles, joined_at: "2024-01-01T00:00:00.000Z", deaf: false, mute: false };
}
function overwrite(id: string, type: number, allow = 0n, deny = 0n): RawOverwrite {
	return { id, type, allow: allow.toString(), deny: deny.toString() };
}

async function fixture(options: FixtureOptions = {}) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dtrx-lock-"));
	const file = path.join(directory, "channel-locks.json");
	const base = P.ViewChannel | P.ReadMessageHistory | P.SendMessages | P.SendMessagesInThreads |
		P.CreatePublicThreads | P.CreatePrivateThreads | (options.attachFiles === false ? 0n : P.AttachFiles);
	const everyoneRole = options.botSend === false ? base & ~P.SendMessages : base;
	const client = new Client({ intents: [GatewayIntentBits.Guilds] });
	const guild: any = (client.guilds as any)._add({
		id: IDS.guild, name: "Local test guild", owner_id: IDS.owner, channels: [],
		roles: [role(IDS.guild, everyoneRole), role(IDS.callerRole, options.callerManage === false ? 0n : P.ManageRoles),
			role(IDS.botRole, (options.botManage === false ? 0n : P.ManageRoles) | (options.botAdmin ? P.Administrator : 0n)),
			role(IDS.trustedRole, 0n)],
		members: [member(IDS.caller, [IDS.callerRole]), member(IDS.bot, [IDS.botRole]), member(IDS.member, [])],
	});
	const caller = guild.members.cache.get(IDS.caller);
	const bot = guild.members.cache.get(IDS.bot);
	const regular = guild.members.cache.get(IDS.member);
	(guild.members as any).fetch = async ({ user }: { user: string }) => guild.members.cache.get(user) ?? null;
	(guild.members as any).fetchMe = async () => bot;
	const original = options.initial ?? [
		overwrite(IDS.guild, OverwriteType.Role, P.SendMessages | P.CreatePublicThreads | P.EmbedLinks, P.CreatePrivateThreads),
		overwrite(IDS.bot, OverwriteType.Member, P.AttachFiles, P.ManageMessages),
		overwrite(IDS.trustedRole, OverwriteType.Role, P.SendMessages),
	];
	const raw: any = { id: IDS.channel, guild_id: IDS.guild, type: options.channelType ?? ChannelType.GuildText,
		name: "welcome", position: 0, permission_overwrites: structuredClone(original) };
	const operations: { method: string; target: string; body?: any }[] = [];
	let failure: null | ((method: string, target: string, body?: any) => "before" | "after" | undefined) = null;
	function apply(target: string, body: any) {
		const item = { id: target, type: body.type, allow: String(body.allow.bitfield ?? body.allow), deny: String(body.deny.bitfield ?? body.deny) };
		raw.permission_overwrites = raw.permission_overwrites.filter((entry: RawOverwrite) => entry.id !== target);
		raw.permission_overwrites.push(item);
	}
	(client.rest as any).get = async (route: string) => {
		if (route === `/channels/${IDS.channel}`) return structuredClone(raw);
		throw new Error(`Unexpected GET ${route}`);
	};
	(client.rest as any).put = async (route: string, config: { body: any }) => {
		const target = route.split("/").at(-1)!;
		operations.push({ method: "put", target, body: config.body });
		const when = failure?.("put", target, config.body);
		if (when === "before") throw new Error("simulated permission failure");
		apply(target, config.body);
		if (when === "after") throw new Error("simulated lost response");
		return undefined;
	};
	(client.rest as any).delete = async (route: string) => {
		const target = route.split("/").at(-1)!;
		operations.push({ method: "delete", target });
		const when = failure?.("delete", target);
		if (when === "before") throw new Error("simulated delete failure");
		raw.permission_overwrites = raw.permission_overwrites.filter((entry: RawOverwrite) => entry.id !== target);
		if (when === "after") throw new Error("simulated lost delete response");
	};
	const replies: any[] = [];
	const ctx: any = { guild, member: caller, userId: IDS.caller, textChannelId: IDS.channel,
		defer: async () => undefined, reply: async (payload: any) => { replies.push(payload); } };
	let store = new ChannelLockStore(file);
	let actions = new ChannelLockActions(store);
	const refresh = async () => guild.channels.fetch(IDS.channel, { force: true });
	const current = (id: string): RawOverwrite | undefined => raw.permission_overwrites.find((entry: RawOverwrite) => entry.id === id);
	function changeExternally(id: string, type: number, changes: PermissionOverwriteOptions) {
		const before = current(id);
		const result = PermissionOverwrites.resolveOverwriteOptions(changes, { allow: BigInt(before?.allow ?? 0), deny: BigInt(before?.deny ?? 0) });
		apply(id, { type, allow: result.allow, deny: result.deny });
	}
	async function restart() { await actions.close(); store = new ChannelLockStore(file); actions = new ChannelLockActions(store); }
	async function dispose() { await actions.close().catch(() => undefined); await client.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
	return { directory, file, client, guild, caller, bot, regular, raw, operations, replies, ctx, refresh, current,
		changeExternally, restart, dispose, setFailure: (next: typeof failure) => { failure = next; },
		get store() { return store; }, get actions() { return actions; } };
}

function state(item: RawOverwrite | undefined, name: (typeof LOCKED_PERMISSIONS)[number] | "AttachFiles" | "EmbedLinks" | "ManageMessages") {
	const bit = P[name];
	if ((BigInt(item?.deny ?? 0) & bit) !== 0n) return false;
	if ((BigInt(item?.allow ?? 0) & bit) !== 0n) return true;
	return null;
}

test("/lock protects the bot and blocks @everyone; /unlock restores exact tri-state after restart", async () => {
	const f = await fixture();
	try {
		const initial = structuredClone(f.raw.permission_overwrites).sort((a: RawOverwrite, b: RawOverwrite) => a.id.localeCompare(b.id));
		await f.actions.manage(f.ctx, "lock");
		assert.match(f.replies.at(-1).content, /Đã khóa/);
		assert.match(f.replies.at(-1).content, /vai trò\/thành viên/);
		assert.equal((await f.store.get(IDS.guild, IDS.channel))?.phase, "locked");
		for (const name of LOCKED_PERMISSIONS) assert.equal(state(f.current(IDS.guild), name), false, name);
		assert.equal(state(f.current(IDS.guild), "EmbedLinks"), true, "Unrelated @everyone overwrite remains intact");
		assert.equal(state(f.current(IDS.bot), "SendMessages"), true);
		assert.equal(state(f.current(IDS.bot), "AttachFiles"), true);
		assert.equal(state(f.current(IDS.bot), "ManageMessages"), false);
		const lockedChannel = await f.refresh();
		assert.equal(lockedChannel.permissionsFor(f.regular).has(P.SendMessages), false);
		assert.equal(lockedChannel.permissionsFor(f.regular).has(P.SendMessagesInThreads), false);
		assert.equal(lockedChannel.permissionsFor(f.regular).has(P.CreatePublicThreads), false);
		assert.equal(lockedChannel.permissionsFor(f.regular).has(P.CreatePrivateThreads), false);
		assert.equal(lockedChannel.permissionsFor(f.bot).has([P.ViewChannel, P.SendMessages, P.AttachFiles]), true);
		(f.regular as any)._roles.push(IDS.trustedRole);
		assert.equal(lockedChannel.permissionsFor(f.regular).has(P.SendMessages), true, "A role-specific channel allow can override @everyone");
		(f.regular as any)._roles.pop();
		const record = await f.store.get(IDS.guild, IDS.channel);
		await f.actions.manage(f.ctx, "lock", IDS.channel);
		assert.match(f.replies.at(-1).content, /đã được bot khóa/);
		assert.deepEqual(await f.store.get(IDS.guild, IDS.channel), record, "A second lock must not replace the original snapshot");
		await f.restart();
		await f.actions.manage(f.ctx, "unlock", IDS.channel);
		assert.match(f.replies.at(-1).content, /Đã khôi phục quyền/);
		assert.deepEqual(f.raw.permission_overwrites.sort((a: RawOverwrite, b: RawOverwrite) => a.id.localeCompare(b.id)), initial);
		assert.equal(await f.store.get(IDS.guild, IDS.channel), undefined);
	} finally { await f.dispose(); }
});

test("new temporary overwrites are deleted when restored; no empty bot entry remains", async () => {
	const f = await fixture({ initial: [] });
	try {
		await f.actions.manage(f.ctx, "lock");
		assert.ok(f.current(IDS.bot)); assert.ok(f.current(IDS.guild));
		await f.actions.manage(f.ctx, "unlock");
		assert.equal(f.current(IDS.bot), undefined);
		assert.equal(f.current(IDS.guild), undefined);
		assert.deepEqual(f.operations.filter((o) => o.method === "delete").map((o) => o.target), [IDS.guild, IDS.bot]);
	} finally { await f.dispose(); }
});

test("manual changes during lock are preserved and reported; unrelated added flags survive", async () => {
	const f = await fixture({ initial: [] });
	try {
		await f.actions.manage(f.ctx, "lock");
		f.changeExternally(IDS.guild, OverwriteType.Role, { SendMessages: true, EmbedLinks: true });
		f.changeExternally(IDS.bot, OverwriteType.Member, { SendMessages: false, AttachFiles: true });
		await f.actions.manage(f.ctx, "unlock");
		assert.match(f.replies.at(-1).content, /đã được đổi trong lúc khóa/);
		assert.equal(state(f.current(IDS.guild), "SendMessages"), true, "Admin's change is not clobbered");
		assert.equal(state(f.current(IDS.guild), "EmbedLinks"), true);
		assert.equal(state(f.current(IDS.bot), "SendMessages"), false);
		assert.equal(state(f.current(IDS.bot), "AttachFiles"), true);
		for (const field of ["SendMessagesInThreads", "CreatePublicThreads", "CreatePrivateThreads"] as const) assert.equal(state(f.current(IDS.guild), field), null);
		assert.equal(await f.store.get(IDS.guild, IDS.channel), undefined);
	} finally { await f.dispose(); }
});

test("a failed or ambiguous Discord edit leaves a recovery snapshot for /unlock", async () => {
	for (const when of ["before", "after"] as const) {
		const f = await fixture();
		try {
			const initial = structuredClone(f.raw.permission_overwrites).sort((a: RawOverwrite, b: RawOverwrite) => a.id.localeCompare(b.id));
			f.setFailure((method, target) => method === "put" && target === IDS.guild ? when : undefined);
			await f.actions.manage(f.ctx, "lock");
			assert.match(f.replies.at(-1).content, /Chưa xác nhận khóa/);
			assert.equal((await f.store.get(IDS.guild, IDS.channel))?.phase, "pending");
			f.setFailure(null);
			await f.restart();
			await f.actions.manage(f.ctx, "unlock");
			assert.match(f.replies.at(-1).content, /Đã khôi phục/);
			assert.deepEqual(f.raw.permission_overwrites.sort((a: RawOverwrite, b: RawOverwrite) => a.id.localeCompare(b.id)), initial);
			assert.equal(await f.store.get(IDS.guild, IDS.channel), undefined);
		} finally { await f.dispose(); }
	}
});

test("a partially failed /unlock keeps its snapshot and can be retried safely", async () => {
	const f = await fixture({ initial: [] });
	try {
		await f.actions.manage(f.ctx, "lock");
		f.setFailure((method, target) => method === "delete" && target === IDS.bot ? "before" : undefined);
		await f.actions.manage(f.ctx, "unlock");
		assert.match(f.replies.at(-1).content, /Chưa khôi phục xong/);
		assert.ok(await f.store.get(IDS.guild, IDS.channel));
		assert.equal(f.current(IDS.guild), undefined, "The already-restored @everyone is not re-locked");
		f.setFailure(null);
		await f.actions.manage(f.ctx, "unlock");
		assert.equal(f.current(IDS.bot), undefined);
		assert.equal(await f.store.get(IDS.guild, IDS.channel), undefined);
	} finally { await f.dispose(); }
});

test("requires the caller and bot to have appropriate permissions and won't lock an unsupported channel", async () => {
	for (const options of [
		{ callerManage: false }, { botManage: false }, { botSend: false, initial: [] }, { channelType: ChannelType.GuildVoice },
	]) {
		const f = await fixture(options);
		try {
			await f.actions.manage(f.ctx, "lock");
			assert.match(f.replies.at(-1).content, /❌/);
			assert.equal(f.operations.length, 0);
			assert.equal(await f.store.get(IDS.guild, IDS.channel), undefined);
		} finally { await f.dispose(); }
	}
});

test("without a lock snapshot, /unlock refuses to grant access; corrupt data is never overwritten", async () => {
	const f = await fixture();
	try {
		await f.actions.manage(f.ctx, "unlock");
		assert.match(f.replies.at(-1).content, /Không có bản lưu/);
		assert.equal(f.operations.length, 0);
		await f.actions.close();
		await fs.writeFile(f.file, "not valid json");
		const corrupt = new ChannelLockStore(f.file);
		const actions = new ChannelLockActions(corrupt);
		await actions.manage(f.ctx, "lock");
		assert.match(f.replies.at(-1).content, /Không đọc được dữ liệu/);
		assert.equal(f.operations.length, 0);
		assert.equal(await fs.readFile(f.file, "utf8"), "not valid json");
		await actions.close().catch(() => undefined);
	} finally { await f.dispose(); }
});

test("overlapping lock and unlock requests for the same channel are serialized", async () => {
	const f = await fixture({ initial: [] });
	try {
		await Promise.all([f.actions.manage(f.ctx, "lock"), f.actions.manage(f.ctx, "unlock")]);
		assert.match(f.replies[0].content, /Đã khóa/);
		assert.match(f.replies[1].content, /Đã khôi phục/);
		assert.deepEqual(f.raw.permission_overwrites, []);
		assert.equal(await f.store.get(IDS.guild, IDS.channel), undefined);
	} finally { await f.dispose(); }
});

test("warns when a banner attachment cannot be sent and does not modify an administrator bot overwrite", async () => {
	const noAttachment = await fixture({ attachFiles: false, initial: [] });
	try {
		await noAttachment.actions.manage(noAttachment.ctx, "lock");
		assert.match(noAttachment.replies.at(-1).content, /thiếu \*\*Đính kèm tập tin/);
	} finally { await noAttachment.dispose(); }
	const admin = await fixture({ botAdmin: true, initial: [] });
	try {
		await admin.actions.manage(admin.ctx, "lock");
		assert.equal(admin.current(IDS.bot), undefined);
		await admin.actions.manage(admin.ctx, "unlock");
		assert.equal(admin.current(IDS.bot), undefined);
	} finally { await admin.dispose(); }
});

test("an unwritable recovery journal prevents all Discord changes", async () => {
	const f = await fixture();
	try {
		await f.store.ready();
		await fs.mkdir(f.file); // rename of the temporary file must fail
		await f.actions.manage(f.ctx, "lock");
		assert.match(f.replies.at(-1).content, /Không lưu được quyền cũ/);
		assert.equal(f.operations.length, 0);
		assert.equal(await f.store.get(IDS.guild, IDS.channel), undefined);
	} finally { await f.dispose(); }
});

test("unlock retains an @everyone denial that existed before /lock", async () => {
	const initial = [
		overwrite(IDS.guild, OverwriteType.Role, 0n, P.SendMessages),
		overwrite(IDS.bot, OverwriteType.Member, P.SendMessages | P.AttachFiles),
	];
	const f = await fixture({ initial });
	try {
		await f.actions.manage(f.ctx, "lock");
		assert.match(f.replies.at(-1).content, /Đã khóa/);
		await f.actions.manage(f.ctx, "unlock");
		assert.match(f.replies.at(-1).content, /Trước khi khóa.*đã bị chặn/);
		assert.equal(state(f.current(IDS.guild), "SendMessages"), false);
		assert.equal(state(f.current(IDS.bot), "SendMessages"), true);
	} finally { await f.dispose(); }
});

test("a snapshot from another bot is never used to edit permissions", async () => {
	const f = await fixture();
	try {
		await f.store.put({ guildId: IDS.guild, channelId: IDS.channel, botId: "999999999999999999", phase: "locked",
			everyone: { existed: false, permissions: { SendMessages: null, SendMessagesInThreads: null, CreatePublicThreads: null, CreatePrivateThreads: null } },
			bot: { existed: false, sendMessages: null, changed: true } });
		await f.actions.manage(f.ctx, "unlock");
		assert.match(f.replies.at(-1).content, /thuộc bot khác/);
		assert.equal(f.operations.length, 0);
		assert.ok(await f.store.get(IDS.guild, IDS.channel));
	} finally { await f.dispose(); }
});

test("a welcome event still sends a mention and banner after the channel is locked", async () => {
	const f = await fixture({ initial: [] });
	const greetingStore = new MemberGreetingStore(path.join(f.directory, "greetings.json"));
	const service = new MemberGreetingService(f.client, greetingStore, true, async () => Buffer.from("fake-jpeg"));
	try {
		await greetingStore.configure(IDS.guild, "welcome", IDS.channel);
		await f.actions.manage(f.ctx, "lock");
		const channel = await f.refresh();
		const sent: any[] = [];
		channel.send = async (payload: any) => {
			assert.equal(channel.permissionsFor(f.bot).has([P.ViewChannel, P.SendMessages, P.AttachFiles]), true);
			sent.push(payload);
		};
		await service.handleEvent("welcome", f.regular);
		assert.equal(sent.length, 1);
		assert.match(sent[0].content, new RegExp(`<@${IDS.member}>`));
		assert.deepEqual(sent[0].allowedMentions.users, [IDS.member]);
		assert.equal(sent[0].files[0].name, "welcome.jpg");
	} finally { service.close(); await f.dispose(); }
});

test("a failed final journal write is recoverable from its pending snapshot", async () => {
	const f = await fixture({ initial: [] });
	try {
		const put = f.store.put.bind(f.store);
		(f.store as any).put = async (record: any) => {
			if (record.phase === "locked") throw new Error("simulated full disk");
			return put(record);
		};
		await f.actions.manage(f.ctx, "lock");
		assert.match(f.replies.at(-1).content, /Chưa xác nhận khóa/);
		assert.equal((await f.store.get(IDS.guild, IDS.channel))?.phase, "pending");
		await f.actions.manage(f.ctx, "unlock");
		assert.deepEqual(f.raw.permission_overwrites, []);
		assert.equal(await f.store.get(IDS.guild, IDS.channel), undefined);
	} finally { await f.dispose(); }
});

test("channel lock snapshots are atomically serialized across many channels", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dtrx-lock-store-"));
	const file = path.join(directory, "locks.json");
	const store = new ChannelLockStore(file);
	try {
		await Promise.all(Array.from({ length: 20 }, (_, i) => store.put({ guildId: "guild", channelId: `channel-${i}`, botId: "bot", phase: "locked",
			everyone: { existed: false, permissions: { SendMessages: null, SendMessagesInThreads: true, CreatePublicThreads: false, CreatePrivateThreads: null } },
			bot: { existed: false, sendMessages: null, changed: true } })));
		await store.flush();
		const reloaded = new ChannelLockStore(file);
		assert.equal((JSON.parse(await fs.readFile(file, "utf8")) as unknown[]).length, 20);
		assert.equal((await reloaded.get("guild", "channel-19"))?.everyone.permissions.SendMessagesInThreads, true);
		await Promise.all([reloaded.remove("guild", "channel-0"), reloaded.remove("guild", "channel-1")]);
		assert.equal((JSON.parse(await fs.readFile(file, "utf8")) as unknown[]).length, 18);
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});
