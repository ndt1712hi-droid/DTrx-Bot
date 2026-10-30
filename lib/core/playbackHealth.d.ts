import type { Player } from "ziplayer";
export type AudioDeliveryStatus = "delivering" | "muted" | "paused" | "tts" | "disconnected" | "no-subscription" | "stopped" | "replaced" | "buffering" | "external";
/**
 * TRACK_STARTED means a resource was handed to the audio player, not that
 * packets reached a voice connection. Wait briefly for the local voice player
 * to advance, without claiming that Discord clients actually heard it.
 */
export declare function waitForAudioDelivery(player: Player, timeoutMs?: number): Promise<AudioDeliveryStatus>;
