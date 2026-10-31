import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import SoundCloud from "@zibot/scdl";
import { PluginManager, type StreamInfo, type Track } from "ziplayer";
import { SpotifyPlugin } from "@ziplayer/plugin";
import { ResilientYouTubePlugin } from "../core/resilientYouTubePlugin.js";
import { ResilientSoundCloudPlugin } from "../core/resilientSoundCloudPlugin.js";
import { resolveSimilarMusic, scoreSimilarMusic, similarSearchQueries } from "../core/similarMusicFallback.js";
import { getPlaybackFallback, installStreamProvenance, tracePluginStreams } from "../core/streamProvenance.js";
import { mockBackgroundMediaInitialization } from "./offlineMedia.js";

const restore = mockBackgroundMediaInitialization();
test.after(restore);

function track(fields: Partial<Track> = {}): Track {
	return {
		id: "uhr_FBH4s2Q", title: "ĐẠT G x CHU THÚY QUỲNH – NGƯỢC LỐI YÊU | Màn Song Ca Live Quá Cảm Xúc, Nghe Là Cuốn!",
		url: "https://www.youtube.com/watch?v=uhr_FBH4s2Q", duration: 340_000, source: "youtube", requestedBy: "user-1", ...fields,
	};
}
function soundcloud(id: string, title: string, fields: Partial<Track> = {}): Track {
	return track({ id, title, source: "soundcloud", url: `https://soundcloud.com/artist/${id}`, ...fields });
}
function audio(value: string): StreamInfo {
	return { type: "arbitrary", stream: Readable.from([Buffer.from(value)]) };
}
async function readAll(stream: Readable): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString();
}

test("fallback searches remove promotional suffixes while retaining Vietnamese song and performer words", () => {
	const queries = similarSearchQueries(track().title);
	assert.equal(queries.length, 3);
	assert.match(queries[0], /Màn Song Ca/);
	assert.equal(queries[1], "ĐẠT G x CHU THÚY QUỲNH – NGƯỢC LỐI YÊU");
	assert.equal(queries[2], "ĐẠT G CHU THÚY QUỲNH NGƯỢC LỐI YÊU");
	assert.deepEqual(similarSearchQueries("Shape of You", "Ed Sheeran"), ["Shape of You Ed Sheeran", "Shape of You"]);
});

