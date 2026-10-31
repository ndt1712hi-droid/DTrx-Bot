import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { AudioPlayerStatus, createAudioResource, StreamType, VoiceConnectionStatus } from "@discordjs/voice";
import { ChannelType, Collection, GatewayIntentBits, MessageFlags, PermissionFlagsBits } from "discord.js";
import OpusScript from "opusscript";
import { PREDEFINED_FILTERS, type Track } from "ziplayer";
import { assertBotCredentials, loadConfig, resolveAndBindFfmpeg } from "../config.js";
import { exportTrackToMp3Buffer } from "../core/exporter.js";
import { SessionPersistence } from "../core/persistence.js";
import { AlwaysOnVoiceStore } from "../core/alwaysOnStore.js";
import { buildSlashCommands } from "../handlers/slashDefinitions.js";
import { createBotInstance, supportsVoiceRuntime } from "../index.js";
import { mockBackgroundMediaInitialization } from "./offlineMedia.js";
import { waitForAudioDelivery } from "../core/playbackHealth.js";
import { installManagedAudioResources } from "../core/managedAudioResource.js";
import { resolveInteractionGuildAndMember } from "../handlers/interactionHandler.js";
import { getVoicePlaybackIssue, validateMemberVoiceAccess, type CommandContext, type ReplyPayload } from "../handlers/musicActions.js";
import {
	buildFullLyricsEmbed,
	buildHelpEmbed,
	buildNowPlayingPayload,
	buildQueueEmbed,
	buildStatsEmbed,
} from "../ui/embeds.js";
import {
	formatDuration,
	nextLoopMode,
	parseLavalinkNodes,
	parseTimeInput,
	parseVoiceCommand,
	sanitizeFilename,
} from "../utils/format.js";

// ZiPlayer eagerly initializes its music providers and Edge voices. Keep unit
// tests deterministic and offline; playback-specific paths are mocked separately.
const restoreMediaInitialization = mockBackgroundMediaInitialization();
test.after(restoreMediaInitialization);
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
	const url = input instanceof Request ? input.url : String(input);
	if (url.startsWith("https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list")) {
		return Promise.resolve(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
	}
	return nativeFetch(input, init);
}) as typeof fetch;
test.after(() => { globalThis.fetch = nativeFetch; });

function createSampleWavBuffer(durationMs = 400, sampleRate = 44100): Buffer {
	const numSamples = Math.floor((sampleRate * durationMs) / 1000);
	const dataSize = numSamples * 2; // 16-bit mono
	const buffer = Buffer.alloc(44 + dataSize);

	buffer.write("RIFF", 0);
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write("WAVE", 8);
	buffer.write("fmt ", 12);
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20); // PCM
	buffer.writeUInt16LE(1, 22); // Mono
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * 2, 28);
	buffer.writeUInt16LE(2, 32);
	buffer.writeUInt16LE(16, 34);
	buffer.write("data", 36);
	buffer.writeUInt32LE(dataSize, 40);

	for (let i = 0; i < numSamples; i++) {
		const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000);
		buffer.writeInt16LE(sample, 44 + i * 2);
	}
	return buffer;
}

const sampleTrack = (idx: number): Track => ({
	id: `track-${idx}`,
	title: `Bài hát thử nghiệm #${idx}`,
	url: `https://www.youtube.com/watch?v=dQw4w9WgXc${idx}`,
	duration: 185_000,
	thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
	requestedBy: "123456789012345678",
	source: "youtube",
	author: "ZiProject Artist",
});

test("FFmpeg static resolver binds FFMPEG_BIN and FFMPEG_PATH to an existing binary", () => {
	const bin = resolveAndBindFfmpeg();
	assert.ok(bin, "Expected ffmpeg-static binary to be resolved");
	assert.equal(process.env.FFMPEG_BIN, bin);
	assert.equal(process.env.FFMPEG_PATH, bin);
});

test("Config loader & credential assertion handle defaults and validation safely", () => {
	const cfg = loadConfig({
		DISCORD_TOKEN: "",
		BOT_PREFIX: "?",
		DEFAULT_VOLUME: "125",
		VOICE_WAKE_WORDS: "zi, mrdon",
		LAVALINK_NODES: "127.0.0.1:2333:secret:false",
	});

	assert.equal(cfg.prefix, "?");
	assert.equal(cfg.defaultVolume, 100);
	assert.deepEqual(cfg.voiceWakeWords, ["zi", "mrdon"]);
	assert.equal(cfg.lavalinkNodes.length, 1);
	assert.equal(cfg.lavalinkNodes[0].host, "127.0.0.1");
	assert.equal(cfg.lavalinkNodes[0].port, 2333);

	assert.throws(() => assertBotCredentials(cfg), /DISCORD_TOKEN/);
});

test("Time parser, duration formatter, loop cycle, Lavalink parser, and filename sanitizer", () => {
	assert.equal(parseTimeInput("90"), 90_000);
	assert.equal(parseTimeInput("1:30"), 90_000);
	assert.equal(parseTimeInput("01:02:03"), 3_723_000);
	assert.equal(parseTimeInput("2m15s"), 135_000);
	assert.equal(parseTimeInput("1:99"), null);
	assert.equal(parseTimeInput("-10"), null);
	assert.equal(parseTimeInput("abc"), null);

	assert.equal(formatDuration(185_000), "03:05");
	assert.equal(formatDuration(3_723_000), "1:02:03");
	assert.equal(formatDuration(0, true), "🔴 LIVE");

	assert.equal(nextLoopMode("off"), "track");
	assert.equal(nextLoopMode("track"), "queue");
	assert.equal(nextLoopMode("queue"), "off");

	assert.ok(sanitizeFilename("Sơn Tùng M-TP | Lạc Trôi (Official MV)").endsWith(".mp3"));

	const jsonNodes = parseLavalinkNodes(
		JSON.stringify([{ host: "lava.example.com", port: 443, password: "pw", secure: true }]),
	);
	assert.equal(jsonNodes.length, 1);
	assert.equal(jsonNodes[0].secure, true);
});

test("Vietnamese and English voice command parser enforces wake words", () => {
	assert.equal(parseVoiceCommand("hôm nay trời đẹp quá", ["zi", "bot"]), null);

	assert.deepEqual(parseVoiceCommand("zi phát Chúng Ta Của Hiện Tại", ["zi", "bot"]), {
		type: "play",
		query: "Chúng Ta Của Hiện Tại",
	});
	assert.deepEqual(parseVoiceCommand("Hey bot bỏ qua", ["zi", "bot"]), { type: "skip" });
	assert.deepEqual(parseVoiceCommand("ơi zi âm lượng 65%", ["zi", "bot"]), { type: "volume", level: 65 });
	assert.deepEqual(parseVoiceCommand("bot tạm dừng", ["zi", "bot"]), { type: "pause" });
	assert.deepEqual(parseVoiceCommand("zi tiếp tục", ["zi", "bot"]), { type: "resume" });
	assert.deepEqual(parseVoiceCommand("bot lặp bài", ["zi", "bot"]), { type: "loop", mode: "track" });
});

test("Slash command definitions build all 33 commands cleanly", () => {
	const commands = buildSlashCommands();
	assert.equal(commands.length, 33);
	const names = new Set(commands.map((c) => c.name));
	for (const expected of [
		"play",
		"playnext",
		"tts",
		"247",
		"autoreply",
		"welcome",
		"goodbye",
		"lock",
		"unlock",
		"spam",
		"pause",
		"resume",
		"skip",
		"previous",
		"stop",
		"leave",
		"nowplaying",
		"queue",
		"shuffle",
		"loop",
		"autoplay",
		"seek",
		"volume",
		"move",
		"swap",
		"remove",
		"clear",
		"filter",
		"lyrics",
		"save",
		"mirror",
		"stats",
		"help",
	]) {
		assert.ok(names.has(expected), `Missing slash command: ${expected}`);
	}
	const stay = commands.find((command) => command.name === "247");
	assert.deepEqual(stay?.options?.map((option) => option.name), ["on", "off", "status"]);
	const autoReply = commands.find((command) => command.name === "autoreply");
	assert.deepEqual(autoReply?.options?.map((option) => option.name), ["set", "remove", "list"]);
	assert.equal(autoReply?.default_member_permissions, "32", "Only members with Manage Server can configure auto-replies by default");
	for (const name of ["welcome", "goodbye"]) {
		const command = commands.find((entry) => entry.name === name);
		assert.deepEqual(command?.options?.map((option) => option.name), ["set", "off", "status", "test", "banner", "reset-banner"]);
		const upload = command?.options?.find((option) => option.name === "banner") as { options?: { name: string; required?: boolean }[] } | undefined;
		assert.deepEqual(upload?.options?.map((option) => [option.name, option.required]), [["image", true]]);
		assert.equal(command?.default_member_permissions, "32", "Greeting configuration requires Manage Server by default");
	}
	const spam = commands.find((command) => command.name === "spam");
	assert.equal(spam?.default_member_permissions, PermissionFlagsBits.ManageGuild.toString());
	assert.deepEqual(spam?.options?.map((option) => option.name), ["set", "on", "off", "delete", "clear", "status"]);
	const setReminder = spam?.options?.find((option) => option.name === "set") as { options?: { name: string; required?: boolean; min_value?: number; max_value?: number }[] } | undefined;
	assert.deepEqual(setReminder?.options?.map((option) => option.name), ["user", "channel", "interval", "count", "message"]);
	assert.equal(setReminder?.options?.find((option) => option.name === "user")?.required, true);
	assert.deepEqual([setReminder?.options?.find((option) => option.name === "interval")?.min_value, setReminder?.options?.find((option) => option.name === "interval")?.max_value], [5, 100]);
	assert.deepEqual([setReminder?.options?.find((option) => option.name === "count")?.min_value, setReminder?.options?.find((option) => option.name === "count")?.max_value], [1, 100]);
	for (const name of ["lock", "unlock"]) {
		const command = commands.find((entry) => entry.name === name);
		assert.equal(command?.default_member_permissions, PermissionFlagsBits.ManageRoles.toString());
		assert.deepEqual(command?.options?.map((option) => option.name), ["channel"]);
		const option = command?.options?.[0] as { required?: boolean; channel_types?: number[] } | undefined;
		assert.notEqual(option?.required, true, "The current channel is used when no target is specified");
		assert.deepEqual(option?.channel_types, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);
	}
});

