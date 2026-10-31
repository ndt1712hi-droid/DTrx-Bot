import { AsyncLocalStorage } from "node:async_hooks";
const STREAM_SOURCE_KEY = "__dtrxResolvedSource";
const playbackFallbacks = new WeakMap();
const streamResolutions = new AsyncLocalStorage();
function discardStream(stream) {
    try {
        if (!stream.destroyed)
            stream.destroy();
    }
    catch { /* best-effort cleanup */ }
}
/** Include the actual track in StreamInfo so ZiPlayer's fallback resolver does
 * not silently make a different recording look like the requested one. */
export function tracePluginStreams(plugin) {
    const original = plugin.getStream.bind(plugin);
    plugin.getStream = async (track, signal) => {
        const result = await original(track, signal);
        if (!result?.stream)
            return result;
        const resolution = streamResolutions.getStore();
        if (resolution?.finished && resolution.selected !== result.stream)
            discardStream(result.stream);
        else
            resolution?.opened.add(result.stream);
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
export function installStreamProvenance(player) {
    const resolved = new WeakMap();
    playbackFallbacks.set(player, resolved);
    const original = player.pluginManager.getStream.bind(player.pluginManager);
    player.pluginManager.getStream = (track, options) => {
        const resolution = { opened: new Set(), finished: false };
        return streamResolutions.run(resolution, async () => {
            let selected;
            try {
                const result = await original(track, options);
                selected = result?.stream;
                const source = result?.metadata?.[STREAM_SOURCE_KEY];
                if (isPlaybackFallback(source) &&
                    (source.source.toLowerCase() !== track.source?.toLowerCase() || source.id !== track.id)) {
                    resolved.set(track, source);
                }
                else {
                    resolved.delete(track);
                }
                return result;
            }
            finally {
                // ZiPlayer can compare several valid fallback streams but does not
                // dispose the losers. Isolate cleanup per concurrent resolution;
                // a provider completing after a timeout is also discarded by trace.
                resolution.selected = selected;
                resolution.finished = true;
                for (const stream of resolution.opened)
                    if (stream !== selected)
                        discardStream(stream);
                resolution.opened.clear();
            }
        });
    };
}
export function getPlaybackFallback(player, track) {
    return track ? playbackFallbacks.get(player)?.get(track) : undefined;
}
function isPlaybackFallback(value) {
    if (!value || typeof value !== "object")
        return false;
    const item = value;
    return typeof item.source === "string" && typeof item.id === "string" && typeof item.title === "string";
}
//# sourceMappingURL=streamProvenance.js.map