test("matching is accent-insensitive, rejects other songs and previews, and ranks the matching performer first", () => {
	const requested = track();
	const sharedPerformer = soundcloud("one", "Nguoc Loi Yeu - Chu Thuy Quynh & Vicky Nhung");
	const otherPerformer = soundcloud("two", "NGUOC LOI YEU - A different singer");
	const unrelated = soundcloud("three", "HOT TREND LU NIEN x KHONG MON DANG HO DOI REMIX");
	const sameArtistDifferentSong = soundcloud("four", "DAT G x CHU THUY QUYNH - Mot Bai Hat Khac");
	assert.ok(scoreSimilarMusic(requested, sharedPerformer) > scoreSimilarMusic(requested, otherPerformer));
	assert.ok(scoreSimilarMusic(requested, otherPerformer) > 0, "A different performer is allowed for the same clearly identified song");
	assert.equal(scoreSimilarMusic(requested, unrelated), 0);
	assert.equal(scoreSimilarMusic(requested, sameArtistDifferentSong), 0);
	assert.equal(scoreSimilarMusic(requested, { ...sharedPerformer, duration: 30_000 }), 0, "Reject a short preview");
	assert.ok(scoreSimilarMusic({ ...requested, duration: 9_732_000 }, { ...sharedPerformer, duration: 318_046 }) > 0,
		"A concert may be much longer than an alternate recording of the song named in its title");
	assert.equal(scoreSimilarMusic(track({ title: "Artist - Night Song" }), soundcloud("x", "Artist - A Different Day")), 0);
	assert.equal(scoreSimilarMusic(track({ title: "Song - Artist" }), soundcloud("y", "Different Song - Artist")), 0);
	assert.equal(scoreSimilarMusic(track({ title: "Singer | Night Rain" }), soundcloud("z", "Singer - Different Day")), 0,
		"A pipe between artist and song must not be mistaken for a promotional suffix");
	assert.ok(scoreSimilarMusic(track({ title: "Singer | Night Rain" }), soundcloud("z2", "Singer - Night Rain")) > 0);
	const shortTitle = track({ title: "Perfect", source: "spotify", metadata: { artist: "Ed Sheeran" } });
	assert.equal(scoreSimilarMusic(shortTitle, soundcloud("unrelated", "Different Perfect - Ed Sheeran")), 0);
	assert.ok(scoreSimilarMusic(shortTitle, soundcloud("right", "Perfect - Ed Sheeran")) > 0);
	assert.ok(scoreSimilarMusic(track({ title: "夜曲" }), soundcloud("zh", "夜曲")) > 0, "Do not strip non-Latin titles");

	const spotify = track({ source: "spotify", title: "Shape of You", metadata: { artist: "Ed Sheeran" } });
	const rightArtist = soundcloud("ed", "Shape of You", { metadata: { author: "Ed Sheeran" } });
	const wrongArtist = soundcloud("cover", "Shape of You", { metadata: { author: "Someone Else" } });
	assert.ok(scoreSimilarMusic(spotify, rightArtist) > scoreSimilarMusic(spotify, wrongArtist));
	const youtube = track({ title: "Perfect", metadata: { author: "Ed Sheeran" } });
	assert.ok(scoreSimilarMusic(youtube, soundcloud("a", "Perfect - Ed Sheeran")) >
		scoreSimilarMusic(youtube, soundcloud("b", "Perfect - Other Artist")), "YouTube channel names are a preference, not a requirement");
});

test("several ranked candidates are tried, unrelated songs are ignored, and first audio bytes are not consumed", async () => {
	const requested = track();
	const best = soundcloud("best", "ĐẠT G x CHU THÚY QUỲNH – NGƯỢC LỐI YÊU");
	const alternative = soundcloud("alt", "NGƯỢC LỐI YÊU - CHU THÚY QUỲNH & VICKY NHUNG");
	const bad = soundcloud("bad", "A different unrelated song");
	const opened: string[] = [], queries: string[] = [];
	const info = await resolveSimilarMusic({
		requested, source: "soundcloud",
		search: async (query) => { queries.push(query); return { tracks: [bad, alternative, best] }; },
		open: async (candidate) => {
			opened.push(candidate.id);
			if (candidate.id === "best") throw new Error("source unavailable");
			return { type: "arbitrary", stream: Readable.from(["audio-first", "audio-second"]), metadata: { author: "real artist" } };
		},
	});
	assert.deepEqual(opened, ["best", "alt"]);
	assert.equal(queries.length, 3);
	assert.equal(info.metadata?.title, alternative.title);
	assert.equal(info.metadata?.originalTitle, requested.title);
	assert.equal(info.metadata?.fallbackSource, "soundcloud");
	const destination = new PassThrough();
	info.stream!.pipe(destination);
	assert.equal(await readAll(destination), "audio-firstaudio-second", "Preflight must not drop the first audio data when piped");
});

test("empty fallback streams are discarded and another matching candidate is used", async () => {
	const first = soundcloud("first", "ĐẠT G x CHU THÚY QUỲNH – NGƯỢC LỐI YÊU");
	const second = soundcloud("second", "NGƯỢC LỐI YÊU - CHU THÚY QUỲNH & VICKY NHUNG");
	const opened: string[] = [];
	const result = await resolveSimilarMusic({
		requested: track(), source: "soundcloud", search: async () => ({ tracks: [first, second] }),
		open: async (candidate) => { opened.push(candidate.id); return candidate.id === "first" ? { type: "arbitrary", stream: Readable.from([]) } : audio("second stream"); },
	});
	assert.deepEqual(opened, ["first", "second"]);
	assert.equal(await readAll(result.stream!), "second stream");
});