test("ZiMusicBotEngine initializes all 5 plugins, isolates per-guild extensions, and builds rich embeds", async () => {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ziplayer-bot-test-"));
	const persistPath = path.join(tmpDir, "sessions.json");

	const { client, engine } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		PERSISTENCE_FILE: persistPath,
		ENABLE_PERSISTENCE: "true",
		ENABLE_LYRICS: "true",
	});

	try {
		const pluginNames = engine.manager.getPlugins().map((p) => p.name.toLowerCase());
		assert.equal(pluginNames.length, 5, "Should register all 5 @ziplayer/plugin sources");
		assert.equal(Object.keys(PREDEFINED_FILTERS).length, 36);

		// Multi-guild player creation & extension isolation check
		const playerA = await engine.getOrCreatePlayer({
			guildId: "111111111111111111",
			voiceChannelId: "222222222222222222",
			textChannelId: "333333333333333333",
		});
		const playerB = await engine.getOrCreatePlayer({
			guildId: "444444444444444444",
			voiceChannelId: "555555555555555555",
			textChannelId: "666666666666666666",
		});

		const extA = playerA.extensionManager.get("lyricsExt");
		const extB = playerB.extensionManager.get("lyricsExt");
		assert.ok(extA && extB, "Both guilds should have active lyricsExt");
		assert.notEqual(extA, extB, "Each guild must own an isolated lyricsExt instance");
		assert.equal(extA.player, playerA);
		assert.equal(extB.player, playerB);

		// Queue & filter operations
		playerA.setCurrentTrack(sampleTrack(1));
		playerA.queue.addMultiple([sampleTrack(2), sampleTrack(3), sampleTrack(4)]);
		assert.equal(playerA.queueSize, 3);

		playerA.queue.move(2, 0);
		assert.equal(playerA.queue.getTrack(0)?.id, "track-4");

		playerA.queue.swap(0, 1);
		assert.equal(playerA.queue.getTrack(1)?.id, "track-4");

		playerA.setVolume(95);
		assert.equal(playerA.volume, 95);

		playerA.loop("queue");
		assert.equal(playerA.queue.getLoopMode(), "queue");

		await playerA.filter.applyFilter("bassboost");
		assert.equal(playerA.filter.hasFilter("bassboost"), true);

		// Discord UI payloads
		const npPayload = buildNowPlayingPayload(playerA, false);
		assert.equal(npPayload.embeds.length, 1);
		assert.equal(npPayload.components.length, 3);

		const qEmbed = buildQueueEmbed(playerA, 1);
		assert.ok(qEmbed.data.description?.includes("Bài hát thử nghiệm"));

		const lrcEmbed = buildFullLyricsEmbed(sampleTrack(1), {
			provider: "lrclib",
			text: "Đoạn lời bài hát thử nghiệm...",
			trackName: "Bài hát #1",
		});
		assert.ok(lrcEmbed.data.description?.includes("Đoạn lời bài hát"));

		const statsEmbed = buildStatsEmbed(engine.manager, client);
		assert.ok((statsEmbed.data.fields?.length ?? 0) >= 3);

		const helpEmbed = buildHelpEmbed("!");
		assert.ok((helpEmbed.data.fields?.length ?? 0) >= 4);
		assert.ok(helpEmbed.data.fields?.some((field) => field.value.includes("/welcome set")));
		assert.ok(helpEmbed.data.fields?.every((field) => field.value.length <= 1024), "Help fields fit Discord's limit");

		// Persistence snapshot & reload
		const persistence = new SessionPersistence(persistPath, true);
		await persistence.saveAll(engine.manager);
		const loaded = await persistence.loadValidSessions();
		assert.equal(loaded.length, 1);
		assert.equal(loaded[0].guildId, "111111111111111111");
		assert.deepEqual(loaded[0].activeFilters, ["bassboost"]);

		await playerA.filter.clearAll();
		assert.equal(playerA.filter.getActiveFilters().length, 0);
	} finally {
		await engine.shutdown();
		await client.destroy();
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test("MP3 Exporter transcodes stream through ffmpeg-static with audio filter into valid MP3 bytes", async () => {
	const ffmpegPath = resolveAndBindFfmpeg();
	assert.ok(ffmpegPath);

	const wavBytes = createSampleWavBuffer(500);
	const fakePlayer = {
		filter: {
			getActiveFilters: () => [],
		},
		save: async () => Readable.from([wavBytes]),
	} as unknown as Parameters<typeof exportTrackToMp3Buffer>[0];

	const mp3 = await exportTrackToMp3Buffer(fakePlayer, sampleTrack(99), {
		ffmpegPath,
		filterName: "bassboost",
		maxDurationSec: 600,
	});

	assert.ok(mp3.length > 500, `Expected non-empty MP3 output, got ${mp3.length} bytes`);
	const headerAscii = mp3.subarray(0, 3).toString("ascii");
	const isMp3Sync = mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0;
	assert.ok(headerAscii === "ID3" || isMp3Sync, "Output must start with ID3 tag or MPEG frame sync");
});

test("Voice access boundary rejects members outside voice channel or in a different voice channel", async () => {
	const { client, engine, actions } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
	});

	try {
		const noVoiceMember = { voice: { channel: null }, guild: { members: { me: null } } } as any;
		const res1 = validateMemberVoiceAccess(noVoiceMember);
		assert.equal(res1.ok, false);

		const player = await engine.getOrCreatePlayer({
			guildId: "900000000000000001",
			voiceChannelId: "900000000000000010",
			textChannelId: "900000000000000020",
		});
		// Simulate connected bot in channel 900000000000000010
		player.connection = { joinConfig: { channelId: "900000000000000010" } } as any;
		player.setCurrentTrack(sampleTrack(10));
		player.queue.addMultiple([sampleTrack(11), sampleTrack(12), sampleTrack(13)]);

		const wrongRoomMember = {
			voice: { channel: { id: "900000000000000099" } },
			guild: { members: { me: null } },
		} as any;
		const res2 = validateMemberVoiceAccess(wrongRoomMember, player);
		assert.equal(res2.ok, false);

		const sameRoomMember = {
			voice: { channel: { id: "900000000000000010" } },
			guild: { members: { me: null } },
		} as any;
		const res3 = validateMemberVoiceAccess(sameRoomMember, player);
		assert.equal(res3.ok, true);

		// Exercise MusicCommandActions edge cases & happy paths
		const replies: ReplyPayload[] = [];
		const ctx: CommandContext = {
			guild: { id: "900000000000000001" } as any,
			member: sameRoomMember,
			userId: "123456789012345678",
			textChannelId: "900000000000000020",
			defer: async () => undefined,
			reply: async (payload) => {
				replies.push(payload);
			},
		};

		// Invalid NaN move
		await actions.move(ctx, Number.NaN, 1);
		assert.equal(replies.at(-1)?.ephemeral, true);

		// Valid move & swap & remove
		await actions.move(ctx, 3, 1);
		assert.equal(player.queue.getTrack(0)?.id, "track-13");

		await actions.swap(ctx, 1, 2);
		assert.equal(player.queue.getTrack(1)?.id, "track-13");

		await actions.remove(ctx, 2);
		assert.equal(player.queueSize, 2);

		// Seek out-of-range guard
		await actions.seek(ctx, "99:59");
		assert.equal(replies.at(-1)?.ephemeral, true);

		// Filter list, apply, remove, clear
		await actions.filter(ctx, "list");
		await actions.filter(ctx, "apply", "nightcore");
		assert.equal(player.filter.hasFilter("nightcore"), true);
		await actions.filter(ctx, "remove", "nightcore");
		assert.equal(player.filter.hasFilter("nightcore"), false);

		// Loop & Autoplay & Volume
		await actions.loop(ctx, "track");
		assert.equal(player.queue.getLoopMode(), "track");

		await actions.autoPlay(ctx);
		assert.equal(player.autoPlay(), true);

		await actions.volume(ctx, 110);
		assert.equal(replies.at(-1)?.ephemeral, true); // > 100 rejected cleanly

		await actions.volume(ctx, 75);
		assert.equal(player.volume, 75);
	} finally {
		// Clear fake connection before shutdown so voiceConnection.destroy isn't invoked on mock object
		const p = engine.manager.get("900000000000000001");
		if (p) p.connection = null;
		await engine.shutdown();
		await client.destroy();
	}
});

