/**
 * Kenari provider plugin for the omp coding agent.
 *
 * Setting `KENARI_API_KEY` is the whole configuration: the extension imports
 * Kenari's live chat catalogue, points the `judge` model role at Kenari's Jev
 * System One endpoint, and adds tools for the capabilities a provider
 * registration cannot reach (web search, fetch, embeddings, rerank).
 *
 * Provider registration happens during extension load, which is when omp drains
 * `registerProvider` calls into the model registry. The dynamic catalogue is
 * fetched later, by the registry, through `fetchDynamicModels`.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { effectiveRate, loadKenariSnapshot, modelsFor, type KenariSnapshot } from "./account";
import { KENARI_CHAT_BASE_URL, KENARI_JUDGE_BASE_URL, KenariClient, readKenariApiKey } from "./client";
import { KENARI_JUDGE_MODEL_ID, judgeModel } from "./discovery";
import { loadKenariSettings } from "./settings";
import { registerKenariTools } from "./tools";

/** Env var omp resolves for both Kenari providers. */
const KENARI_API_KEY_ENV = "KENARI_API_KEY";

/** Judge selector installed when the role is unconfigured. */
const KENARI_JUDGE_ROLE_VALUE = `kenari-judge/${KENARI_JUDGE_MODEL_ID}`;

function idr(amount: number): string {
	return `Rp ${Math.round(amount).toLocaleString("id-ID")}`;
}

/**
 * Point the `judge` role at Kenari's Jev model, but only when the user has not
 * chosen a judge themselves.
 *
 * `overrideModelRoles` writes a runtime override — never persisted — so this
 * behaves as a better default rather than a config edit. An explicitly
 * configured role (from `config.yml`, the project, or a CLI flag) is left
 * alone: silently redirecting a judge the user picked would change which model
 * grades their work.
 *
 * The role is also skipped without a credential, since the Kenari judge cannot
 * authenticate and would displace a working default (TypeSafe's own `jev-latest`
 * or the `@tiny` fallback) with a candidate that always fails.
 */
async function applyJudgeRole(pi: ExtensionAPI): Promise<void> {
	const pending = pi.pi.Settings.current;
	if (!pending) {
		pi.logger.debug("Kenari judge role skipped: settings not initialized");
		return;
	}
	const settings = await pending;
	if (settings.getModelRoleProvenance("judge") !== "default") return;
	settings.overrideModelRoles({ judge: KENARI_JUDGE_ROLE_VALUE });
	pi.logger.debug("Kenari judge role installed", { judge: KENARI_JUDGE_ROLE_VALUE });
}

/** One-line account summary shared by the `/kenari` command and the startup notice. */
function describeAccount(snapshot: KenariSnapshot): string {
	const plan = snapshot.quota.ok && snapshot.quota.value.planName ? snapshot.quota.value.planName : "no active plan";
	const parts = [`plan ${plan}`, `${snapshot.registered.length}/${snapshot.catalogue.length} models`];
	if (snapshot.quota.ok && snapshot.quota.value.month) {
		const month = snapshot.quota.value.month;
		parts.push(`month ${idr(month.remainingIdr)} left`);
	}
	return parts.join(" · ");
}

/**
 * Free-lane limit that actually applies to this account.
 *
 * The three published tiers are mutually exclusive states, not additive: a
 * subscriber uses `subscriber`, everyone else `base` until they top up past
 * `thresholdIdr`. Printing the base tier to a subscriber understates their
 * allowance by 3x on RPM.
 *
 * The topped-up tier is deliberately NOT selected on absence of a plan: the
 * balance needed to decide it is not exposed by any endpoint this plugin may
 * call, so claiming it would be a guess. The base figures are reported with the
 * threshold stated instead.
 */
function applicableFreeTier(snapshot: KenariSnapshot): { label: string; rpm: number | null; daily: number | null } {
	if (!snapshot.pricing.ok) return { label: "unknown", rpm: null, daily: null };
	const tier = snapshot.pricing.value.freeTier;
	const subscribed = snapshot.quota.ok && snapshot.quota.value.planName !== null;
	return subscribed ? { label: "subscriber", ...tier.subscriber } : { label: "base", ...tier.base };
}

/** Whether the account's free-lane tier is the subscriber one. */
function isSubscriber(snapshot: KenariSnapshot): boolean {
	return snapshot.quota.ok && snapshot.quota.value.planName !== null;
}

