import {
	EmbedBuilder,
	GuildMember,
	MessageFlags,
	type AutocompleteInteraction,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type Interaction,
	type StringSelectMenuInteraction,
} from "discord.js";
import { PREDEFINED_FILTERS } from "ziplayer";
import type { ZiMusicBotEngine } from "../core/musicEngine.js";
import type { PlayerUserData } from "../types/bot.js";
import {
	buildFullLyricsEmbed,
	buildNowPlayingPayload,
	COLORS,
	CONTROL_IDS,
} from "../ui/embeds.js";
import { formatDuration, nextLoopMode, truncate } from "../utils/format.js";
import {
	MusicCommandActions,
	validateMemberVoiceAccess,
	type CommandContext,
	type ReplyPayload,
} from "./musicActions.js";

function createSlashContext(interaction: ChatInputCommandInteraction): CommandContext | null {
	if (!interaction.guild || !(interaction.member instanceof GuildMember)) {
		return null;
	}

	let deferred = false;
	return {
		guild: interaction.guild,
		member: interaction.member,
		userId: interaction.user.id,
		textChannelId: interaction.channelId,
		defer: async (ephemeral = false) => {
			if (deferred || interaction.deferred || interaction.replied) return;
			deferred = true;
			await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : undefined);
		},
		reply: async (payload: ReplyPayload) => {
			const base = {
				content: payload.content,
				embeds: payload.embeds,
				files: payload.files,
			};
			if (interaction.deferred || deferred) {
				await interaction.editReply(base);
			} else if (interaction.replied) {
				await interaction.followUp({
					...base,
					...(payload.ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
				});
			} else {
				await interaction.reply({
					...base,
					...(payload.ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
				});
			}
		},
	};
}

async function handleAutocomplete(engine: ZiMusicBotEngine, interaction: AutocompleteInteraction): Promise<void> {
	try {
		const focused = interaction.options.getFocused(true);
		const value = focused.value.trim();

		if (
			(interaction.commandName === "filter" && focused.name === "name") ||
			(interaction.commandName === "save" && focused.name === "filter")
		) {
			const action = interaction.commandName === "filter" ? interaction.options.getString("action") : "apply";
			const player = interaction.guildId ? engine.manager.get(interaction.guildId) : undefined;
			const pool =
				action === "remove" && player
					? player.filter.getActiveFilters().map((f) => [f.name, f] as const)
					: Object.entries(PREDEFINED_FILTERS);

			const lower = value.toLowerCase();
			const matches = pool
				.filter(([k, def]) => !lower || k.toLowerCase().includes(lower) || def.description.toLowerCase().includes(lower))
				.slice(0, 25)
				.map(([k, def]) => ({
					name: truncate(`${k} — ${def.description} [${def.category ?? "fx"}]`, 100),
					value: k,
				}));

			await interaction.respond(matches);
			return;
		}

		if ((interaction.commandName === "play" || interaction.commandName === "playnext") && focused.name === "query") {
			if (value.length < 2 || /^https?:\/\//i.test(value) || value.toLowerCase().startsWith("tts:")) {
				await interaction.respond(
					value
						? [{ name: truncate(`▶️ Phát trực tiếp: ${value}`, 100), value: truncate(value, 100) }]
						: [],
				);
				return;
			}

			// Bound autocomplete search under 2200ms so Discord's 3s interaction window never expires
			const result = await Promise.race([
				engine.manager.search(value, interaction.user.id),
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_200)),
			]).catch(() => null);

			if (!result || !result.tracks?.length) {
				await interaction.respond([{ name: truncate(`🔍 Tìm kiếm: ${value}`, 100), value: truncate(value, 100) }]);
				return;
			}

			const choices = result.tracks.slice(0, 10).map((t) => {
				const label = truncate(`${t.title} [${formatDuration(t.duration, t.isLive)}]`, 100);
				const choiceValue = t.url && t.url.length <= 100 ? t.url : truncate(t.title, 100);
				return { name: label, value: choiceValue };
			});

			await interaction.respond(choices);
		}
	} catch {
		// Autocomplete timeouts are benign; swallow safely
	}
}