test("Free-tier lowPerformance profile & automatic MessageContent fallback intent mode", async () => {
	const fallback = createBotInstance(
		{ DISCORD_TOKEN: "dummy_token_for_unit_test", ENABLE_PERSISTENCE: "false" },
		{ includeMessageContentIntent: false },
	);

	try {
		assert.equal(fallback.config.lowPerformance, true, "lowPerformance should default to true for free-tier hosts");
		assert.equal(
			fallback.client.options.intents.has(GatewayIntentBits.MessageContent),
			false,
			"Fallback mode must omit privileged MessageContent intent",
		);
		assert.equal(fallback.client.options.intents.has(GatewayIntentBits.GuildVoiceStates), true);
	} finally {
		await fallback.engine.shutdown();
		await fallback.client.destroy();
	}
});

test("resolveInteractionGuildAndMember handles uncached raw APIInteractionGuildMember and missing bot scope", async () => {
	// 1. True DM
	const dmRes = await resolveInteractionGuildAndMember({
		inGuild: () => false,
		guildId: null,
	} as any);
	assert.equal(dmRes.ok, false);
	if (!dmRes.ok) assert.equal(dmRes.kind, "not_in_guild");

	// 2. Server interaction where interaction.guild is null & interaction.member is plain JSON (not instanceof GuildMember),
	//    resolved dynamically via guilds.fetch + members.fetch
	const fakeMember = { id: "user-1", voice: { channelId: "vc-1" } };
	const fakeGuild = {
		id: "guild-1",
		members: {
			cache: new Map(),
			fetch: async (uid: string) => (uid === "user-1" ? fakeMember : null),
		},
	};
	const uncachedRes = await resolveInteractionGuildAndMember({
		inGuild: () => true,
		guildId: "guild-1",
		guild: null,
		member: { user: { id: "user-1" }, roles: [] }, // Raw APIInteractionGuildMember!
		user: { id: "user-1" },
		applicationId: "app-999",
		client: {
			guilds: {
				cache: new Map(),
				fetch: async (gid: string) => (gid === "guild-1" ? fakeGuild : null),
			},
		},
	} as any);
	assert.equal(uncachedRes.ok, true);

	// 3. Server interaction where app was User-Installed or invited without `bot` scope (guilds.fetch fails)
	const missingBotScopeRes = await resolveInteractionGuildAndMember({
		inGuild: () => true,
		guildId: "guild-missing",
		guild: null,
		member: { user: { id: "user-1" } },
		user: { id: "user-1" },
		applicationId: "987654321098765432",
		client: {
			guilds: {
				cache: new Map(),
				fetch: async () => {
					throw new Error("Unknown Guild");
				},
			},
		},
	} as any);
	assert.equal(missingBotScopeRes.ok, false);
	if (!missingBotScopeRes.ok) {
		assert.equal(missingBotScopeRes.kind, "bot_not_in_guild");
		assert.ok(missingBotScopeRes.message.includes("scope=bot+applications.commands"));
		assert.ok(missingBotScopeRes.message.includes("987654321098765432"));
	}
});

test("TTS query routes exclusively to TTSPlugin without SoundCloud hijacking", async () => {
	const { client, engine } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
	});

	try {
		const soundcloud = engine.manager.getPlugins().find((p) => p.name === "soundcloud") as any;
		assert.ok(soundcloud);
		let musicSearches = 0;
		soundcloud.ready = Promise.resolve();
		soundcloud.client = {
			search: async () => {
				musicSearches++;
				return [{ id: 1, title: "Unrelated music", permalink_url: "https://soundcloud.com/example/song" }];
			},
		};
		// The routing test must not depend on Google/Edge network availability.
		(engine.ttsPlugin as any).analyzeTTSDuration = async () => 1;

		const res = await engine.manager.search("tts: Xin chào anh em", "123456");
		assert.equal(musicSearches, 0, "SoundCloud must not search a reserved TTS query");
		assert.equal(res.tracks.length, 1, "Only TTSPlugin should handle 'tts:' prefixed queries");
		assert.equal(res.tracks[0].source, "tts");
		assert.ok(res.tracks[0].title.includes("Xin chào anh em"));
	} finally {
		await engine.shutdown();
		await client.destroy();
	}
});

test("TTS isolation preserves the YouTube plugin's mobile URL handling", async () => {
	const { client, engine } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
	});

	try {
		const youtube = engine.manager.getPlugins().find((p) => p.name === "youtube") as any;
		assert.ok(youtube);
		await youtube.ready;
		youtube.ready = Promise.resolve();
		let requestedId = "";
		youtube.client = {
			getInfo: async (id: string) => {
				requestedId = id;
				return { basic_info: { id, title: "Mobile YouTube result", duration: 120 } };
			},
		};
		const result = await youtube.search("https://m.youtube.com/watch?v=dQw4w9WgXcQ", "123456");
		assert.equal(requestedId, "dQw4w9WgXcQ");
		assert.equal(result.tracks[0]?.title, "Mobile YouTube result");
	} finally {
		await engine.shutdown();
		await client.destroy();
	}
});

test("TTS command passes a TTS track directly to the player and reports failures", async () => {
	const { client, engine, actions } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
	});

	try {
		const track = {
			id: "tts-123",
			title: "TTS (vi): Xin chào",
			url: "tts://test",
			duration: 1,
			requestedBy: "user-1",
			source: "tts",
			metadata: { tts: { text: "Xin chào", lang: "vi", slow: false } },
		};
		let passedTrack: unknown;
		let playSucceeds = true;
		const player = {
			play: async (value: unknown, userId: string) => {
				passedTrack = value;
				assert.equal(userId, "user-1");
				return playSucceeds;
			},
		};
		engine.getOrCreatePlayer = async () => player as any;
		engine.ensureConnected = async () => undefined;
		engine.ttsPlugin.search = async (query, requestedBy) => {
			assert.equal(query, "tts:Xin chào");
			assert.equal(requestedBy, "user-1");
			return { tracks: [track] };
		};
		(engine.manager as any).search = async () => {
			throw new Error("TTS must not search music sources");
		};

		const replies: ReplyPayload[] = [];
		const ctx: CommandContext = {
			guild: { id: "guild-1" } as any,
			member: { voice: { channel: { id: "voice-1" } }, guild: { members: { me: null } } } as any,
			userId: "user-1",
			textChannelId: "text-1",
			defer: async () => undefined,
			reply: async (payload) => { replies.push(payload); },
		};

		await actions.tts(ctx, "  Xin chào  ");
		assert.equal(passedTrack, track, "Pass the TTS track itself, not a query string");
		assert.ok(replies.at(-1)?.embeds?.[0].data.description?.includes("giọng đọc"));

		playSucceeds = false;
		await actions.tts(ctx, "Xin chào");
		assert.ok(replies.at(-1)?.embeds?.[0].data.description?.includes("Không thể phát"));
	} finally {
		await engine.shutdown();
		await client.destroy();
	}
});

function createFakeSlashInteraction(guildId: string | null = "guild-1") {
	const calls: Array<{ method: string; payload?: any }> = [];
	const interaction: any = {
		calls,
		commandName: "tts",
		guildId,
		guild: null,
		member: { user: { id: "user-1" } },
		user: { id: "user-1" },
		applicationId: "application-1",
		channelId: "text-1",
		deferred: false,
		replied: false,
		ephemeral: null,
		isAutocomplete: () => false,
		isButton: () => false,
		isStringSelectMenu: () => false,
		isChatInputCommand: () => true,
		isRepliable: () => true,
		inGuild: () => guildId !== null,
		options: { getString: () => "Xin chào" },
		client: { guilds: { cache: new Map(), fetch: async () => null } },
		async deferReply(payload?: any) {
			calls.push({ method: "deferReply", payload });
			this.deferred = true;
			this.ephemeral = payload?.flags === MessageFlags.Ephemeral;
		},
		async editReply(payload: any) {
			calls.push({ method: "editReply", payload });
			this.replied = true;
		},
		async followUp(payload: any) {
			calls.push({ method: "followUp", payload });
			this.replied = true;
		},
		async deleteReply() { calls.push({ method: "deleteReply" }); },
		async reply(payload: any) {
			calls.push({ method: "reply", payload });
			this.replied = true;
		},
	};
	return interaction;
}

