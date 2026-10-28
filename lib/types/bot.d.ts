import type { Track, LoopMode, PlayerDebugLevel } from "ziplayer";
import type { lyricsExt } from "@ziplayer/extension";
export type LyricsResult = NonNullable<Awaited<ReturnType<lyricsExt["fetch"]>>>;
export interface LavalinkNodeConfig {
    identifier?: string;
    host: string;
    port: number;
    password: string;
    secure?: boolean;
}
export interface BotConfig {
    discordToken: string;
    clientId: string;
    guildId?: string;
    prefix: string;
    autoDeployCommands: boolean;
    defaultVolume: number;
    leaveOnEnd: boolean;
    leaveOnEmpty: boolean;
    leaveTimeoutMs: number;
    lowPerformance: boolean;
    crossfadeDurationMs: number;
    extractorTimeoutMs: number;
    enablePersistence: boolean;
    persistenceFile: string;
    maxSaveDurationSec: number;
    ttsLang: string;
    ttsMaxTimeMs: number;
    enableLyrics: boolean;
    autoLiveLyrics: boolean;
    enableVoiceCommands: boolean;
    voiceLang: string;
    voiceWakeWords: string[];
    geminiApiKey?: string;
    lavalinkNodes: LavalinkNodeConfig[];
    debugLevel: PlayerDebugLevel;
    ffmpegPath: string | null;
}
export interface PlayerUserData {
    textChannelId: string;
    voiceChannelId: string;
    controllerMessageId?: string;
    liveLyricsEnabled?: boolean;
    lyricsMessageId?: string;
    lastLyricsEditAt?: number;
    cachedLyrics?: LyricsResult | null;
    lyricsTrackId?: string;
    lyricsExtInstance?: lyricsExt;
    voiceCommandsEnabled?: boolean;
}
export type VoiceCommandAction = {
    type: "play";
    query: string;
} | {
    type: "skip";
} | {
    type: "stop";
} | {
    type: "pause";
} | {
    type: "resume";
} | {
    type: "previous";
} | {
    type: "shuffle";
} | {
    type: "autoplay";
} | {
    type: "volume";
    level: number;
} | {
    type: "loop";
    mode: LoopMode;
};
export interface PersistedGuildSession {
    guildId: string;
    voiceChannelId: string;
    textChannelId: string;
    currentTrack: Track | null;
    upcomingTracks: Track[];
    volume: number;
    loopMode: LoopMode;
    autoPlay: boolean;
    activeFilters: string[];
    savedAt: number;
}
