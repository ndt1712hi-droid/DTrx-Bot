import type { Player } from "ziplayer";
/**
 * ZiPlayer delegates arbitrary audio to prism's FFmpeg transform. On an early
 * stop/skip, destroying the last stream does not always destroy that transform,
 * leaving an FFmpeg child alive indefinitely. Decode explicitly and tie the
 * subprocess and input stream to the lifetime of the resulting audio resource.
 */
export declare function installManagedAudioResources(player: Player, ffmpegPath: string | null): void;