test("slash commands defer before a slow guild/member fetch and avoid double acknowledgement", async () => {
	const { client, engine, actions } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
	});
	let unblockGuildFetch: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { unblockGuildFetch = resolve; });
	try {
		const interaction = createFakeSlashInteraction();
		const fetchedMember = { id: "user-1" };
		interaction.client.guilds.fetch = async () => {
			interaction.calls.push({ method: "fetchGuild" });
			await gate;
			return {
				id: "guild-1",
				members: { cache: new Map(), fetch: async () => fetchedMember },
			};
		};
		actions.tts = async (ctx, text) => {
			assert.equal(text, "Xin chào");
			assert.equal(ctx.member, fetchedMember);
			await ctx.defer();
			await ctx.reply({ content: "Đã xử lý TTS" });
		};

		const listener = client.listeners("interactionCreate")[0] as (interaction: unknown) => Promise<void>;
		const handling = listener(interaction);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(interaction.calls.map((call: any) => call.method), ["deferReply", "fetchGuild"]);
		unblockGuildFetch?.();
		await handling;
		assert.deepEqual(interaction.calls.map((call: any) => call.method), ["deferReply", "fetchGuild", "editReply"]);
		assert.equal(interaction.calls.at(-1)?.payload.content, "Đã xử lý TTS");
	} finally {
		unblockGuildFetch?.();
		await engine.shutdown();
		await client.destroy();
	}
});

test("slash resolution errors remain private after a public early defer", async () => {
	const { client, engine } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
	});
	try {
		const interaction = createFakeSlashInteraction(null);
		const listener = client.listeners("interactionCreate")[0] as (interaction: unknown) => Promise<void>;
		await listener(interaction);
		assert.deepEqual(
			interaction.calls.map((call: any) => call.method),
			["deferReply", "editReply", "followUp", "deleteReply"],
		);
		assert.equal(interaction.calls[1].payload.content, "Đang gửi phản hồi...");
		assert.equal(interaction.calls[2].payload.flags, MessageFlags.Ephemeral);
		assert.ok(interaction.calls[2].payload.content.includes("Tin nhắn riêng"));
	} finally {
		await engine.shutdown();
		await client.destroy();
	}
});

test("unexpected slash errors complete the deferred interaction with a private error", async () => {
	const { client, engine, actions } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
	});
	try {
		const interaction = createFakeSlashInteraction();
		interaction.guild = {
			id: "guild-1",
			members: { cache: new Map([["user-1", { id: "user-1" }]]) },
		};
		actions.tts = async () => { throw new Error("simulated action failure"); };
		const listener = client.listeners("interactionCreate")[0] as (interaction: unknown) => Promise<void>;
		await listener(interaction);
		assert.deepEqual(
			interaction.calls.map((call: any) => call.method),
			["deferReply", "editReply", "followUp", "deleteReply"],
		);
		assert.equal(interaction.calls[2].payload.flags, MessageFlags.Ephemeral);
		assert.ok(interaction.calls[2].payload.content.includes("Đã xảy ra lỗi"));
	} finally {
		await engine.shutdown();
		await client.destroy();
	}
});

test("TTS reports a stalled metadata request and never plays it after timing out", async () => {
	const { client, engine, actions } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
	});
	try {
		engine.config.extractorTimeoutMs = 20;
		let finishSearch: ((value: any) => void) | undefined;
		engine.ttsPlugin.search = () => new Promise((resolve) => { finishSearch = resolve; });
		let playCount = 0;
		engine.getOrCreatePlayer = async () => ({ play: async () => { playCount++; return true; } }) as any;
		engine.ensureConnected = async () => undefined;
		const replies: ReplyPayload[] = [];
		const ctx: CommandContext = {
			guild: { id: "guild-1" } as any,
			member: { voice: { channel: { id: "voice-1" } }, guild: { members: { me: null } } } as any,
			userId: "user-1",
			textChannelId: "text-1",
			defer: async () => undefined,
			reply: async (payload) => { replies.push(payload); },
		};
		await actions.tts(ctx, "Xin chào");
		assert.equal(playCount, 0);
		assert.ok(replies[0]?.embeds?.[0].data.description?.includes("phản hồi quá lâu"));
		finishSearch?.({ tracks: [sampleTrack(1)] });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(playCount, 0, "A late search result must not start playing");
	} finally {
		await engine.shutdown();
		await client.destroy();
	}
});

test("failed TTS audio never falls back to YouTube or SoundCloud music", async () => {
	const { client, engine } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
		ENABLE_LYRICS: "false",
	});
	try {
		let unrelatedSearches = 0;
		for (const name of ["youtube", "soundcloud"]) {
			const plugin = engine.manager.getPlugins().find((p) => p.name === name) as any;
			assert.ok(plugin);
			plugin.ready = Promise.resolve();
			plugin.client = { search: async () => { unrelatedSearches++; return []; } };
		}
		engine.ttsPlugin.getStream = async () => { throw new Error("simulated TTS provider failure"); };
		const player = await engine.getOrCreatePlayer({
			guildId: "guild-1",
			voiceChannelId: "voice-1",
			textChannelId: "text-1",
		});
		const ttsTrack: Track = {
			id: "tts-failed-1",
			title: "TTS (vi): Xin chào",
			url: "tts://%7B%22text%22%3A%22Xin%20ch%C3%A0o%22%7D",
			duration: 1,
			requestedBy: "user-1",
			source: "tts",
			metadata: { tts: { text: "Xin chào", lang: "vi", slow: false } },
		};
		const stream = await player.pluginManager.getStream(ttsTrack);
		assert.equal(stream, null, "Unavailable TTS must fail rather than returning music");
		assert.equal(unrelatedSearches, 0, "Music fallbacks must not search the TTS title");
	} finally {
		await engine.shutdown();
		await client.destroy();
	}
});

function mockVoiceRoom(guildId = "guild-247", voiceChannelId = "voice-247") {
	const members = new Collection<string, { user: { bot: boolean } }>();
	const room: any = {
		id: voiceChannelId,
		guildId,
		type: ChannelType.GuildVoice,
		members,
		isVoiceBased: () => true,
	};
	const channels = new Collection<string, any>([[voiceChannelId, room]]);
	const guild: any = {
		id: guildId,
		members: { me: null },
		channels: { cache: channels, fetch: async (id: string) => channels.get(id) ?? null },
	};
	room.guild = guild;
	return { room, guild };
}

function fakeReadyConnection(channelId: string) {
	const connection: any = new EventEmitter();
	connection.joinConfig = { channelId, selfMute: false, selfDeaf: true };
	connection.state = { status: VoiceConnectionStatus.Ready };
	connection.packets = [] as Buffer[];
	connection.subscribe = (audioPlayer: any) => {
		const previous = connection.state.subscription;
		const subscription = audioPlayer.subscribe(connection);
		connection.state = { ...connection.state, subscription };
		previous?.unsubscribe();
		return subscription;
	};
	connection.onSubscriptionRemoved = (subscription: any) => {
		if (connection.state.subscription === subscription) delete connection.state.subscription;
	};
	connection.prepareAudioPacket = (packet: Buffer) => {
		if (connection.packets.length < 500) connection.packets.push(Buffer.from(packet));
	};
	connection.dispatchAudio = () => undefined;
	connection.setSpeaking = () => undefined;
	connection.destroy = () => {
		connection.state.subscription?.unsubscribe();
		connection.state = { status: VoiceConnectionStatus.Destroyed };
	};
	return connection;
}

