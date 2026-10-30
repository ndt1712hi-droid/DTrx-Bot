const SCHEMELESS_MUSIC_LINK = /^(?:(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)|open\.spotify\.com|(?:www\.|m\.)?soundcloud\.com)\//i;

/**
 * Normalize only common shared-link forms that the upstream extractors cannot
 * parse. Ordinary HTTP URLs (especially signed audio-file links) and their
 * query parameters are otherwise left byte-for-byte intact after trimming.
 */
export function normalizeMusicQuery(input: string): string {
	let query = input.trim();
	if (/^<[^<>]+>$/.test(query)) {
		const inside = query.slice(1, -1);
		if (/^https?:\/\//i.test(inside) || SCHEMELESS_MUSIC_LINK.test(inside)) query = inside;
	}

	// Clipboard text sometimes omits the protocol. Restrict this convenience to
	// known music hosts so a song title is not turned into a URL by accident.
	if (SCHEMELESS_MUSIC_LINK.test(query)) {
		query = `https://${query}`;
	}
	if (!/^https?:\/\//i.test(query)) return query;

	let url: URL;
	try {
		url = new URL(query);
	} catch {
		return query;
	}
	const host = url.hostname.toLowerCase();
	if (host === "www.youtu.be") {
		// The upstream YouTube parser accepts this host but extracts IDs only
		// from youtu.be, so use the supported equivalent without dropping params.
		return `https://youtu.be${url.pathname}${url.search}${url.hash}`;
	}

	const youtubeHost = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host);
	if (youtubeHost) {
		const match = url.pathname.match(/^\/(?:live|v)\/([A-Za-z0-9_-]{11})\/?$/);
		if (match) {
			// Preserve list/index/time and other parameters while giving the plugin
			// the watch URL shape it already knows how to parse.
			return `https://www.youtube.com/watch?v=${match[1]}${url.search ? `&${url.search.slice(1)}` : ""}${url.hash}`;
		}
	}
	if ((host === "youtube-nocookie.com" || host === "www.youtube-nocookie.com") && /^\/embed\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname)) {
		return `https://www.youtube.com${url.pathname}${url.search}${url.hash}`;
	}
	return query;
}

export function isDirectMusicQuery(input: string): boolean {
	const normalized = normalizeMusicQuery(input);
	return /^(?:https?:\/\/|spotify:|soundcloud:|sc:|tts:)/i.test(normalized);
}
