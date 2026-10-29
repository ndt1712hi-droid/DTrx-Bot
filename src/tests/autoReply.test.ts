import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Events, PermissionFlagsBits, type Client } from "discord.js";
import { AutoReplyStore, MAX_AUTO_REPLY_RULES } from "../core/autoReplyStore.js";
import { AutoReplyActions, registerAutoReplyHandler } from "../handlers/autoReplyHandler.js";
import { registerInteractionHandler } from "../handlers/interactionHandler.js";
import type { CommandContext, ReplyPayload } from "../handlers/musicActions.js";

test("auto-replies persist, normalize whole messages, and isolate servers", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-reply-store-"));
	try {
		const file = path.join(dir, "auto-replies.json");
		const store = new AutoReplyStore(file);
		await Promise.all([
			store.set({ guildId: "g1", trigger: " Xin Chào ", reply: "Chào bạn!" }),
			store.set({ guildId: "g2", trigger: "xin chào", reply: "Chào server 2" }),
			store.set({ guildId: "g1", trigger: "bye", reply: "Hẹn gặp lại" }),
		]);
		await store.flush();
		const restored = new AutoReplyStore(file);
		assert.equal(await restored.find("g1", "  XIN CHÀO  "), "Chào bạn!");
		assert.equal(await restored.find("g1", "xin cha\u0300o"), "Chào bạn!");
		assert.equal(await restored.find("g2", "XIN CHÀO"), "Chào server 2");
		assert.equal(await restored.find("g3", "xin chào"), undefined);
		assert.equal(await restored.find("g1", "xin chào bạn"), undefined, "Partial messages must not match");
		await restored.set({ guildId: "g1", trigger: "XIN CHÀO", reply: "Đã đổi" });
		assert.equal((await restored.list("g1")).length, 2, "Case variants update rather than duplicate");
		assert.equal(await restored.remove("g1", "  Xin Chào  "), true);
		assert.equal(await restored.remove("g1", "missing"), false);
		const after = new AutoReplyStore(file);
		assert.equal(await after.find("g1", "xin chào"), undefined);
		assert.equal(await after.find("g1", "bye"), "Hẹn gặp lại");
		assert.equal(await after.find("g2", "xin chào"), "Chào server 2");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("auto-reply rejects invalid, oversized, excess, and corrupt configuration without data loss", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-reply-invalid-"));
	try {
		const file = path.join(dir, "auto-replies.json");
		const seed = Array.from({ length: MAX_AUTO_REPLY_RULES }, (_, i) => ({ guildId: "g1", trigger: `trigger${i}`, reply: `reply${i}` }));
		await fs.writeFile(file, JSON.stringify(seed), "utf8");
		const store = new AutoReplyStore(file);
		await assert.rejects(store.set({ guildId: "g1", trigger: "extra", reply: "reply" }), /tối đa/);
		await assert.rejects(store.set({ guildId: "g1", trigger: " ", reply: "reply" }), /ký tự/);
		await assert.rejects(store.set({ guildId: "g1", trigger: "trigger0", reply: "x".repeat(2_001) }), /ký tự/);
		await store.set({ guildId: "g1", trigger: "TRIGGER0", reply: "updated" });
		assert.equal(await store.find("g1", "trigger0"), "updated");

		await fs.writeFile(file, "{not json", "utf8");
		const corrupt = new AutoReplyStore(file);
		await assert.rejects(corrupt.ready(), /Không thể đọc cấu hình/);
		await assert.rejects(corrupt.set({ guildId: "g1", trigger: "x", reply: "y" }));
		assert.equal(await fs.readFile(file, "utf8"), "{not json");

		const failFile = path.join(dir, "directory-instead-of-file");
		const failing = new AutoReplyStore(failFile);
		await failing.ready();
		await fs.mkdir(failFile);
		await assert.rejects(failing.set({ guildId: "g1", trigger: "x", reply: "y" }));
		assert.equal(await failing.find("g1", "x"), undefined, "A failed write must not activate the rule in memory");
		assert.deepEqual((await fs.readdir(dir)).sort(), ["auto-replies.json", "directory-instead-of-file"]);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("message handler replies to humans, never bots/self/webhooks, and prevents pings", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-reply-handler-"));
	try {
		const store = new AutoReplyStore(path.join(dir, "rules.json"));
		await store.set({ guildId: "g1", trigger: "xin chào", reply: "@everyone Chào bạn" });
		const client = Object.assign(new EventEmitter(), { user: { id: "self" } });
		registerAutoReplyHandler(client as unknown as Client, store, true);
		const listener = client.listeners(Events.MessageCreate)[0] as (message: unknown) => Promise<void>;
		const sent: any[] = [];
		const base = { guildId: "g1", author: { id: "human", bot: false }, webhookId: null, content: "  XIN CHÀO ", reply: async (value: unknown) => { sent.push(value); } };
		await listener(base);
		assert.deepEqual(sent, [{ content: "@everyone Chào bạn", allowedMentions: { parse: [], repliedUser: false } }]);
		await listener({ ...base, author: { id: "another-bot", bot: true } });
		await listener({ ...base, author: { id: "self", bot: false } });
		await listener({ ...base, webhookId: "webhook-1" });
		await listener({ ...base, guildId: null });
		await listener({ ...base, guildId: "other-guild" });
		await listener({ ...base, content: "xin chào bạn" });
		await listener({ ...base, content: "" });
		assert.equal(sent.length, 1);

		const noIntent = Object.assign(new EventEmitter(), { user: { id: "self" } });
		registerAutoReplyHandler(noIntent as unknown as Client, store, false);
		const disabled = noIntent.listeners(Events.MessageCreate)[0] as (message: unknown) => Promise<void>;
		await disabled(base);
		assert.equal(sent.length, 1, "Without Message Content Intent automatic responses are disabled");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("only server managers configure replies, with clear intent warnings and removal", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-reply-actions-"));
	try {
		const store = new AutoReplyStore(path.join(dir, "rules.json"));
		const actions = new AutoReplyActions(store, false);
		const messages: ReplyPayload[] = [];
		let canManage = false;
		const ctx: CommandContext = {
			guild: { id: "g1", ownerId: "owner" } as any,
			member: { permissions: { has: (permission: bigint) => permission === PermissionFlagsBits.ManageGuild && canManage } } as any,
			userId: "member",
			textChannelId: "text",
			defer: async () => undefined,
			reply: async (payload) => { messages.push(payload); },
		};
		await actions.manage(ctx, "set", "hi", "hello");
		assert.equal(await store.find("g1", "hi"), undefined);
		assert.ok(messages.at(-1)?.content?.includes("Manage Server"));
		canManage = true;
		await actions.manage(ctx, "set", " ", "hello");
		assert.ok(messages.at(-1)?.content?.includes("kích hoạt"));
		await actions.manage(ctx, "set", "hi", "hello");
		assert.ok(messages.at(-1)?.content?.includes("Message Content Intent"));
		assert.equal(await store.find("g1", "HI"), "hello");
		await actions.manage(ctx, "list");
		assert.ok(messages.at(-1)?.embeds?.[0].data.description?.includes("hi"));
		await actions.manage(ctx, "remove", "Hi");
		assert.equal(await store.find("g1", "hi"), undefined);
		assert.ok(messages.every((message) => message.ephemeral), "Management responses should be private");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("/autoreply routes set, remove and list through the early-acknowledged interaction handler", async () => {
	const client = new EventEmitter();
	const seen: Array<[string, string | undefined, string | undefined]> = [];
	const autoActions = {
		manage: async (ctx: CommandContext, mode: string, trigger?: string, reply?: string) => {
			seen.push([mode, trigger, reply]);
			await ctx.reply({ content: "ok" });
		},
	};
	registerInteractionHandler({ client } as any, {} as any, autoActions as any);
	const listener = client.listeners(Events.InteractionCreate)[0] as (interaction: unknown) => Promise<void>;
	for (const mode of ["set", "remove", "list"]) {
		const calls: string[] = [];
		const member = { id: "user" };
		const interaction: any = {
			commandName: "autoreply", guildId: "g1", user: { id: "user" }, member,
			guild: { id: "g1", members: { cache: new Map([["user", member]]) } },
			channelId: "text", deferred: false, replied: false, ephemeral: null,
			isAutocomplete: () => false, isButton: () => false, isStringSelectMenu: () => false,
			isChatInputCommand: () => true, inGuild: () => true,
			options: { getSubcommand: () => mode, getString: (key: string) => key === "trigger" ? "hello" : "reply" },
			async deferReply() { this.deferred = true; calls.push("defer"); },
			async editReply() { this.replied = true; calls.push("edit"); },
		};
		await listener(interaction);
		assert.deepEqual(calls, ["defer", "edit"]);
	}
	assert.deepEqual(seen, [["set", "hello", "reply"], ["remove", "hello", undefined], ["list", undefined, undefined]]);
});