test("24/7 storage serializes changes, restores them, and never overwrites corrupt data", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zi-stay-store-"));
	const file = path.join(dir, "voice-24-7.json");
	try {
		const store = new AlwaysOnVoiceStore(file);
		await store.ready();
		await Promise.all([
			store.set({ guildId: "g1", voiceChannelId: "v1", textChannelId: "t1" }),
			store.set({ guildId: "g2", voiceChannelId: "v2", textChannelId: "t2" }),
			store.remove("g1"),
		]);
		const restored = new AlwaysOnVoiceStore(file);
		await restored.ready();
		assert.deepEqual(restored.list(), [{ guildId: "g2", voiceChannelId: "v2", textChannelId: "t2" }]);
		assert.equal(restored.isEnabled("g1"), false);
		assert.equal(restored.isEnabled("g2"), true);
		await restored.remove("g2");
		const afterRemoval = new AlwaysOnVoiceStore(file);
		await afterRemoval.ready();
		assert.deepEqual(afterRemoval.list(), []);

		await fs.writeFile(file, "not valid json", "utf8");
		const corrupt = new AlwaysOnVoiceStore(file);
		await assert.rejects(corrupt.ready(), /Không thể đọc cấu hình 24\/7/);
		await assert.rejects(corrupt.set({ guildId: "g3", voiceChannelId: "v3", textChannelId: "t3" }));
		assert.equal(await fs.readFile(file, "utf8"), "not valid json");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("24/7 cancels existing idle timers and prevents leaving an empty room", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zi-stay-idle-"));
	const { client, engine } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
		PERSISTENCE_FILE: path.join(dir, "sessions.json"),
		LEAVE_ON_END: "true",
		LEAVE_ON_EMPTY: "true",
		LEAVE_TIMEOUT_MS: "5000",
	});
	try {
		const { room, guild } = mockVoiceRoom();
		const target = { guildId: guild.id, voiceChannelId: room.id, textChannelId: "text-247" };
		const player = await engine.getOrCreatePlayer(target);
		const lifecycle = player.runtimeGraph.lifecycleController as any;
		lifecycle.scheduleLeave("track-end");
		assert.ok(lifecycle.leaveTimer, "Normal mode should schedule leave after a track");

		client.emit("voiceStateUpdate", { guild, id: "human", channelId: room.id } as any,
			{ guild, id: "human", channelId: null } as any);
		assert.equal((engine as any).emptyChannelTimers.has(guild.id), true);
		engine.ensureConnected = async (p, channel) => { p.connection = fakeReadyConnection(channel.id); };
		await engine.enableAlwaysOnVoice(target, room);
		assert.equal(lifecycle.leaveTimer, null, "Enabling 24/7 cancels ZiPlayer's existing leave timer");
		assert.equal((engine as any).emptyChannelTimers.has(guild.id), false);
		lifecycle.scheduleLeave("track-end");
		lifecycle.scheduleLeave("queue-empty");
		assert.equal(lifecycle.leaveTimer, null, "24/7 suppresses new automatic leave timers");
		lifecycle.scheduleLeave("manual");
		assert.ok(lifecycle.leaveTimer, "Explicit/manual lifecycle leave must remain available");
		lifecycle.clearLeaveTimeout();
		client.emit("voiceStateUpdate", { guild, id: "human", channelId: room.id } as any,
			{ guild, id: "human", channelId: null } as any);
		assert.equal((engine as any).emptyChannelTimers.has(guild.id), false);

		assert.equal(await engine.disableAlwaysOnVoice(guild.id), true);
		assert.ok(lifecycle.leaveTimer, "Disabling 24/7 restores the normal idle policy");
		player.connection = null;
	} finally {
		await engine.shutdown();
		await client.destroy();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("24/7 restores an empty room after restart and retries a disconnected player", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zi-stay-reconnect-"));
	const file = path.join(dir, "voice-24-7.json");
	const seed = new AlwaysOnVoiceStore(file);
	const { room, guild } = mockVoiceRoom();
	await seed.set({ guildId: guild.id, voiceChannelId: room.id, textChannelId: "text-247" });
	const { client, engine } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
		PERSISTENCE_FILE: path.join(dir, "sessions.json"),
	});
	try {
		(client as any).isReady = () => true;
		client.guilds.cache.set(guild.id, guild);
		let connections = 0;
		engine.ensureConnected = async (player, channel) => {
			connections++;
			player.connection = fakeReadyConnection(channel.id);
		};
		assert.equal(room.members.size, 0, "The test room starts empty");
		assert.equal(await engine.startAlwaysOnVoice(), 1);
		assert.equal(connections, 1, "Bot should enter the saved room even with no human listeners");
		await engine.refreshAlwaysOnVoice();
		assert.equal(connections, 1, "A healthy connection must not be reconnected unnecessarily");

		let player = engine.manager.get(guild.id)!;
		(player.connection as any).state.status = VoiceConnectionStatus.Disconnected;
		await engine.refreshAlwaysOnVoice();
		assert.equal(connections, 2, "A disconnected voice session should reconnect");
		player.connection = null;
		player.destroy();
		await engine.refreshAlwaysOnVoice();
		assert.equal(connections, 3, "A destroyed player should be recreated");
		player = engine.manager.get(guild.id)!;
		assert.equal(await engine.disableAlwaysOnVoice(guild.id), true);
		player.connection = null;
		await engine.refreshAlwaysOnVoice();
		assert.equal(connections, 3, "Disabled 24/7 must not reconnect again");
	} finally {
		client.guilds.cache.delete(guild.id);
		await engine.shutdown();
		await client.destroy();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("concurrent 24/7 on and off are serialized so the last command wins", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zi-stay-race-"));
	const { client, engine } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
		PERSISTENCE_FILE: path.join(dir, "sessions.json"),
	});
	let releaseConnection: (() => void) | undefined;
	let signalStarted: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { releaseConnection = resolve; });
	const started = new Promise<void>((resolve) => { signalStarted = resolve; });
	try {
		const { room, guild } = mockVoiceRoom();
		engine.ensureConnected = async (player, channel) => {
			signalStarted?.();
			await gate;
			player.connection = fakeReadyConnection(channel.id);
		};
		const enabling = engine.enableAlwaysOnVoice({ guildId: guild.id, voiceChannelId: room.id, textChannelId: "text-247" }, room);
		await started;
		const disabling = engine.disableAlwaysOnVoice(guild.id);
		releaseConnection?.();
		await enabling;
		assert.equal(await disabling, true);
		assert.equal(await engine.getAlwaysOnVoiceTarget(guild.id), undefined);
		const player = engine.manager.get(guild.id);
		if (player) player.connection = null;
	} finally {
		releaseConnection?.();
		await engine.shutdown();
		await client.destroy();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("/leave disables 24/7 persistently instead of rejoining behind the user's back", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zi-stay-leave-"));
	const { client, engine, actions } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
		PERSISTENCE_FILE: path.join(dir, "sessions.json"),
	});
	try {
		const { room, guild } = mockVoiceRoom();
		engine.ensureConnected = async (player, channel) => { player.connection = fakeReadyConnection(channel.id); };
		await engine.enableAlwaysOnVoice({ guildId: guild.id, voiceChannelId: room.id, textChannelId: "text-247" }, room);
		const replies: ReplyPayload[] = [];
		const ctx: CommandContext = {
			guild,
			member: { voice: { channel: room }, guild } as any,
			userId: "user-1",
			textChannelId: "text-247",
			defer: async () => undefined,
			reply: async (payload) => { replies.push(payload); },
		};
		await actions.leave(ctx);
		assert.equal(await engine.getAlwaysOnVoiceTarget(guild.id), undefined);
		assert.ok(replies.at(-1)?.embeds?.[0].data.description?.includes("tắt 24/7"));
		const disk = new AlwaysOnVoiceStore(path.join(dir, "voice-24-7.json"));
		await disk.ready();
		assert.equal(disk.isEnabled(guild.id), false);
	} finally {
		await engine.shutdown();
		await client.destroy();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("24/7 failed joins use bounded retries and stop retrying on shutdown", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zi-stay-retry-"));
	const { room, guild } = mockVoiceRoom();
	const seed = new AlwaysOnVoiceStore(path.join(dir, "voice-24-7.json"));
	await seed.set({ guildId: guild.id, voiceChannelId: room.id, textChannelId: "text-247" });
	const { client, engine } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
		PERSISTENCE_FILE: path.join(dir, "sessions.json"),
	});
	try {
		(client as any).isReady = () => true;
		client.guilds.cache.set(guild.id, guild);
		let attempts = 0;
		engine.ensureConnected = async (player, channel) => {
			attempts++;
			if (attempts === 1) throw new Error("simulated voice failure");
			player.connection = fakeReadyConnection(channel.id);
		};
		await engine.startAlwaysOnVoice();
		assert.equal(attempts, 1);
		await engine.refreshAlwaysOnVoice();
		assert.equal(attempts, 1, "Immediate retries must be throttled");
		const backoff = (engine as any).reconnectBackoff.get(guild.id);
		assert.equal(backoff.failures, 1);
		assert.ok(backoff.retryAt > Date.now());
		backoff.retryAt = 0;
		await engine.refreshAlwaysOnVoice();
		assert.equal(attempts, 2);
		assert.equal((engine as any).reconnectBackoff.has(guild.id), false);
		const player = engine.manager.get(guild.id);
		if (player) player.connection = null;
		await engine.shutdown();
		await engine.refreshAlwaysOnVoice();
		assert.equal(attempts, 2, "Shutdown prevents new reconnect attempts");
	} finally {
		client.guilds.cache.delete(guild.id);
		await engine.shutdown();
		await client.destroy();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("voice connection logic reconnects a disconnected player and moves a ready connection", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zi-stay-connect-"));
	const { client, engine } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
		PERSISTENCE_FILE: path.join(dir, "sessions.json"),
	});
	try {
		const { room, guild } = mockVoiceRoom();
		const player = await engine.getOrCreatePlayer({ guildId: guild.id, voiceChannelId: room.id, textChannelId: "text-247" });
		let connects = 0;
		player.connection = { ...fakeReadyConnection(room.id), state: { status: VoiceConnectionStatus.Disconnected } };
		(player as any).connect = async () => {
			connects++;
			player.connection = fakeReadyConnection(room.id);
		};
		await engine.ensureConnected(player, room);
		assert.equal(connects, 1, "A disconnected connection with the correct channel ID must be reconnected");

		let rejoin: any;
		(player.connection as any).joinConfig = { channelId: "old-room", selfDeaf: true, selfMute: false };
		(player.connection as any).rejoin = (options: any) => { rejoin = options; return true; };
		await engine.ensureConnected(player, room);
		assert.deepEqual(rejoin, { channelId: room.id, selfDeaf: true, selfMute: false });
		assert.equal(connects, 1, "Moving a ready connection should not recreate the player");
		player.connection = null;
	} finally {
		await engine.shutdown();
		await client.destroy();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("slash and prefix 24/7 commands route their selected subcommand", async () => {
	const { client, engine, actions } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
	});
	try {
		const modes: string[] = [];
		actions.alwaysOnVoice = async (_ctx, mode) => { modes.push(mode ?? "status"); };
		const interaction = createFakeSlashInteraction();
		interaction.commandName = "247";
		interaction.options = { getSubcommand: () => "on" };
		interaction.guild = { id: "guild-1", members: { cache: new Map([["user-1", { id: "user-1" }]]) } };
		const slashListener = client.listeners("interactionCreate")[0] as (value: unknown) => Promise<void>;
		await slashListener(interaction);

		const prefixListener = client.listeners("messageCreate")[0] as (value: unknown) => Promise<void>;
		await prefixListener({
			content: `${engine.config.prefix}247 off`,
			author: { id: "user-1", bot: false },
			guild: { id: "guild-1" },
			member: { id: "user-1" },
			channel: { id: "text-1", isSendable: () => true },
			attachments: { size: 0 },
		});
		assert.deepEqual(modes, ["on", "off"]);
		assert.equal(interaction.calls[0].method, "deferReply");
	} finally {
		await engine.shutdown();
		await client.destroy();
	}
});

