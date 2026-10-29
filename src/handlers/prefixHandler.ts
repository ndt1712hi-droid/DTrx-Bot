import type { Message } from "discord.js";
import type { ZiMusicBotEngine } from "../core/musicEngine.js";
import {
	MusicCommandActions,
	toMessageOptions,
	type CommandContext,
	type ReplyPayload,
} from "./musicActions.js";

function createMessageContext(message: Message): CommandContext | null {
	if (!message.guild || !message.member || !message.channel.isSendable()) {
		return null;
	}

	const sendableChannel = message.channel;
	let statusMessage: Message | null = null;

	return {
		guild: message.guild,
		member: message.member,
		userId: message.author.id,
		textChannelId: message.channel.id,
		defer: async () => {
			await sendableChannel.sendTyping().catch(() => undefined);
		},
		reply: async (payload: ReplyPayload) => {
			const opts = toMessageOptions(payload);
			if (statusMessage) {
				await statusMessage.edit(opts as Parameters<Message["edit"]>[0]).catch(() => undefined);
			} else {
				statusMessage = await message.reply(opts).catch(() => null);
			}
		},
	};
}

export function registerPrefixHandler(engine: ZiMusicBotEngine, actions: MusicCommandActions): void {
	const prefix = engine.config.prefix;

	engine.client.on("messageCreate", async (message: Message) => {
		try {
			if (message.author.bot || !message.guild) return;

			let raw: string | null = null;
			const botId = engine.client.user?.id;
			const mentionMatch = botId
				? message.content.match(new RegExp(`^<@!?${botId}>\\s*(.*)$`, "s"))
				: null;

			if (message.content.startsWith(prefix)) {
				raw = message.content.slice(prefix.length).trim();
			} else if (mentionMatch) {
				raw = mentionMatch[1].trim();
			} else {
				return;
			}

			if (!raw && message.attachments.size === 0) return;

			const args = raw ? raw.split(/\s+/) : [];
			const cmd = (args.shift() ?? "").toLowerCase();
			if (!cmd) return;

			const ctx = createMessageContext(message);
			if (!ctx) return;

			switch (cmd) {
				case "play":
				case "p":
					await actions.play(ctx, args.join(" "), message.attachments.first()?.url);
					break;

				case "playnext":
				case "pn":
				case "insert":
					await actions.playNext(ctx, args.join(" "));
					break;

				case "tts":
				case "say":
					await actions.tts(ctx, args.join(" "));
					break;

				case "pause":
					await actions.pause(ctx);
					break;

				case "resume":
				case "unpause":
					await actions.resume(ctx);
					break;

				case "skip":
				case "s":
				case "next": {
					const to = args[0] ? Number.parseInt(args[0], 10) : undefined;
					await actions.skip(ctx, Number.isFinite(to) ? to : undefined);
					break;
				}

				case "previous":
				case "prev":
				case "back":
					await actions.previous(ctx);
					break;

				case "stop":
					await actions.stop(ctx);
					break;

				case "leave":
				case "dc":
				case "disconnect":
					await actions.leave(ctx);
					break;

				case "nowplaying":
				case "np":
				case "status":
					await actions.nowPlaying(ctx);
					break;

				case "queue":
				case "q": {
					const page = args[0] ? Number.parseInt(args[0], 10) : 1;
					await actions.queue(ctx, Number.isFinite(page) ? page : 1);
					break;
				}

				case "shuffle":
				case "mix":
					await actions.shuffle(ctx);
					break;

				case "loop":
				case "repeat":
					await actions.loop(ctx, args[0] ?? "");
					break;

				case "autoplay":
				case "auto":
				case "ap":
					await actions.autoPlay(ctx);
					break;

				case "seek":
					await actions.seek(ctx, args.join(" "));
					break;

				case "volume":
				case "vol":
				case "v": {
					const lvl = args[0] !== undefined ? Number.parseInt(args[0], 10) : undefined;
					await actions.volume(ctx, lvl);
					break;
				}

				case "move":
				case "mv":
					await actions.move(
						ctx,
						Number.parseInt(args[0] ?? "", 10),
						Number.parseInt(args[1] ?? "", 10),
					);
					break;

				case "swap":
					await actions.swap(
						ctx,
						Number.parseInt(args[0] ?? "", 10),
						Number.parseInt(args[1] ?? "", 10),
					);
					break;

				case "remove":
				case "rm":
					await actions.remove(ctx, Number.parseInt(args[0] ?? "", 10));
					break;

				case "clear":
					await actions.clear(ctx);
					break;

				case "filter":
				case "fx":
				case "eq": {
					const sub = (args[0] ?? "list").toLowerCase();
					if (["list", "clear", "off", "reset"].includes(sub)) {
						await actions.filter(ctx, sub);
					} else if (["apply", "add", "remove", "rm"].includes(sub)) {
						await actions.filter(ctx, sub === "add" ? "apply" : sub === "rm" ? "remove" : sub, args[1]);
					} else {
						// Shorthand: `!filter bassboost` applies `bassboost` directly!
						await actions.filter(ctx, "apply", args[0]);
					}
					break;
				}

				case "lyrics":
				case "ly":
				case "lrc":
					await actions.lyrics(ctx, args[0] ?? "show");
					break;

				case "save":
				case "download":
					await actions.save(ctx, args[0]);
					break;

				case "mirror":
					await actions.mirror(ctx, args[0] ?? "");
					break;

				case "stats":
				case "ping":
					await actions.stats(ctx);
					break;

				case "help":
				case "h":
					await actions.help(ctx);
					break;
			}
		} catch (err) {
			console.error("[PrefixHandler] Error handling message command:", err);
		}
	});
}
