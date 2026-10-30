import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { GreetingKind } from "./memberGreetingStore.js";

const WIDTH = 1200;
const HEIGHT = 420;
const MAX_AVATAR_BYTES = 1_000_000;
export const MAX_BANNER_UPLOAD_BYTES = 3_000_000;
const MAX_BANNER_PIXELS = 8_000_000;
const MAX_BANNER_DIMENSION = 4_096;
const AVATAR_TIMEOUT_MS = 3_500;
const BANNER_DOWNLOAD_TIMEOUT_MS = 8_000;
const assets = fileURLToPath(new URL("../../assets/", import.meta.url));
const FONT_FAMILY = "BeVietnamPro";

type CanvasModule = typeof import("@napi-rs/canvas");
type CanvasImage = Awaited<ReturnType<CanvasModule["loadImage"]>>;
interface CanvasResources { module: CanvasModule; background: CanvasImage }
let resources: Promise<CanvasResources> | undefined;

async function getCanvasResources(): Promise<CanvasResources> {
	if (!resources) {
		resources = (async () => {
			// Load native Skia only when a configured event needs an image.
			const module = await import("@napi-rs/canvas");
			const normal = module.GlobalFonts.registerFromPath(`${assets}fonts/BeVietnamPro-Regular.ttf`, FONT_FAMILY);
			const bold = module.GlobalFonts.registerFromPath(`${assets}fonts/BeVietnamPro-Bold.ttf`, FONT_FAMILY);
			if (!normal || !bold) throw new Error("Không nạp được font banner");
			const background = await module.loadImage(await fs.readFile(`${assets}member-banner-background.jpg`));
			return { module, background };
		})().catch((err: unknown) => { resources = undefined; throw err; });
	}
	return resources;
}

export interface MemberBannerData {
	kind: GreetingKind;
	displayName: string;
	serverName: string;
	memberCount?: number | null;
	avatarUrl?: string | null;
	background?: Buffer;
}

/** Safe, user-facing errors caused by an invalid uploaded image. */
export class BannerInputError extends Error {}

function cleanLabel(value: string, fallback: string): string {
	const clean = value.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
	return Array.from(clean || fallback).slice(0, 150).join("");
}

function fitText(ctx: SKRSContext2D, value: string, maxWidth: number): string {
	if (ctx.measureText(value).width <= maxWidth) return value;
	const parts = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map((item) => item.segment);
	while (parts.length && ctx.measureText(`${parts.join("")}…`).width > maxWidth) parts.pop();
	return `${parts.join("")}…`;
}

/** Restrict image downloads to Discord CDN, with no redirects, a deadline and
 * a streamed size limit. Attachments additionally require a Discord attachment path. */
async function fetchDiscordImage(url: string, fetcher: typeof fetch, timeoutMs: number, maxBytes: number, attachmentOnly: boolean): Promise<Buffer | null> {
	let parsed: URL;
	try { parsed = new URL(url); } catch { return null; }
	if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
		!["cdn.discordapp.com", "media.discordapp.net"].includes(parsed.hostname.toLowerCase()) ||
		(attachmentOnly && !/^\/(?:ephemeral-)?attachments\//.test(parsed.pathname))) return null;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const cancelOnAbort = () => { void reader?.cancel().catch(() => undefined); };
	controller.signal.addEventListener("abort", cancelOnAbort, { once: true });
	try {
		const response = await fetcher(parsed, { signal: controller.signal, redirect: "error" });
		const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
		const size = Number(response.headers.get("content-length") ?? 0);
		if (!response.ok || (type && !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type)) ||
			(Number.isFinite(size) && size > maxBytes) || !response.body) return null;
		reader = response.body.getReader();
		const chunks: Buffer[] = [];
		let total = 0;
		while (true) {
			const next = await reader.read();
			if (controller.signal.aborted) return null;
			if (next.done) break;
			total += next.value.byteLength;
			if (total > maxBytes) { controller.abort(); await reader.cancel().catch(() => undefined); return null; }
			chunks.push(Buffer.from(next.value));
		}
		return total ? Buffer.concat(chunks, total) : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
		controller.abort();
		controller.signal.removeEventListener("abort", cancelOnAbort);
		reader?.releaseLock();
	}
}

export function fetchDiscordAvatar(url: string, fetcher: typeof fetch = fetch, timeoutMs = AVATAR_TIMEOUT_MS): Promise<Buffer | null> {
	return fetchDiscordImage(url, fetcher, timeoutMs, MAX_AVATAR_BYTES, false);
}

export function fetchDiscordBannerAttachment(url: string, fetcher: typeof fetch = fetch, timeoutMs = BANNER_DOWNLOAD_TIMEOUT_MS): Promise<Buffer | null> {
	return fetchDiscordImage(url, fetcher, timeoutMs, MAX_BANNER_UPLOAD_BYTES, true);
}

/** Validate dimensions before decoding, then crop and re-encode once to limit
 * disk usage and avoid repeatedly decoding oversized source images. */