test("fallback tries at most three candidates and never opens unrelated results", async () => {
	const matches = Array.from({ length: 6 }, (_, i) => soundcloud(`${i}`, `NGƯỢC LỐI YÊU - CHU THÚY QUỲNH ${i}`));
	let searches = 0, attempts = 0;
	await assert.rejects(resolveSimilarMusic({
		requested: track(), source: "soundcloud", search: async () => { searches++; return { tracks: matches }; },
		open: async () => { attempts++; throw new Error("unavailable"); },
	}), /No suitable soundcloud fallback stream/);
	assert.equal(searches, 3);
	assert.equal(attempts, 3);
	attempts = 0;
	await assert.rejects(resolveSimilarMusic({
		requested: track(), source: "soundcloud", search: async () => ({ tracks: [soundcloud("unrelated", "Totally different")] }),
		open: async () => { attempts++; return audio("wrong"); },
	}), /No suitable soundcloud fallback stream/);
	assert.equal(attempts, 0);
});

test("an aborted late stream is destroyed rather than leaking a network resource", async () => {
	const controller = new AbortController();
	const candidate = soundcloud("late", "ĐẠT G x CHU THÚY QUỲNH – NGƯỢC LỐI YÊU");
	let started!: () => void, release!: (value: StreamInfo) => void;
	const opening = new Promise<void>((resolve) => { started = resolve; });
	const late = new Promise<StreamInfo>((resolve) => { release = resolve; });
	const pending = resolveSimilarMusic({
		requested: track(), source: "soundcloud", signal: controller.signal,
		search: async () => ({ tracks: [candidate] }),
		open: async () => { started(); return late; },
	});
	await opening;
	controller.abort(new Error("cancelled by user"));
	await assert.rejects(pending, /cancelled by user/);
	const stream = new PassThrough();
	release({ type: "arbitrary", stream });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(stream.destroyed, true);
});

test("a stalled fallback stream hits its deadline and is closed", async () => {
	const stream = new PassThrough();
	await assert.rejects(resolveSimilarMusic({
		requested: track(), source: "soundcloud", budgetMs: 1_000,
		search: async () => ({ tracks: [soundcloud("stalled", "ĐẠT G x CHU THÚY QUỲNH – NGƯỢC LỐI YÊU")] }),
		open: async () => ({ type: "arbitrary", stream }),
	}), /No suitable|timed out/i);
	assert.equal(stream.destroyed, true);
});

test("the real ZiPlayer manager tries YouTube direct first, then discloses the actual SoundCloud fallback", async () => {
	const requested = track();
	const alternative = soundcloud("alternate", "NGƯỢC LỐI YÊU - CHU THÚY QUỲNH & VICKY NHUNG");
	const yt = new ResilientYouTubePlugin({ client: {} as any });
	const sc = new ResilientSoundCloudPlugin();
	const calls: string[] = [];
	yt.search = async () => { calls.push("youtube search"); return { tracks: [] }; };
	yt.getStream = async () => { calls.push("youtube direct"); throw new Error("blocked"); };
	sc.search = async (query) => { calls.push("soundcloud search"); return { tracks: query.includes("Màn Song Ca") ? [] : [alternative] }; };
	sc.getStream = async () => { calls.push("soundcloud stream"); return audio("fallback bytes"); };
	tracePluginStreams(yt); tracePluginStreams(sc);
	const manager = new PluginManager({ extractorTimeout: 5_000, enableCache: false });
	manager.register(yt); manager.register(sc);
	const player: any = { pluginManager: manager };
	installStreamProvenance(player);
	const result = await manager.getStream(requested);
	assert.equal(calls[0], "youtube direct");
	assert.equal(result?.metadata?.title, alternative.title);
	assert.deepEqual(getPlaybackFallback(player, requested), { source: "soundcloud", id: alternative.id, title: alternative.title });
	assert.equal(await readAll(result!.stream!), "fallback bytes");
	manager.destroy();
});

