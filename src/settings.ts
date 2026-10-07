/**
 * Plugin settings.
 *
 * omp stores plugin settings in its own runtime config keyed by package name,
 * and exposes them through the plugin loader's `getPluginSettings` — the same
 * function `omp plugin config` reads and writes. The schema lives in
 * `package.json#omp.settings` so `omp plugin config list omp-kenari` renders
 * defaults and descriptions from the manifest.
 */
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";

/** Must match the package name; the runtime config is keyed by it. */
export const PLUGIN_NAME = "omp-kenari";

export interface KenariSettings {
	/** Register the live chat catalogue from `/v1/models`. */
	discoveryEnabled: boolean;
	/** Hide chat models that are neither free nor included in a subscription plan. */
	filterPayPerUse: boolean;
	/** Point the `judge` model role at Kenari's Jev endpoint when that role is unconfigured. */
	autoJudge: boolean;
	/** Register the `kenari_search`, `kenari_fetch`, `kenari_embed` and `kenari_rerank` tools. */
	toolsEnabled: boolean;
	/** Show a one-line Kenari account summary when a session starts. */
	startupNotice: boolean;
}

export const KENARI_SETTING_DEFAULTS: KenariSettings = {
	discoveryEnabled: true,
	filterPayPerUse: true,
	autoJudge: true,
	toolsEnabled: true,
	startupNotice: true,
};

/** Effective settings for `cwd`; project overrides win over global ones. */
export async function loadKenariSettings(cwd: string): Promise<KenariSettings> {
	const stored = await getPluginSettings(PLUGIN_NAME, cwd);
	const flag = (key: keyof KenariSettings): boolean => {
		const value = stored[key];
		return typeof value === "boolean" ? value : KENARI_SETTING_DEFAULTS[key];
	};
	return {
		discoveryEnabled: flag("discoveryEnabled"),
		filterPayPerUse: flag("filterPayPerUse"),
		autoJudge: flag("autoJudge"),
		toolsEnabled: flag("toolsEnabled"),
		startupNotice: flag("startupNotice"),
	};
}
