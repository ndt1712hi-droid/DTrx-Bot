import type { BasePlugin, Player, Track } from "ziplayer";

export interface PlaybackFallback {
	source: string;
	id: string;
	title: string;
}

const STREAM_SOURCE_KEY = "__dtrxResolvedSource";
const playbackFallbacks = new WeakMap<Player, WeakMap<Track, PlaybackFallback>>();

/** Include the actual track in StreamInfo so ZiPlayer's fallback resolver does
 * not silently make a different recording look like the requested one. */
export function tracePluginStreams<T extends BasePlugin>(plugin: T): T {
	const original = plugin.getStream.bind(plugin);
	plugin.getStream = async (track, signal) => {
		const result = await original(track, signal);
		if (!result?.stream) return result;
		return {
			...result,
			metadata: {
				...result.metadata,
				[STREAM_SOURCE_KEY]: { source: plugin.name, id: track.id, title: track.title },
			},
		};
	};
	return plugin;
}

/** Record only the final stream selected by ZiPlayer, not every attempted
 * fallback. Per-player weak maps avoid stale persisted state and cross-guild
 * interference when the search cache shares track objects. */
export function installStreamProvenance(player: Player): void {
	const resolved = new WeakMap<Track, PlaybackFallback>();
	playbackFallbacks.set(player, resolved);
	const original = player.pluginManager.getStream.bind(player.pluginManager);
	player.pluginManager.getStream = async (track, options) => {
		const result = await original(track, options);
		const source: unknown = result?.metadata?.[STREAM_SOURCE_KEY];
		if (isPlaybackFallback(source) &&
			(source.source.toLowerCase() !== track.source?.toLowerCase() || source.id !== track.id)) {
			resolved.set(track, source);
		} else {
			resolved.delete(track);
		}
		return result;
	};
}

export function getPlaybackFallback(player: Player, track: Track | null | undefined): PlaybackFallback | undefined {
	return track ? playbackFallbacks.get(player)?.get(track) : undefined;
}

function isPlaybackFallback(value: unknown): value is PlaybackFallback {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<PlaybackFallback>;
	return typeof item.source === "string" && typeof item.id === "string" && typeof item.title === "string";
}