/** Multi-line detail for the `/kenari` command. */
function describeDetail(snapshot: KenariSnapshot): string {
	const lines: string[] = [];
	const quota = snapshot.quota;
	if (!quota.ok) {
		lines.push(`quota: unavailable (${quota.error})`);
	} else {
		lines.push(`plan: ${quota.value.planName ?? "none"}`);
		for (const [label, window] of [
			["month", quota.value.month],
			["week", quota.value.week],
		] as const) {
			if (!window) continue;
			const resets = window.resetsAt ? `, resets ${new Date(window.resetsAt).toISOString()}` : "";
			lines.push(`  ${label}: ${idr(window.remainingIdr)} left of ${idr(window.remainingIdr + window.usedIdr)}${resets}`);
		}
		// A window Kenari omits is unlimited, not missing — the docs state that
		// zero means unlimited for that window.
		if (quota.value.planName !== null && quota.value.month === null && quota.value.week === null) {
			lines.push("  no finite quota windows (unlimited)");
		}
	}
	if (snapshot.plan.ok && snapshot.plan.value) {
		lines.push(`in-plan models: ${snapshot.plan.value.scopeModels.length}`);
	} else if (snapshot.plan.ok) {
		lines.push("in-plan models: unknown (no matching plan)");
	} else {
		lines.push(`in-plan models: unknown (${snapshot.plan.error})`);
	}
	lines.push(
		snapshot.pricing.ok
			? `fx rate: ${snapshot.pricing.value.usdIdrRate} IDR/USD (live)`
			: `fx rate: fallback (${snapshot.pricing.error})`,
	);
	const free = applicableFreeTier(snapshot);
	if (free.rpm === null && free.daily === null) {
		lines.push(`free lane (${free.label}): unavailable`);
	} else {
		const perMinute = free.rpm === null ? "?" : `${free.rpm}/min`;
		const perDay = free.daily === null || free.daily === 0 ? "plan default" : `${free.daily}/day`;
		lines.push(`free lane (${free.label}): ${perMinute}, ${perDay}`);
	}
	if (!isSubscriber(snapshot) && snapshot.pricing.ok) {
		// The topped-up tier exists but its trigger (balance past the threshold)
		// is not readable, so state the rule rather than assert the tier.
		const higher = snapshot.pricing.value.freeTier.toppedUp;
		const threshold = snapshot.pricing.value.freeTier.thresholdIdr;
		if (higher.rpm !== null && threshold !== null) {
			lines.push(`  topping up past ${idr(threshold)} raises this to ${higher.rpm}/min`);
		}
	}
	if (snapshot.plan.ok && snapshot.plan.value?.freeDailyQuota) {
		lines.push(`  plan free quota: ${snapshot.plan.value.freeDailyQuota}/day`);
	}
	lines.push(
		snapshot.systemOneIds.ok
			? `system one: ${snapshot.systemOneIds.value.join(", ") || "(none)"}`
			: `system one: unavailable (${snapshot.systemOneIds.error})`,
	);
	return lines.join("\n");
}

export default async function kenariExtension(pi: ExtensionAPI): Promise<void> {
	const apiKey = readKenariApiKey();
	const settings = await loadKenariSettings(process.cwd());

	// The judge provider is registered even without a key: omp resolves
	// KENARI_API_KEY from the provider config itself, so exporting it later in
	// the process still authenticates judgments.
	if (settings.autoJudge) {
		pi.registerProvider("kenari-judge", {
			baseUrl: KENARI_JUDGE_BASE_URL,
			api: "typesafe",
			apiKey: KENARI_API_KEY_ENV,
			models: [judgeModel()],
		});
		if (apiKey !== undefined) await applyJudgeRole(pi);
	}

	if (apiKey === undefined) {
		// Registration is keyed on the environment rather than left to the
		// registry's own unauthenticated check: the credential is also what the
		// tools and `/kenari` need, so its absence is reported once, here.
		pi.logger.warn(`${KENARI_API_KEY_ENV} is not set; Kenari catalogue and tools are unavailable`);
		return;
	}

	const client = new KenariClient(apiKey);
	// The snapshot is memoized so the provider fetch and `/kenari` share one set
	// of lookups. It is deliberately not cached across the process lifetime:
	// `omp models refresh` reloads the extension, and a long session should not
	// hold a stale plan.
	let snapshotPromise: Promise<KenariSnapshot> | undefined;
	const snapshot = (): Promise<KenariSnapshot> => (snapshotPromise ??= loadKenariSnapshot(client, settings.filterPayPerUse, pi.logger));

	if (settings.discoveryEnabled) {
		pi.registerProvider("kenari", {
			baseUrl: KENARI_CHAT_BASE_URL,
			api: "openai-completions",
			apiKey: KENARI_API_KEY_ENV,
			fetchDynamicModels: async () => {
				const resolved = await snapshot();
				pi.logger.debug("Kenari catalogue imported", {
					listed: resolved.catalogue.length,
					registered: resolved.registered.length,
					plan: resolved.plan.ok ? (resolved.plan.value?.name ?? "(none)") : "(unknown)",
					fx: effectiveRate(resolved.pricing),
				});
				return modelsFor(resolved, resolved.pricing);
			},
		});
	}

	if (settings.toolsEnabled) registerKenariTools(pi);

	pi.registerCommand("kenari", {
		description: "Show Kenari account status: plan, quota, FX rate and model counts",
		handler: async (_args, ctx) => {
			try {
				const resolved = await snapshot();
				ctx.ui.notify(`${describeAccount(resolved)}\n\n${describeDetail(resolved)}`, "info");
			} catch (error) {
				ctx.ui.notify(`Kenari status unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	if (settings.startupNotice) {
		pi.on("session_start", async (_event, ctx) => {
			try {
				const resolved = await snapshot();
				ctx.ui.notify(`Kenari: ${describeAccount(resolved)}`, "info");
			} catch (error) {
				ctx.ui.notify(`Kenari: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		});
	}
}