async function handleControllerComponent(
	engine: ZiMusicBotEngine,
	interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<void> {
	if (!interaction.guild || !(interaction.member instanceof GuildMember)) return;

	const player = engine.manager.get(interaction.guild.id);
	if (!player || player.destroyed || !player.currentTrack) {
		await interaction.reply({
			embeds: [new EmbedBuilder().setColor(COLORS.ERROR).setDescription("❌ Phiên phát nhạc này đã kết thúc!")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const access = validateMemberVoiceAccess(interaction.member, player);
	if (!access.ok) {
		await interaction.reply({
			embeds: [new EmbedBuilder().setColor(COLORS.ERROR).setDescription(access.reason)],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const ud = player.userdata as PlayerUserData;

	if (interaction.isStringSelectMenu() && interaction.customId === CONTROL_IDS.FILTER_SELECT) {
		const selected = interaction.values[0];
		await interaction.deferUpdate();

		if (selected === "clear") {
			await player.filter.clearAll();
		} else if (player.filter.hasFilter(selected)) {
			await player.filter.removeFilter(selected);
		} else {
			await player.filter.applyFilter(selected);
		}

		await interaction.editReply(buildNowPlayingPayload(player, false)).catch(() => undefined);
		return;
	}

	if (!interaction.isButton()) return;

	switch (interaction.customId) {
		case CONTROL_IDS.PREV: {
			await interaction.deferUpdate();
			await player.previous();
			break;
		}
		case CONTROL_IDS.TOGGLE: {
			if (player.isPaused) {
				player.resume();
			} else {
				player.pause();
			}
			await interaction.update(buildNowPlayingPayload(player, false)).catch(() => undefined);
			break;
		}
		case CONTROL_IDS.SKIP: {
			await interaction.deferUpdate();
			player.skip();
			break;
		}
		case CONTROL_IDS.STOP: {
			player.clearQueue();
			player.stop();
			await interaction.update(buildNowPlayingPayload(player, true)).catch(() => undefined);
			break;
		}
		case CONTROL_IDS.LOOP: {
			const next = nextLoopMode(player.queue.getLoopMode());
			player.loop(next);
			await interaction.update(buildNowPlayingPayload(player, false)).catch(() => undefined);
			break;
		}
		case CONTROL_IDS.SHUFFLE: {
			player.shuffle();
			await interaction.update(buildNowPlayingPayload(player, false)).catch(() => undefined);
			break;
		}
		case CONTROL_IDS.AUTOPLAY: {
			player.autoPlay(!player.autoPlay());
			await interaction.update(buildNowPlayingPayload(player, false)).catch(() => undefined);
			break;
		}
		case CONTROL_IDS.VOLDOWN: {
			player.setVolume(Math.max(0, player.volume - 10));
			await interaction.update(buildNowPlayingPayload(player, false)).catch(() => undefined);
			break;
		}
		case CONTROL_IDS.VOLUP: {
			player.setVolume(Math.min(100, player.volume + 10));
			await interaction.update(buildNowPlayingPayload(player, false)).catch(() => undefined);
			break;
		}
		case CONTROL_IDS.LYRICS: {
			ud.liveLyricsEnabled = !ud.liveLyricsEnabled;
			ud.textChannelId = interaction.channelId;
			await interaction.update(buildNowPlayingPayload(player, false)).catch(() => undefined);

			// If user turned on Lyrics and we have unsynced plain lyrics (no karaoke timestamps), send full lyrics ephemerally too
			if (ud.liveLyricsEnabled && player.currentTrack) {
				const cached = ud.cachedLyrics;
				if (cached && !cached.synced && cached.text) {
					await interaction
						.followUp({
							embeds: [buildFullLyricsEmbed(player.currentTrack, cached)],
							flags: MessageFlags.Ephemeral,
						})
						.catch(() => undefined);
				}
			}
			break;
		}
	}
}

export function registerInteractionHandler(engine: ZiMusicBotEngine, actions: MusicCommandActions): void {
	engine.client.on("interactionCreate", async (interaction: Interaction) => {
		try {
			if (interaction.isAutocomplete()) {
				await handleAutocomplete(engine, interaction);
				return;
			}

			if (
				(interaction.isButton() || interaction.isStringSelectMenu()) &&
				interaction.customId.startsWith("zi:")
			) {
				await handleControllerComponent(engine, interaction);
				return;
			}

			if (!interaction.isChatInputCommand()) return;

			const ctx = createSlashContext(interaction);
			if (!ctx) {
				await interaction.reply({
					content: "❌ Lệnh này chỉ có thể sử dụng bên trong máy chủ Discord (Server)!",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			switch (interaction.commandName) {
				case "play":
					await actions.play(
						ctx,
						interaction.options.getString("query") ?? undefined,
						interaction.options.getAttachment("file")?.url,
					);
					break;
				case "playnext":
					await actions.playNext(ctx, interaction.options.getString("query", true));
					break;
				case "tts":
					await actions.tts(ctx, interaction.options.getString("text", true));
					break;
				case "pause":
					await actions.pause(ctx);
					break;
				case "resume":
					await actions.resume(ctx);
					break;
				case "skip":
					await actions.skip(ctx, interaction.options.getInteger("to") ?? undefined);
					break;
				case "previous":
					await actions.previous(ctx);
					break;
				case "stop":
					await actions.stop(ctx);
					break;
				case "leave":
					await actions.leave(ctx);
					break;
				case "nowplaying":
					await actions.nowPlaying(ctx);
					break;
				case "queue":
					await actions.queue(ctx, interaction.options.getInteger("page") ?? 1);
					break;
				case "shuffle":
					await actions.shuffle(ctx);
					break;
				case "loop":
					await actions.loop(ctx, interaction.options.getString("mode", true));
					break;
				case "autoplay":
					await actions.autoPlay(ctx);
					break;
				case "seek":
					await actions.seek(ctx, interaction.options.getString("time", true));
					break;
				case "volume":
					await actions.volume(ctx, interaction.options.getInteger("level") ?? undefined);
					break;
				case "move":
					await actions.move(
						ctx,
						interaction.options.getInteger("from", true),
						interaction.options.getInteger("to", true),
					);
					break;
				case "swap":
					await actions.swap(
						ctx,
						interaction.options.getInteger("first", true),
						interaction.options.getInteger("second", true),
					);
					break;
				case "remove":
					await actions.remove(ctx, interaction.options.getInteger("index", true));
					break;
				case "clear":
					await actions.clear(ctx);
					break;
				case "filter":
					await actions.filter(
						ctx,
						interaction.options.getString("action", true),
						interaction.options.getString("name") ?? undefined,
					);
					break;
				case "lyrics":
					await actions.lyrics(ctx, interaction.options.getString("mode") ?? "show");
					break;
				case "save":
					await actions.save(ctx, interaction.options.getString("filter") ?? undefined);
					break;
				case "mirror":
					await actions.mirror(ctx, interaction.options.getString("leader_guild_id", true));
					break;
				case "stats":
					await actions.stats(ctx);
					break;
				case "help":
					await actions.help(ctx);
					break;
			}
		} catch (err) {
			console.error("[InteractionHandler] Unhandled error:", err);
			if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
				await interaction
					.reply({
						content: "❌ Đã xảy ra lỗi nội bộ khi thực thi lệnh!",
						flags: MessageFlags.Ephemeral,
					})
					.catch(() => undefined);
			}
		}
	});
}
