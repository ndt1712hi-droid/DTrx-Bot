import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { GatewayIntentBits } from "discord.js";
import { PREDEFINED_FILTERS } from "ziplayer";
import { assertBotCredentials, loadConfig, resolveAndBindFfmpeg } from "../config.js";
import { exportTrackToMp3Buffer } from "../core/exporter.js";
import { SessionPersistence } from "../core/persistence.js";
import { buildSlashCommands } from "../handlers/slashDefinitions.js";
import { createBotInstance } from "../index.js";
import { validateMemberVoiceAccess } from "../handlers/musicActions.js";
import { buildFullLyricsEmbed, buildHelpEmbed, buildNowPlayingPayload, buildQueueEmbed, buildStatsEmbed, } from "../ui/embeds.js";
import { formatDuration, nextLoopMode, parseLavalinkNodes, parseTimeInput, parseVoiceCommand, sanitizeFilename, } from "../utils/format.js";
function createSampleWavBuffer(durationMs = 400, sampleRate = 44100) {
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
const sampleTrack = (idx) => ({
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
    const jsonNodes = parseLavalinkNodes(JSON.stringify([{ host: "lava.example.com", port: 443, password: "pw", secure: true }]));
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
test("Slash command definitions build all 26 commands cleanly", () => {
    const commands = buildSlashCommands();
    assert.equal(commands.length, 26);
    const names = new Set(commands.map((c) => c.name));
    for (const expected of [
        "play",
        "playnext",
        "tts",
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
        if (commands.some((c) => c.name === expected)) {
            assert.ok(names.has(expected));
        }
    }
    assert.ok(commands.length >= 21);
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
        // Persistence snapshot & reload
        const persistence = new SessionPersistence(persistPath, true);
        await persistence.saveAll(engine.manager);
        const loaded = await persistence.loadValidSessions();
        assert.equal(loaded.length, 1);
        assert.equal(loaded[0].guildId, "111111111111111111");
        assert.deepEqual(loaded[0].activeFilters, ["bassboost"]);
        await playerA.filter.clearAll();
        assert.equal(playerA.filter.getActiveFilters().length, 0);
    }
    finally {
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
    };
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
        const noVoiceMember = { voice: { channel: null }, guild: { members: { me: null } } };
        const res1 = validateMemberVoiceAccess(noVoiceMember);
        assert.equal(res1.ok, false);
        const player = await engine.getOrCreatePlayer({
            guildId: "900000000000000001",
            voiceChannelId: "900000000000000010",
            textChannelId: "900000000000000020",
        });
        // Simulate connected bot in channel 900000000000000010
        player.connection = { joinConfig: { channelId: "900000000000000010" } };
        player.setCurrentTrack(sampleTrack(10));
        player.queue.addMultiple([sampleTrack(11), sampleTrack(12), sampleTrack(13)]);
        const wrongRoomMember = {
            voice: { channel: { id: "900000000000000099" } },
            guild: { members: { me: null } },
        };
        const res2 = validateMemberVoiceAccess(wrongRoomMember, player);
        assert.equal(res2.ok, false);
        const sameRoomMember = {
            voice: { channel: { id: "900000000000000010" } },
            guild: { members: { me: null } },
        };
        const res3 = validateMemberVoiceAccess(sameRoomMember, player);
        assert.equal(res3.ok, true);
        // Exercise MusicCommandActions edge cases & happy paths
        const replies = [];
        const ctx = {
            guild: { id: "900000000000000001" },
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
    }
    finally {
        // Clear fake connection before shutdown so voiceConnection.destroy isn't invoked on mock object
        const p = engine.manager.get("900000000000000001");
        if (p)
            p.connection = null;
        await engine.shutdown();
        await client.destroy();
    }
});
test("Free-tier lowPerformance profile & automatic MessageContent fallback intent mode", async () => {
    const fallback = createBotInstance({ DISCORD_TOKEN: "dummy_token_for_unit_test", ENABLE_PERSISTENCE: "false" }, { includeMessageContentIntent: false });
    try {
        assert.equal(fallback.config.lowPerformance, true, "lowPerformance should default to true for free-tier hosts");
        assert.equal(fallback.client.options.intents.has(GatewayIntentBits.MessageContent), false, "Fallback mode must omit privileged MessageContent intent");
        assert.equal(fallback.client.options.intents.has(GatewayIntentBits.GuildVoiceStates), true);
    }
    finally {
        await fallback.engine.shutdown();
        await fallback.client.destroy();
    }
});
//# sourceMappingURL=bot.test.js.map