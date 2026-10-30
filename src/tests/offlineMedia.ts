import SoundCloud from "@zibot/scdl";
import { Innertube } from "youtubei.js";

/** Bot construction eagerly initializes both music providers. Unit tests that
 * do not exercise network playback must not create dozens of live HTTP calls. */
export function mockBackgroundMediaInitialization(): () => void {
	const originalSoundCloudInit = SoundCloud.prototype.init;
	const originalYouTubeCreate = Innertube.create;
	SoundCloud.prototype.init = async function () { /* provider requests are mocked per test */ };
	Innertube.create = async () => ({} as Innertube);
	return () => {
		SoundCloud.prototype.init = originalSoundCloudInit;
		Innertube.create = originalYouTubeCreate;
	};
}