export async function normalizeBannerBackground(input: Buffer): Promise<Buffer> {
	if (!input.length || input.length > MAX_BANNER_UPLOAD_BYTES) {
		throw new BannerInputError("Ảnh cần nhỏ hơn hoặc bằng 3 MB.");
	}
	let dimensions: { width?: number; height?: number; type?: string };
	try { dimensions = (await import("image-size")).imageSize(input); }
	catch { throw new BannerInputError("Không nhận diện được ảnh. Hãy dùng JPG, PNG hoặc WebP."); }
	const { width, height, type } = dimensions;
	if (!width || !height || !["jpg", "png", "webp"].includes(type ?? "")) {
		throw new BannerInputError("Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP.");
	}
	if (width > MAX_BANNER_DIMENSION || height > MAX_BANNER_DIMENSION || width * height > MAX_BANNER_PIXELS) {
		throw new BannerInputError("Ảnh quá lớn: tối đa 4096 px mỗi chiều và 8 triệu điểm ảnh.");
	}
	const { module } = await getCanvasResources();
	let image: CanvasImage;
	try { image = await module.loadImage(input); }
	catch { throw new BannerInputError("Không thể đọc ảnh này. Hãy thử ảnh JPG, PNG hoặc WebP khác."); }
	if (!image.width || !image.height || image.width > MAX_BANNER_DIMENSION || image.height > MAX_BANNER_DIMENSION || image.width * image.height > MAX_BANNER_PIXELS) {
		throw new BannerInputError("Kích thước ảnh sau khi đọc không hợp lệ.");
	}
	const canvas = module.createCanvas(WIDTH, HEIGHT);
	const ctx = canvas.getContext("2d");
	const scale = Math.max(WIDTH / image.width, HEIGHT / image.height);
	const drawWidth = image.width * scale;
	const drawHeight = image.height * scale;
	// A black base gives transparent PNG/WebP a consistent background.
	ctx.fillStyle = "#080f22"; ctx.fillRect(0, 0, WIDTH, HEIGHT);
	ctx.drawImage(image, (WIDTH - drawWidth) / 2, (HEIGHT - drawHeight) / 2, drawWidth, drawHeight);
	return canvas.encode("jpeg", 82);
}

export async function renderMemberBanner(data: MemberBannerData): Promise<Buffer> {
	const { module, background } = await getCanvasResources();
	const canvas = module.createCanvas(WIDTH, HEIGHT);
	const ctx = canvas.getContext("2d");
	const selected = data.background ? await module.loadImage(data.background).catch(() => background) : background;
	ctx.drawImage(selected, 0, 0, WIDTH, HEIGHT);

	// A stronger dark panel protects text on user-supplied light backgrounds.
	ctx.fillStyle = data.background ? "rgba(4, 10, 31, 0.66)" : "rgba(4, 10, 31, 0.40)";
	ctx.beginPath(); ctx.roundRect(25, 24, 1150, 372, 25); ctx.fill();
	const accent = data.kind === "welcome" ? "#60ddff" : "#d6a6ff";
	ctx.strokeStyle = data.kind === "welcome" ? "rgba(96, 221, 255, .42)" : "rgba(214, 166, 255, .42)";
	ctx.lineWidth = 2;
	ctx.beginPath(); ctx.roundRect(25, 24, 1150, 372, 25); ctx.stroke();

	const cx = 164, cy = 210, r = 106;
	ctx.save();
	ctx.shadowColor = accent; ctx.shadowBlur = 20;
	ctx.strokeStyle = accent; ctx.lineWidth = 6;
	ctx.beginPath(); ctx.arc(cx, cy, r + 7, 0, Math.PI * 2); ctx.stroke();
	ctx.restore();
	ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
	ctx.fillStyle = "#1b3157"; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
	let avatar: CanvasImage | null = null;
	if (data.avatarUrl) {
		const bytes = await fetchDiscordAvatar(data.avatarUrl);
		if (bytes) avatar = await module.loadImage(bytes).catch(() => null);
	}
	if (avatar && avatar.width > 0 && avatar.height > 0) {
		const side = Math.min(avatar.width, avatar.height);
		ctx.drawImage(avatar, (avatar.width - side) / 2, (avatar.height - side) / 2, side, side, cx - r, cy - r, r * 2, r * 2);
	} else {
		// Offline/unavailable avatars do not prevent a welcome message.
		ctx.fillStyle = "#b8cbed";
		ctx.beginPath(); ctx.arc(cx, cy - 30, 42, 0, Math.PI * 2); ctx.fill();
		ctx.beginPath(); ctx.ellipse(cx, cy + 82, 75, 66, 0, 0, Math.PI * 2); ctx.fill();
	}
	ctx.restore();

	const x = 325;
	ctx.fillStyle = accent;
	ctx.font = `bold 22px ${FONT_FAMILY}`;
	ctx.fillText(data.kind === "welcome" ? "WELCOME TO THE COMMUNITY" : "GOODBYE AND TAKE CARE", x, 78);
	ctx.fillStyle = "#eef5ff";
	ctx.font = `bold 38px ${FONT_FAMILY}`;
	ctx.fillText(data.kind === "welcome" ? "Chào mừng" : "Tạm biệt", x, 145);
	ctx.fillStyle = "#ffffff";
	ctx.font = `bold 58px ${FONT_FAMILY}`;
	ctx.fillText(fitText(ctx, cleanLabel(data.displayName, "Thành viên"), 790), x, 220);
	ctx.fillStyle = "#b7c7e3";
	ctx.font = `26px ${FONT_FAMILY}`;
	const server = cleanLabel(data.serverName, "máy chủ");
	const line = `${data.kind === "welcome" ? "Đã tham gia" : "Đã rời"}  ${server}`;
	ctx.fillText(fitText(ctx, line, 790), x, 276);
	ctx.fillStyle = "rgba(219, 232, 255, .78)";
	ctx.font = `20px ${FONT_FAMILY}`;
	const count = Number.isSafeInteger(data.memberCount) && (data.memberCount ?? 0) > 0
		? `${data.memberCount} thành viên` : "Cộng đồng Discord";
	ctx.fillText(count, x, 332);
	return canvas.encode("jpeg", 86);
}
