import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { AudioPlayerStatus, VoiceConnectionStatus } from "@discordjs/voice";
import { MessageFlags } from "discord.js";
import { ResilientYouTubePlugin } from "../core/resilientYouTubePlugin.js";
import { getPlaybackFallback, installStreamProvenance, tracePluginStreams } from "../core/streamProvenance.js";
import { AutocompleteValueStore } from "../handlers/autocompleteValues.js";
import { registerInteractionHandler } from "../handlers/interactionHandler.js";
import { MusicCommandActions } from "../handlers/musicActions.js";
import { buildNowPlayingPayload, buildQueueEmbed } from "../ui/embeds.js";
import { isDirectMusicQuery, normalizeMusicQuery } from "../utils/musicQuery.js";
const scope = { userId: "user-1", guildId: "guild-1", commandName: "play" };
const id = "dQw4w9WgXcQ";
const longPlaylist = `https://www.youtube.com/watch?v=${id}&list=PLAbCdEfGhIjKlMnOpQrSt&index=2&si=${"x".repeat(100)}`;
const longSigned = `https://cdn.example.test/music/song.mp3?Expires=123&Signature=${"AbC%2Fde".repeat(20)}&Key-Pair-Id=ABC`;
test("autocomplete values preserve long inputs, enforce scope, expire and remain bounded", () => {
    let time = 10_000;
    const store = new AutocompleteValueStore(100, 2, () => time);
    const token = store.encode(longSigned, scope);
    assert.ok(token.length <= 100);
    assert.notEqual(token, longSigned.slice(0, 100));
    assert.equal(store.resolve(token, scope), longSigned);
    assert.equal(store.resolve(token, { ...scope, userId: "other" }), null);
    assert.equal(store.resolve(token, { ...scope, guildId: "other" }), null);
    assert.equal(store.resolve(token, { ...scope, commandName: "playnext" }), null);
    assert.equal(store.resolve("song name", scope), "song name");
    const second = store.encode(`${longSigned}2`, scope);
    const third = store.encode(`${longSigned}3`, scope);
    assert.equal(store.resolve(token, scope), null, "Oldest value is evicted when the cache is full");
    assert.equal(store.resolve(second, scope), `${longSigned}2`);
    assert.equal(store.resolve(third, scope), `${longSigned}3`);
    time += 100;
    assert.equal(store.resolve(second, scope), null, "Expired tokens cannot become partial URLs");
    assert.equal(store.resolve("dtrx-ac-" + "0".repeat(32), scope), null, "Unknown tokens fail explicitly");
});
test("music query normalization handles shared links without damaging signed URLs or playlists", () => {
    assert.equal(normalizeMusicQuery(longSigned), longSigned);
    assert.equal(normalizeMusicQuery(`<${longSigned}>`), longSigned);
    assert.equal(normalizeMusicQuery(longPlaylist), longPlaylist);
    assert.equal(normalizeMusicQuery(`m.youtube.com/watch?v=${id}&list=PL123`), `https://m.youtube.com/watch?v=${id}&list=PL123`);
    assert.equal(normalizeMusicQuery(`<youtu.be/${id}>`), `https://youtu.be/${id}`);
    assert.equal(normalizeMusicQuery(`https://www.youtu.be/${id}?list=PL123&si=AbC`), `https://youtu.be/${id}?list=PL123&si=AbC`);
    assert.equal(normalizeMusicQuery(`https://youtube.com/live/${id}?list=PL123&index=2#t=30`), `https://www.youtube.com/watch?v=${id}&list=PL123&index=2#t=30`);
    assert.equal(normalizeMusicQuery(`https://www.youtube-nocookie.com/embed/${id}?start=30`), `https://www.youtube.com/embed/${id}?start=30`);
    assert.equal(normalizeMusicQuery(`open.spotify.com/track/abc?si=CaseSensitive`), `https://open.spotify.com/track/abc?si=CaseSensitive`);
    assert.equal(normalizeMusicQuery("  tên bài hát / karaoke  "), "tên bài hát / karaoke");
    assert.equal(normalizeMusicQuery("tts: Xin chào"), "tts: Xin chào");
    assert.equal(isDirectMusicQuery(`<https://youtu.be/${id}>`), true);
    assert.equal(isDirectMusicQuery(`www.youtube.com/watch?v=${id}`), true);
    assert.equal(isDirectMusicQuery("spotify:track:abc"), true);
    assert.equal(isDirectMusicQuery("tên bài hát"), false);
});
test("YouTube metadata recovers the exact video and Mix feed after an empty basic_info", async () => {
    let includeExact = true;
    const feedId = "abcdefghijk";
    const client = {
        getInfo: async () => ({
            basic_info: {}, playability_status: { status: "LOGIN_REQUIRED" },
            watch_next_feed: [{ content_type: "VIDEO", content_id: feedId, metadata: { title: { text: "Feed song" } }, duration: 90 }],
        }),
        getPlaylist: async () => { throw new Error("A Mix is not a normal playlist"); },
        search: async () => ({ items: [
                { id: "other123456", title: "Unrelated result", duration: 30 },
                ...(includeExact ? [{ id, title: "Exact video", duration: 120 }] : []),
            ] }),
    };
    const youtube = new ResilientYouTubePlugin({ client: client });
    const single = await youtube.search(`https://youtu.be/${id}`, "user-1");
    assert.deepEqual(single.tracks.map((track) => [track.id, track.title]), [[id, "Exact video"]]);
    const mix = await youtube.search(`https://www.youtube.com/watch?v=${id}&list=RD${id}`, "user-1");
    assert.equal(mix.playlist?.name, "YouTube Mix");
    assert.deepEqual(mix.tracks.map((track) => [track.id, track.title]), [[id, "Exact video"], [feedId, "Feed song"]]);
    assert.ok(mix.tracks.every((track) => track.url?.includes(track.id)));
    includeExact = false;
    const missing = await youtube.search(`https://youtu.be/${id}`, "user-1");
    assert.deepEqual(missing.tracks, [], "Never substitute a different video when the exact ID cannot be found");
    const missingMix = await youtube.search(`https://www.youtube.com/watch?v=${id}&list=RD${id}`, "user-1");
    assert.deepEqual(missingMix.tracks, [], "A Mix must not silently skip its unresolvable anchor video");
});
test("a chosen fallback is disclosed without leaking source state to other players", async () => {
    const requested = { id, title: "Requested original", source: "youtube", url: `https://youtu.be/${id}`, duration: 1000, requestedBy: "user-1" };
    const alternate = { id: "soundcloud-1", title: "Alternate version", source: "soundcloud", url: "https://soundcloud.com/artist/song", duration: 1000, requestedBy: "user-1" };
    const plugin = tracePluginStreams({
        name: "soundcloud",
        getStream: async () => ({ type: "arbitrary", stream: Readable.from(["audio"]), metadata: { author: "artist" } }),
    });
    const stream = await plugin.getStream(alternate);
    const audio = { state: { status: AudioPlayerStatus.Playing, resource: { playbackDuration: 20 } } };
    const player = {
        guildId: "guild-1", destroyed: false, currentTrack: requested, queueSize: 0, volume: 80, playbackMode: "native",
        isPlaying: false, isPaused: false, isBuffering: false, userdata: {}, audioPlayer: audio, upcomingTracks: [], previousTracks: [],
        connection: { joinConfig: { channelId: "voice-1" }, state: { status: VoiceConnectionStatus.Ready, subscription: { player: audio } } },
        runtimeGraph: { ttsController: { player: {} } }, filter: { getActiveFilters: () => [] },
        queue: { nextTrack: null, lastTrack: null, getLoopMode: () => "off" }, autoPlay: () => false,
        getProgressBar: () => "progress", pluginManager: { getStream: async () => stream }, play: async () => true,
    };
    installStreamProvenance(player);
    await player.pluginManager.getStream(requested);
    assert.deepEqual(getPlaybackFallback(player, requested), { source: "soundcloud", id: "soundcloud-1", title: "Alternate version" });
    const otherPlayer = { pluginManager: { getStream: async () => null } };
    installStreamProvenance(otherPlayer);
    assert.equal(getPlaybackFallback(otherPlayer, requested), undefined, "Playback provenance is per guild player");
    const member = { guild: { members: { me: null } }, voice: { channel: { id: "voice-1" } } };
    const replies = [];
    const actions = new MusicCommandActions({ manager: { get: () => player }, getOrCreatePlayer: async () => player, ensureConnected: async () => undefined });
    await actions.play({ guild: { id: "guild-1" }, member, userId: "user-1", textChannelId: "t", defer: async () => undefined, reply: async (value) => { replies.push(value); } }, requested.url);
    assert.match(replies.at(-1)?.embeds?.[0].data.description ?? "", /Alternate version/);
    assert.match(replies.at(-1)?.embeds?.[0].data.description ?? "", /bản dự phòng.*SoundCloud/);
    assert.match(buildNowPlayingPayload(player).embeds[0].data.description ?? "", /bản dự phòng|Bản dự phòng/);
    assert.match(buildQueueEmbed(player).data.description ?? "", /Alternate version/);
    const direct = await plugin.getStream({ ...alternate });
    const manager = { getStream: async () => direct };
    const directPlayer = { pluginManager: manager };
    installStreamProvenance(directPlayer);
    await manager.getStream(alternate);
    assert.equal(getPlaybackFallback(directPlayer, alternate), undefined, "Playing the requested source is not labeled as fallback");
    stream.stream.destroy();
    direct.stream.destroy();
});
/** Exercise the real interaction handler, command actions and the installed
 * YouTube plugin together; only Discord voice and YouTube network calls are fake. */