test("direct source success remains first and Spotify fallback favors the listed artist", async () => {
	const yt = new ResilientYouTubePlugin({ client: {} as any });
	let searches = 0;
	yt.search = async () => { searches++; return { tracks: [] }; };
	yt.getStream = async () => audio("original");
	tracePluginStreams(yt);
	const manager = new PluginManager({ extractorTimeout: 5_000, enableCache: false });
	manager.register(yt);
	const requested = track();
	const result = await manager.getStream(requested);
	assert.equal(await readAll(result!.stream!), "original");
	assert.equal(searches, 0, "Do not search for a replacement when the original opens");
	manager.destroy();

	const spotify = track({ id: "sp", source: "spotify", title: "Shape of You", url: "https://open.spotify.com/track/sp", metadata: { artist: "Ed Sheeran" } });
	const wrong = track({ id: "wrongid0001", title: "Shape of You", metadata: { author: "Other" } });
	const right = track({ id: "rightid0001", title: "Shape of You", metadata: { author: "Ed Sheeran" } });
	const spotifyYt = new ResilientYouTubePlugin({ client: {} as any });
	spotifyYt.search = async () => ({ tracks: [wrong, right] });
	spotifyYt.getStream = async (candidate) => audio(candidate.id);
	tracePluginStreams(spotifyYt);
	const spotifyManager = new PluginManager({ extractorTimeout: 5_000, enableCache: false });
	spotifyManager.register(new SpotifyPlugin()); spotifyManager.register(spotifyYt);
	const player: any = { pluginManager: spotifyManager };
	installStreamProvenance(player);
	const fallback = await spotifyManager.getStream(spotify);
	assert.equal(await readAll(fallback!.stream!), right.id);
	assert.equal(getPlaybackFallback(player, spotify)?.id, right.id);
	spotifyManager.destroy();
});

test("the real ZiPlayer manager closes an earlier fallback when a better provider wins", async () => {
	const requested = track({ source: "spotify", url: "https://open.spotify.com/track/123", metadata: {} });
	const youtubeCandidate = track({ id: "abcdefghijk", title: "Ngược Lối Yêu - Chu Thúy Quỳnh & Vicky Nhung" });
	const scCandidate = soundcloud("winning", requested.title);
	const youtubeStream = new PassThrough(), soundcloudStream = new PassThrough();
	youtubeStream.write("youtube first bytes"); soundcloudStream.write("soundcloud first bytes");
	const yt = new ResilientYouTubePlugin({ client: {} as any });
	const sc = new ResilientSoundCloudPlugin();
	yt.search = async () => ({ tracks: [youtubeCandidate] });
	yt.getStream = async () => ({ type: "arbitrary", stream: youtubeStream });
	sc.search = async () => ({ tracks: [scCandidate] });
	sc.getStream = async () => ({ type: "arbitrary", stream: soundcloudStream });
	tracePluginStreams(yt); tracePluginStreams(sc);
	const manager = new PluginManager({ extractorTimeout: 5_000, enableCache: false });
	manager.register(new SpotifyPlugin()); manager.register(yt); manager.register(sc);
	const player: any = { pluginManager: manager };
	installStreamProvenance(player);
	const result = await manager.getStream(requested);
	assert.equal(result?.stream, soundcloudStream);
	assert.equal(youtubeStream.destroyed, true, "An unchosen valid stream must not keep downloading");
	assert.equal(soundcloudStream.destroyed, false);
	assert.equal(getPlaybackFallback(player, requested)?.id, scCandidate.id);
	soundcloudStream.destroy(); manager.destroy();
});

