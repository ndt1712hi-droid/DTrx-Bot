import type { GreetingKind } from "./memberGreetingStore.js";
export declare const MAX_BANNER_UPLOAD_BYTES = 3000000;
export interface MemberBannerData {
    kind: GreetingKind;
    displayName: string;
    serverName: string;
    memberCount?: number | null;
    avatarUrl?: string | null;
    background?: Buffer;
}
/** Safe, user-facing errors caused by an invalid uploaded image. */
export declare class BannerInputError extends Error {
}
export declare function fetchDiscordAvatar(url: string, fetcher?: typeof fetch, timeoutMs?: number): Promise<Buffer | null>;
export declare function fetchDiscordBannerAttachment(url: string, fetcher?: typeof fetch, timeoutMs?: number): Promise<Buffer | null>;
/** Validate dimensions before decoding, then crop and re-encode once to limit
 * disk usage and avoid repeatedly decoding oversized source images. */
export declare function normalizeBannerBackground(input: Buffer): Promise<Buffer>;
export declare function renderMemberBanner(data: MemberBannerData): Promise<Buffer>;