test("autocomplete → slash /play and /playnext preserve URLs, playlists, TTS and name search", async () => {
    const youtubeCalls = [];
    const youtubeClient = {
        getInfo: async (videoId) => {
            youtubeCalls.push(`video:${videoId}`);
            return { basic_info: { id: videoId, title: "Video test", duration: 120 } };
        },
        getPlaylist: async (listId) => {
            youtubeCalls.push(`list:${listId}`);
            return { title: "Playlist test", videos: [{ id, title: "One", duration: 120 }, { id: "abcdefghijk", title: "Two", duration: 90 }] };
        },
        search: async () => { throw new Error("A direct YouTube URL must not fall back to free-text search"); },
    };
    const youtube = new ResilientYouTubePlugin({ client: youtubeClient });
    const client = new EventEmitter();
    const seen = [];
    const queue = { lastTrack: { title: "last", duration: 120 }, nextTrack: { title: "next" } };
    const audio = { state: { status: AudioPlayerStatus.Playing } };
    const player = {
        guildId: "guild-1", destroyed: false, currentTrack: { title: "already playing" },
        isPlaying: true, isPaused: false, isBuffering: false, queueSize: 0, volume: 80,
        audioPlayer: audio, queue,
        runtimeGraph: { ttsController: { player: {} } },
        connection: { joinConfig: { channelId: "voice-1" }, state: { status: VoiceConnectionStatus.Ready, subscription: { player: audio } } },
        async play(query, userId) {
            seen.push({ command: "play", query });
            if (/youtu(?:be\.com|\.be)/.test(query)) {
                const result = await youtube.search(query, userId);
                if (!result.tracks.length)
                    return false;
                this.queueSize += result.tracks.length;
            }
            else
                this.queueSize++;
            return true;
        },
        async insert(query, _position, userId) {
            seen.push({ command: "playnext", query });
            if (/youtu(?:be\.com|\.be)/.test(query)) {
                const result = await youtube.search(query, userId);
                return result.tracks.length > 0;
            }
            return true;
        },
    };
    const searchQueries = [];
    const engine = {
        client,
        manager: {
            get: () => player,
            search: async (query) => {
                searchQueries.push(query);
                if (query.startsWith("no result"))
                    return { tracks: [] };
                if (query === "long result")
                    return { tracks: [{ title: "Signed file", url: longSigned, duration: 120_000 }] };
                return { tracks: [{ title: "Known song", url: `https://youtu.be/${id}`, duration: 120_000 }] };
            },
        },
        getOrCreatePlayer: async () => player,
        ensureConnected: async () => undefined,
        scheduleControllerRefresh: () => undefined,
    };
    const actions = new MusicCommandActions(engine);
    registerInteractionHandler(engine, actions, {});
    const listener = client.listeners("interactionCreate")[0];
    const room = { id: "voice-1" };
    const guild = { id: "guild-1", members: { me: null, cache: new Map() } };
    guild.members.cache.set("user-1", { id: "user-1", guild, voice: { channel: room } });
    guild.members.cache.set("user-2", { id: "user-2", guild, voice: { channel: room } });
    async function suggest(commandName, value, userId = "user-1") {
        let choices;
        await listener({
            commandName, guildId: guild.id, user: { id: userId }, isAutocomplete: () => true,
            options: { getFocused: () => ({ name: "query", value }) },
            respond: async (result) => { choices = result; },
        });
        assert.ok(choices && choices.length > 0, "Autocomplete must respond with at least one choice");
        assert.ok(choices.every((choice) => choice.value.length <= 100 && choice.name.length <= 100));
        return choices[0].value;
    }
    async function run(commandName, query, userId = "user-1", attachmentUrl) {
        const calls = [];
        const interaction = {
            commandName, guildId: guild.id, guild, user: { id: userId }, channelId: "text-1", calls,
            deferred: false, replied: false, ephemeral: null,
            isAutocomplete: () => false, isButton: () => false, isStringSelectMenu: () => false,
            isChatInputCommand: () => true, isRepliable: () => true, inGuild: () => true,
            options: { getString: () => query, getAttachment: () => attachmentUrl ? { url: attachmentUrl } : null },
            async deferReply() { this.deferred = true; this.ephemeral = false; calls.push({ method: "defer" }); },
            async editReply(payload) { this.replied = true; calls.push({ method: "edit", payload }); },
            async followUp(payload) { this.replied = true; calls.push({ method: "followUp", payload }); },
            async deleteReply() { calls.push({ method: "delete" }); },
            async reply(payload) { this.replied = true; calls.push({ method: "reply", payload }); },
        };
        await listener(interaction);
        return calls;
    }
    const playlistChoice = await suggest("play", longPlaylist);
    assert.notEqual(playlistChoice, longPlaylist);
    await run("play", playlistChoice);
    assert.deepEqual(seen.at(-1), { command: "play", query: longPlaylist });
    assert.ok(youtubeCalls.includes("list:PLAbCdEfGhIjKlMnOpQrSt"));
    assert.equal(player.queueSize, 2, "The complete playlist must reach the playback action");
    const signedChoice = await suggest("playnext", longSigned);
    await run("playnext", signedChoice);
    assert.deepEqual(seen.at(-1), { command: "playnext", query: longSigned });
    await run("play", longSigned); // Discord also allows the user to submit raw text without choosing a suggestion.
    assert.deepEqual(seen.at(-1), { command: "play", query: longSigned });
    for (const input of [`https://youtu.be/${id}`, `m.youtube.com/watch?v=${id}`, `<https://youtu.be/${id}>`, `https://www.youtu.be/${id}`, `https://youtube.com/live/${id}`]) {
        await run("playnext", await suggest("playnext", input));
        assert.equal(seen.at(-1)?.query, normalizeMusicQuery(input));
        assert.equal(youtubeCalls.at(-1), `video:${id}`);
    }
    const nameChoice = await suggest("play", "known song");
    assert.equal(nameChoice, `https://youtu.be/${id}`);
    await run("play", nameChoice);
    assert.equal(seen.at(-1)?.query, `https://youtu.be/${id}`);
    assert.deepEqual(searchQueries, ["known song"], "Direct links do not trigger text autocomplete searches");
    await run("play", await suggest("play", "long result"));
    assert.equal(seen.at(-1)?.query, longSigned, "A long search-result URL stays intact as well");
    const longText = `no result ${"a".repeat(140)}`;
    await run("play", await suggest("play", longText));
    assert.equal(seen.at(-1)?.query, longText, "Long text-search fallbacks are not silently truncated");
    const longTts = `tts: ${"xin chào ".repeat(20)}`;
    await run("play", await suggest("play", longTts));
    assert.equal(seen.at(-1)?.query, longTts.trim());
    const beforeRejected = seen.length;
    const foreignCalls = await run("play", playlistChoice, "user-2");
    assert.equal(seen.length, beforeRejected, "Another user's token must not be played");
    const privateError = foreignCalls.find((call) => call.method === "followUp");
    assert.equal(privateError?.payload.flags, MessageFlags.Ephemeral);
    assert.match(privateError?.payload.content ?? "", /hết hạn/);
    await run("play", "dtrx-ac-" + "0".repeat(32), "user-1", longSigned);
    assert.equal(seen.at(-1)?.query, longSigned, "An attachment continues to override an irrelevant query");
});
//# sourceMappingURL=musicLinks.test.js.map