test("unused and late provider streams are closed without touching the selected stream", async () => {
	const rejected = new PassThrough(), selected = new PassThrough();
	const plugin: any = tracePluginStreams({
		name: "soundcloud",
		getStream: async (candidate: Track) => ({ type: "arbitrary", stream: candidate.id === "discard" ? rejected : selected }),
	} as any);
	const request = track();
	const player: any = { pluginManager: { getStream: async () => {
		await plugin.getStream(soundcloud("discard", "first"));
		return plugin.getStream(soundcloud("selected", "second"));
	} } };
	installStreamProvenance(player);
	const result = await player.pluginManager.getStream(request);
	assert.equal(rejected.destroyed, true);
	assert.equal(selected.destroyed, false);
	assert.equal(result.stream, selected);
	selected.destroy();

	let release!: (value: StreamInfo) => void, completed!: () => void;
	const late = new PassThrough();
	const latePromise = new Promise<StreamInfo>((resolve) => { release = resolve; });
	const lateFinished = new Promise<void>((resolve) => { completed = resolve; });
	const latePlugin: any = tracePluginStreams({
		name: "youtube", getStream: async () => latePromise,
	} as any);
	const latePlayer: any = { pluginManager: { getStream: async () => {
		void latePlugin.getStream(request).then(completed);
		return null; // Model the upstream timeout returning before the provider.
	} } };
	installStreamProvenance(latePlayer);
	await latePlayer.pluginManager.getStream(request);
	release({ type: "arbitrary", stream: late });
	await lateFinished;
	assert.equal(late.destroyed, true);
});

test("independent concurrent resolutions never destroy another guild's stream", async () => {
	const one = new PassThrough(), two = new PassThrough();
	let allowOne!: () => void, openedOne!: () => void;
	const waitOne = new Promise<void>((resolve) => { allowOne = resolve; });
	const hasOpenedOne = new Promise<void>((resolve) => { openedOne = resolve; });
	const plugin: any = tracePluginStreams({
		name: "soundcloud", getStream: async (item: Track) => ({ type: "arbitrary", stream: item.id === "one" ? one : two }),
	} as any);
	const first: any = { pluginManager: { getStream: async () => {
		const stream = await plugin.getStream(soundcloud("one", "one")); openedOne(); await waitOne; return stream;
	} } };
	const second: any = { pluginManager: { getStream: async () => plugin.getStream(soundcloud("two", "two")) } };
	installStreamProvenance(first); installStreamProvenance(second);
	const waiting = first.pluginManager.getStream(track());
	await hasOpenedOne;
	await second.pluginManager.getStream(track());
	assert.equal(one.destroyed, false);
	assert.equal(two.destroyed, false);
	allowOne(); await waiting;
	assert.equal(one.destroyed, false);
	one.destroy(); two.destroy();
});

test("failed SoundCloud initialization is handled, retried lazily, and retries are throttled", async () => {
	const original = SoundCloud.prototype.init;
	let calls = 0;
	SoundCloud.prototype.init = async function () {
		calls++;
		if (calls <= 2) throw new Error("offline");
		(this as any).clientId = "test"; (this as any).appVersion = "1";
	};
	try {
		const plugin = new ResilientSoundCloudPlugin();
		const client = (plugin as any).client;
		client.search = async () => [{ id: 12, title: "test song", duration: 120_000, permalink_url: "https://soundcloud.com/a/b", user: { username: "a" } }];
		const result = await plugin.search("test song", "user");
		assert.equal(result.tracks[0].title, "test song");
		assert.equal(calls, 3, "Two upstream starts fail; one lazy initialization succeeds");
	} finally { SoundCloud.prototype.init = original; }

	let failedCalls = 0;
	SoundCloud.prototype.init = async function () { failedCalls++; throw new Error("offline"); };
	try {
		const plugin = new ResilientSoundCloudPlugin();
		await assert.rejects(plugin.search("one", "user"));
		await assert.rejects(plugin.search("two", "user"), /temporarily unavailable/);
		assert.equal(failedCalls, 3, "A failed lazy retry is not repeated for every search");
	} finally { SoundCloud.prototype.init = original; }
});