test("explicit leave suppresses an in-flight playback-session restore", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zi-stay-session-race-"));
	const { client, engine } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "true",
		PERSISTENCE_FILE: path.join(dir, "sessions.json"),
	});
	let resolveSessions: ((value: any[]) => void) | undefined;
	try {
		const { room, guild } = mockVoiceRoom();
		room.members.set("human", { user: { bot: false } });
		client.guilds.cache.set(guild.id, guild);
		let connects = 0;
		engine.ensureConnected = async (player, channel) => {
			connects++;
			player.connection = fakeReadyConnection(channel.id);
		};
		await engine.enableAlwaysOnVoice({ guildId: guild.id, voiceChannelId: room.id, textChannelId: "text-247" }, room);
		engine.persistence.loadValidSessions = async () => new Promise((resolve) => { resolveSessions = resolve; });
		engine.persistence.clearFile = async () => undefined;
		const restoring = engine.restorePersistedSessions();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(await engine.leaveVoice(guild.id), { disabled: true, left: true });
		resolveSessions?.([{
			guildId: guild.id,
			voiceChannelId: room.id,
			textChannelId: "text-247",
			currentTrack: sampleTrack(1),
			upcomingTracks: [],
			volume: 50,
			loopMode: "off",
			autoPlay: false,
			activeFilters: [],
			savedAt: Date.now(),
		}]);
		assert.equal(await restoring, 0);
		assert.equal(connects, 1, "Old playback must not reconnect after /leave");
		assert.equal(await engine.getAlwaysOnVoiceTarget(guild.id), undefined);
	} finally {
		resolveSessions?.([]);
		client.guilds.cache.delete("guild-247");
		await engine.shutdown();
		await client.destroy();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("24/7 action validates voice access and reports on, status, and off", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zi-stay-actions-"));
	const { client, engine, actions } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
		PERSISTENCE_FILE: path.join(dir, "sessions.json"),
	});
	try {
		const { room, guild } = mockVoiceRoom();
		engine.ensureConnected = async (player, channel) => { player.connection = fakeReadyConnection(channel.id); };
		const replies: ReplyPayload[] = [];
		const ctx: CommandContext = {
			guild,
			member: { voice: { channel: null }, guild } as any,
			userId: "user-1",
			textChannelId: "text-247",
			defer: async () => undefined,
			reply: async (payload) => { replies.push(payload); },
		};
		await actions.alwaysOnVoice(ctx, "on");
		assert.ok(replies.at(-1)?.embeds?.[0].data.description?.includes("tham gia"));
		assert.equal(await engine.getAlwaysOnVoiceTarget(guild.id), undefined);
		(ctx.member as any).voice.channel = room;
		await actions.alwaysOnVoice(ctx, "on");
		assert.ok(replies.at(-1)?.embeds?.[0].data.description?.includes("Đã bật"));
		assert.equal((await engine.getAlwaysOnVoiceTarget(guild.id))?.voiceChannelId, room.id);
		await actions.alwaysOnVoice(ctx, "status");
		assert.ok(replies.at(-1)?.embeds?.[0].data.description?.includes("Bot đang kết nối"));
		await actions.alwaysOnVoice(ctx, "off");
		assert.ok(replies.at(-1)?.embeds?.[0].data.description?.includes("Đã tắt"));
		assert.equal(await engine.getAlwaysOnVoiceTarget(guild.id), undefined);
		const player = engine.manager.get(guild.id);
		if (player) player.connection = null;
	} finally {
		await engine.shutdown();
		await client.destroy();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("turning 24/7 off restores the configured empty-room policy", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zi-stay-off-empty-"));
	const { client, engine } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
		PERSISTENCE_FILE: path.join(dir, "sessions.json"),
		LEAVE_ON_END: "false",
		LEAVE_ON_EMPTY: "true",
	});
	try {
		const { room, guild } = mockVoiceRoom();
		client.guilds.cache.set(guild.id, guild);
		engine.ensureConnected = async (player, channel) => { player.connection = fakeReadyConnection(channel.id); };
		await engine.enableAlwaysOnVoice({ guildId: guild.id, voiceChannelId: room.id, textChannelId: "text-247" }, room);
		const player = engine.manager.get(guild.id)!;
		await engine.disableAlwaysOnVoice(guild.id);
		assert.equal((player.runtimeGraph.lifecycleController as any).leaveTimer, null, "LEAVE_ON_END=false must be respected");
		assert.equal((engine as any).emptyChannelTimers.has(guild.id), true, "Empty-room timeout must resume even without a new voice event");
		player.connection = null;
	} finally {
		client.guilds.cache.delete("guild-247");
		await engine.shutdown();
		await client.destroy();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("old playback is not restored into a room different from the saved 24/7 target", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zi-stay-other-room-"));
	const { client, engine } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "true",
		PERSISTENCE_FILE: path.join(dir, "sessions.json"),
	});
	try {
		const { room, guild } = mockVoiceRoom();
		const old = mockVoiceRoom(guild.id, "old-room").room;
		old.guild = guild;
		old.members.set("human", { user: { bot: false } });
		guild.channels.cache.set(old.id, old);
		client.guilds.cache.set(guild.id, guild);
		let connections = 0;
		engine.ensureConnected = async (player, channel) => {
			connections++;
			player.connection = fakeReadyConnection(channel.id);
		};
		await engine.enableAlwaysOnVoice({ guildId: guild.id, voiceChannelId: room.id, textChannelId: "text-247" }, room);
		engine.persistence.loadValidSessions = async () => [{
			guildId: guild.id, voiceChannelId: old.id, textChannelId: "text-247",
			currentTrack: sampleTrack(1), upcomingTracks: [], volume: 50, loopMode: "off",
			autoPlay: false, activeFilters: [], savedAt: Date.now(),
		}];
		engine.persistence.clearFile = async () => undefined;
		assert.equal(await engine.restorePersistedSessions(), 0);
		assert.equal(connections, 1);
		assert.equal(engine.manager.get(guild.id)?.connection?.joinConfig.channelId, room.id);
		engine.manager.get(guild.id)!.connection = null;
	} finally {
		client.guilds.cache.delete("guild-247");
		await engine.shutdown();
		await client.destroy();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("a failed 24/7 disk write does not activate the in-memory setting", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zi-stay-write-failure-"));
	try {
		const file = path.join(dir, "voice-24-7.json");
		const store = new AlwaysOnVoiceStore(file);
		await store.ready();
		// Replacing a directory with the temp file must fail on all supported platforms.
		await fs.mkdir(file);
		await assert.rejects(store.set({ guildId: "g1", voiceChannelId: "v1", textChannelId: "t1" }));
		assert.equal(store.isEnabled("g1"), false);
		assert.equal((await fs.stat(file)).isDirectory(), true);
		assert.deepEqual(await fs.readdir(dir), ["voice-24-7.json"], "Temporary files should be cleaned up");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("24/7 storage does not collide with a custom playback-session filename", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zi-stay-path-collision-"));
	const sessionFile = path.join(dir, "voice-24-7.json");
	await fs.writeFile(sessionFile, "[]", "utf8");
	const { client, engine } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
		PERSISTENCE_FILE: sessionFile,
	});
	try {
		const { room, guild } = mockVoiceRoom();
		engine.ensureConnected = async (player, channel) => { player.connection = fakeReadyConnection(channel.id); };
		await engine.enableAlwaysOnVoice({ guildId: guild.id, voiceChannelId: room.id, textChannelId: "text-247" }, room);
		assert.equal(await fs.readFile(sessionFile, "utf8"), "[]");
		const rooms = JSON.parse(await fs.readFile(`${sessionFile}.rooms.json`, "utf8"));
		assert.equal(rooms[0].voiceChannelId, room.id);
		engine.manager.get(guild.id)!.connection = null;
	} finally {
		await engine.shutdown();
		await client.destroy();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("an unavailable Edge voice list does not reject during bot startup", async () => {
	const savedFetch = globalThis.fetch;
	const savedWarn = console.warn;
	let warnings = 0;
	globalThis.fetch = (async () => new Response("temporarily unavailable", { status: 503 })) as typeof fetch;
	console.warn = () => { warnings++; };
	const { client, engine } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
	});
	try {
		await assert.doesNotReject(engine.ttsPlugin.init());
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.ok(warnings >= 1, "The outage should be logged and handled");
	} finally {
		globalThis.fetch = savedFetch;
		console.warn = savedWarn;
		await engine.shutdown();
		await client.destroy();
	}
});

test("auto-reply is wired into the existing bot without overwriting the music session file", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zi-auto-reply-integrated-"));
	const sessionFile = path.join(dir, "auto-replies.json");
	await fs.writeFile(sessionFile, "[]", "utf8");
	const { client, engine, autoReplyActions, autoReplyStore } = createBotInstance({
		DISCORD_TOKEN: "dummy_token_for_unit_test",
		ENABLE_PERSISTENCE: "false",
		PERSISTENCE_FILE: sessionFile,
	});
	try {
		const managementReplies: ReplyPayload[] = [];
		const ctx: CommandContext = {
			guild: { id: "guild-1", ownerId: "owner-1" } as any,
			member: { permissions: { has: () => false } } as any,
			userId: "owner-1",
			textChannelId: "text-1",
			defer: async () => undefined,
			reply: async (payload) => { managementReplies.push(payload); },
		};
		await autoReplyActions.manage(ctx, "set", "xin chào", "Chào bạn!");
		assert.equal(await autoReplyStore.find("guild-1", "XIN CHÀO"), "Chào bạn!");
		const sent: any[] = [];
		const listener = client.listeners("messageCreate").at(-1) as (message: unknown) => Promise<void>;
		await listener({
			guildId: "guild-1", author: { id: "human-1", bot: false }, webhookId: null,
			content: "Xin Chào", reply: async (payload: unknown) => { sent.push(payload); },
		});
		assert.equal(sent[0]?.content, "Chào bạn!");
		assert.equal(await fs.readFile(sessionFile, "utf8"), "[]", "The playback file must not be overwritten");
		assert.equal(JSON.parse(await fs.readFile(`${sessionFile}.rules.json`, "utf8"))[0].trigger, "xin chào");
		assert.ok(managementReplies[0]?.content?.includes("Đã lưu"));
	} finally {
		await autoReplyStore.flush();
		await engine.shutdown();
		await client.destroy();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("voice runtime requirement matches the actual Discord voice dependency", () => {
	assert.equal(supportsVoiceRuntime("20.20.2"), false);
	assert.equal(supportsVoiceRuntime("22.11.9"), false);
	assert.equal(supportsVoiceRuntime("22.12.0"), true);
	assert.equal(supportsVoiceRuntime("24.0.0"), true);
	assert.equal(supportsVoiceRuntime("bad-version"), false);
});

test("playback checks Speak and server mute even when 24/7 already connected", async () => {
	const { client, engine, actions } = createBotInstance({ DISCORD_TOKEN: "dummy", ENABLE_PERSISTENCE: "false" });
	try {
		const settings = { speak: false };
		const voice = { channelId: "voice-permissions", serverMute: false, selfMute: false };
		const me = { voice };
		const guild = { id: "guild-permissions", members: { me } };
		const channel: any = {
			id: "voice-permissions", guild, guildId: guild.id, type: ChannelType.GuildVoice,
			permissionsFor: () => ({ has: (permission: bigint) => permission !== PermissionFlagsBits.Speak || settings.speak }),
		};
		const member: any = { guild, voice: { channel } };
		const existing: any = { destroyed: false, connection: { joinConfig: { channelId: channel.id } } };
		(engine.manager as any).get = () => existing;
		const replies: ReplyPayload[] = [];
		let deferred = 0;
		const ctx: CommandContext = {
			guild: guild as any, member, userId: "u", textChannelId: "text",
			defer: async () => { deferred++; }, reply: async (reply) => { replies.push(reply); },
		};
		assert.equal(validateMemberVoiceAccess(member, existing).ok, true, "Room access alone does not check Speak for an existing connection");
		assert.match(getVoicePlaybackIssue(member, channel) ?? "", /Speak/);
		await actions.play(ctx, "a song");
		assert.match(replies.at(-1)?.embeds?.[0].data.description ?? "", /Speak/);
		await actions.tts(ctx, "hello");
		assert.match(replies.at(-1)?.embeds?.[0].data.description ?? "", /Speak/);
		assert.equal(deferred, 0, "Known permission failures should be reported immediately");

		settings.speak = true;
		voice.serverMute = true;
		await actions.play(ctx, "a song");
		assert.match(replies.at(-1)?.embeds?.[0].data.description ?? "", /quản trị viên tắt tiếng/);
		voice.serverMute = false;
		voice.selfMute = true;
		assert.match(getVoicePlaybackIssue(member, channel) ?? "", /tự tắt mic/);
	} finally {
		await engine.shutdown();
		await client.destroy();
	}
});

test("stage playback reports when the bot cannot become a speaker", async () => {
	const { client, engine, actions } = createBotInstance({ DISCORD_TOKEN: "dummy", ENABLE_PERSISTENCE: "false" });
	try {
		const voice = { channelId: "stage-1", suppress: true, setSuppressed: async () => { throw new Error("not permitted"); } };
		const guild = { id: "guild-stage", members: { me: { voice } } };
		const channel: any = {
			id: "stage-1", guild, type: ChannelType.GuildStageVoice,
			permissionsFor: () => ({ has: () => true }),
		};
		let played = false;
		engine.getOrCreatePlayer = async () => ({ play: async () => { played = true; return true; } }) as any;
		engine.ensureConnected = async () => undefined;
		const replies: ReplyPayload[] = [];
		const ctx: CommandContext = {
			guild: guild as any, member: { guild, voice: { channel } } as any,
			userId: "u", textChannelId: "text", defer: async () => undefined,
			reply: async (reply) => { replies.push(reply); },
		};
		await actions.play(ctx, "a song");
		assert.equal(played, false);
		assert.match(replies.at(-1)?.embeds?.[0].data.description ?? "", /khán giả.*Stage/);
	} finally {
		await engine.shutdown();
		await client.destroy();
	}
});

test("ready voice repairs missing or stale music subscriptions without interrupting active TTS or mirrors", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zi-voice-sub-"));
	const { client, engine } = createBotInstance({
		DISCORD_TOKEN: "dummy", ENABLE_PERSISTENCE: "false", PERSISTENCE_FILE: path.join(dir, "sessions.json"), ENABLE_LYRICS: "false",
	});
	let player: any;
	let follower: any;
	let stalledTts: PassThrough | undefined;
	try {
		const { room, guild } = mockVoiceRoom("guild-sub", "voice-sub");
		player = await engine.getOrCreatePlayer({ guildId: guild.id, voiceChannelId: room.id, textChannelId: "text" });
		const connection = fakeReadyConnection(room.id);
		player.connection = connection;
		await engine.ensureConnected(player, room);
		assert.equal(connection.state.subscription.player, player.audioPlayer);
		const first = connection.state.subscription;
		await engine.ensureConnected(player, room);
		assert.equal(connection.state.subscription, first, "A healthy subscription must not be churned");
		assert.doesNotThrow(() => connection.emit("error", new Error("simulated voice network error")));

		const tts = player.runtimeGraph.ttsController.player;
		stalledTts = new PassThrough();
		tts.play(createAudioResource(stalledTts, { inputType: StreamType.Raw }) as any);
		assert.equal(tts.state.status, AudioPlayerStatus.Buffering);
		connection.subscribe(tts);
		await engine.ensureConnected(player, room);
		assert.equal(connection.state.subscription.player, tts, "An active TTS interruption must not be stolen");

		tts.stop(true);
		await engine.ensureConnected(player, room);
		assert.equal(connection.state.subscription.player, player.audioPlayer, "An idle stale TTS subscription must be repaired");

		follower = await engine.getOrCreatePlayer({ guildId: "guild-leader", voiceChannelId: "voice-leader", textChannelId: "text" });
		connection.subscribe(follower.audioPlayer);
		player.runtimeGraph.forwardController.mode = "forward";
		const mirrorSub = connection.state.subscription;
		await engine.ensureConnected(player, room);
		assert.equal(connection.state.subscription, mirrorSub, "Mirror mode must keep the leader player");
		player.runtimeGraph.forwardController.mode = "native";
		await engine.ensureConnected(player, room);
		assert.equal(connection.state.subscription.player, player.audioPlayer);
		connection.state.subscription.unsubscribe();
		connection.subscribe = () => undefined;
		await assert.rejects(engine.ensureConnected(player, room), /Không thể nối trình phát nhạc/);
	} finally {
		stalledTts?.destroy();
		if (player) player.connection = null;
		if (follower) follower.connection = null;
		await engine.shutdown();
		await client.destroy();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("a connecting voice session is awaited before music can use it", async () => {
	const { client, engine } = createBotInstance({ DISCORD_TOKEN: "dummy", ENABLE_PERSISTENCE: "false", ENABLE_LYRICS: "false" });
	let player: any;
	try {
		const { room, guild } = mockVoiceRoom("guild-wait", "voice-wait");
		player = await engine.getOrCreatePlayer({ guildId: guild.id, voiceChannelId: room.id, textChannelId: "text" });
		const connection = fakeReadyConnection(room.id);
		connection.state = { status: VoiceConnectionStatus.Connecting };
		player.connection = connection;
		let completed = false;
		const pending = engine.ensureConnected(player, room).then(() => { completed = true; });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(completed, false);
		connection.state = { status: VoiceConnectionStatus.Ready };
		connection.emit(VoiceConnectionStatus.Ready);
		await pending;
		assert.equal(connection.state.subscription.player, player.audioPlayer);
	} finally {
		if (player) player.connection = null;
		await engine.shutdown();
		await client.destroy();
	}
});

test("audio-delivery status does not confuse a loaded resource with packets being sent", async () => {
	const audio: any = { state: { status: AudioPlayerStatus.Playing, playbackDuration: 20, resource: { playbackDuration: 0 } } };
	const tts: any = { state: { status: AudioPlayerStatus.Idle } };
	const connection: any = { state: { status: VoiceConnectionStatus.Ready, subscription: { player: audio } } };
	const player: any = {
		destroyed: false, playbackMode: "native", currentTrack: sampleTrack(1), volume: 80,
		audioPlayer: audio, connection, runtimeGraph: { ttsController: { player: tts } },
	};
	assert.equal(await waitForAudioDelivery(player, 0), "buffering", "Silence padding alone is not proof of source packet progress");
	audio.state.resource.playbackDuration = 20;
	assert.equal(await waitForAudioDelivery(player, 0), "delivering");
	player.volume = 0;
	assert.equal(await waitForAudioDelivery(player, 0), "muted");
	player.volume = 80;
	connection.state.subscription = undefined;
	assert.equal(await waitForAudioDelivery(player, 0), "no-subscription");
	connection.state.subscription = { player: tts };
	tts.state.status = AudioPlayerStatus.Playing;
	assert.equal(await waitForAudioDelivery(player, 0), "tts");
	tts.state.status = AudioPlayerStatus.Idle;
	assert.equal(await waitForAudioDelivery(player, 0), "no-subscription");
	connection.state.subscription = { player: audio };
	audio.state = { status: AudioPlayerStatus.AutoPaused };
	assert.equal(await waitForAudioDelivery(player, 0), "paused");
	connection.state = { status: VoiceConnectionStatus.Connecting };
	assert.equal(await waitForAudioDelivery(player, 0), "disconnected");
	player.playbackMode = "forward";
	assert.equal(await waitForAudioDelivery(player, 0), "external");
});

test("local WAV produces non-silent Opus packets and releases FFmpeg on stop", { skip: process.platform === "win32" }, async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zi-real-audio-"));
	const wavPath = path.join(dir, "tone.wav");
	const pidPath = path.join(dir, "ffmpeg.pid");
	const wrapper = path.join(dir, "ffmpeg-wrapper");
	await fs.writeFile(wavPath, createSampleWavBuffer(3_000, 48_000));
	const { client, engine } = createBotInstance({
		DISCORD_TOKEN: "dummy", ENABLE_PERSISTENCE: "false", PERSISTENCE_FILE: path.join(dir, "sessions.json"),
		ENABLE_LYRICS: "false", LOW_PERFORMANCE: "true",
	});
	let player: any;
	let decoderPid: number | undefined;
	const decoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
	try {
		assert.ok(engine.config.ffmpegPath);
		await fs.writeFile(wrapper, `#!/bin/sh\nprintf '%s' "$$" > ${JSON.stringify(pidPath)}\nexec ${JSON.stringify(engine.config.ffmpegPath)} "$@"\n`, { mode: 0o755 });
		const { room, guild } = mockVoiceRoom("guild-audio", "voice-audio");
		player = await engine.getOrCreatePlayer({ guildId: guild.id, voiceChannelId: room.id, textChannelId: "text" });
		installManagedAudioResources(player, wrapper);
		// Related searches are irrelevant to the audio pipeline and must not use the network in this test.
		player.pluginManager.getRelatedTracks = async () => [];
		const connection = fakeReadyConnection(room.id);
		player.connection = connection;
		await engine.ensureConnected(player, room);
		const track: Track = {
			id: "local-tone", title: "440Hz test tone", url: wavPath, duration: 3_000,
			requestedBy: "test", source: "attachments", metadata: { extension: "wav" },
		};
		assert.equal(await player.play(track, "test"), true);
		assert.equal(await waitForAudioDelivery(player, 4_000), "delivering");
		const deadline = Date.now() + 2_000;
		while (connection.packets.length < 12 && Date.now() < deadline) {
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
		const packets: Buffer[] = connection.packets.filter((packet: Buffer) => packet.length > 3);
		assert.ok(packets.length >= 5, `Expected non-silent Opus packets; received ${packets.length}`);
		let power = 0;
		let samples = 0;
		for (const packet of packets.slice(0, 12)) {
			const pcm = decoder.decode(packet);
			for (let i = 0; i < pcm.length; i += 2) {
				const value = pcm.readInt16LE(i);
				power += value * value;
				samples++;
			}
		}
		assert.ok(samples > 0 && Math.sqrt(power / samples) > 50, "Decoded PCM must contain real, non-silent audio");
		decoderPid = Number(await fs.readFile(pidPath, "utf8"));
		assert.ok(decoderPid > 0);
		await player.action({ type: "STOP" });
		let stillRunning = true;
		const exitDeadline = Date.now() + 2_000;
		while (stillRunning && Date.now() < exitDeadline) {
			try { process.kill(decoderPid, 0); } catch { stillRunning = false; }
			if (stillRunning) await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
		assert.equal(stillRunning, false, "Stopping must release the FFmpeg child process");
		decoderPid = undefined;
	} finally {
		decoder.delete();
		if (decoderPid) { try { process.kill(decoderPid, "SIGKILL"); } catch { /* already stopped */ } }
		if (player) {
			await player.action({ type: "STOP" });
			player.connection?.state.subscription?.unsubscribe();
			player.connection = null;
		}
		await engine.shutdown();
		await client.destroy();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("play command distinguishes actual packet progress from zero volume and failed sources", async () => {
	const { client, engine, actions } = createBotInstance({ DISCORD_TOKEN: "dummy", ENABLE_PERSISTENCE: "false" });
	try {
		const audio = { state: { status: AudioPlayerStatus.Playing, playbackDuration: 20, resource: { playbackDuration: 20 } } };
		const tts = { state: { status: AudioPlayerStatus.Idle } };
		const fakePlayer: any = {
			guildId: "guild-action", currentTrack: sampleTrack(1), isPlaying: false, isPaused: false, isBuffering: false,
			queueSize: 0, volume: 80, destroyed: false, playbackMode: "native", audioPlayer: audio,
			runtimeGraph: { ttsController: { player: tts } },
			connection: { joinConfig: { channelId: "voice-action" }, state: { status: VoiceConnectionStatus.Ready, subscription: { player: audio } } },
			play: async () => true,
		};
		engine.getOrCreatePlayer = async () => fakePlayer;
		engine.ensureConnected = async () => undefined;
		const member = { guild: { members: { me: null } }, voice: { channel: { id: "voice-action" } } };
		const replies: ReplyPayload[] = [];
		const ctx: CommandContext = {
			guild: { id: "guild-action" } as any, member: member as any, userId: "u", textChannelId: "t",
			defer: async () => undefined, reply: async (reply) => { replies.push(reply); },
		};
		await actions.play(ctx, "song");
		assert.match(replies.at(-1)?.embeds?.[0].data.description ?? "", /Đang gửi âm thanh/);
		fakePlayer.volume = 0;
		await actions.play(ctx, "song");
		assert.match(replies.at(-1)?.embeds?.[0].data.description ?? "", /âm lượng đang là 0/);
		fakePlayer.play = async () => false;
		await actions.play(ctx, "song");
		assert.match(replies.at(-1)?.embeds?.[0].data.description ?? "", /không tải được nguồn âm thanh/);
	} finally {
		await engine.shutdown();
		await client.destroy();
	}
});
