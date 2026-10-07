/**
 * Kenari account state, resolved once per process and shared by the provider
 * registration, the tools and the `/kenari` command.
 *
 * Everything here degrades: a failed lookup narrows what the plugin knows
 * (plan membership, FX rate, quota) but never blocks registration. The one
 * exception is `/v1/models` itself — without a catalogue there is nothing to
 * register, and the caller reports that instead.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	FALLBACK_IDR_PER_USD,
	KenariClient,
	type KenariModel,
	type KenariPlan,
	type KenariPublicPricing,
	type KenariQuota,
} from "./client";
import { KENARI_JUDGE_MODEL_ID, selectKenariModels, scheduledRetirements, toProviderModel } from "./discovery";

/** Status of one account lookup, so `/kenari` can say what is stale. */
export type LookupState<T> = { ok: true; value: T } | { ok: false; error: string };

export interface KenariSnapshot {
	/** Chat models from `/v1/models`, before plan filtering. */
	catalogue: KenariModel[];
	/** Models actually registered. */
	registered: KenariModel[];
	plan: LookupState<KenariPlan | null>;
	pricing: LookupState<KenariPublicPricing>;
	quota: LookupState<KenariQuota>;
	/** System One ids Kenari currently serves, so a renamed judge is detectable. */
	systemOneIds: LookupState<string[]>;
}

function failure(error: unknown): { ok: false; error: string } {
	return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** Resolve the live FX rate, falling back to the documented constant. */
async function resolvePricing(client: KenariClient): Promise<LookupState<KenariPublicPricing>> {
	try {
		return { ok: true, value: await client.publicPricing() };
	} catch (error) {
		return failure(error);
	}
}

async function resolvePlan(
	client: KenariClient,
	quota: LookupState<KenariQuota>,
): Promise<LookupState<KenariPlan | null>> {
	if (!quota.ok) return { ok: false, error: quota.error };
	// Without an account plan the membership set is unknown, so the caller keeps
	// every model rather than guessing which plan applies.
	if (quota.value.planName === null) return { ok: true, value: null };
	try {
		const plans = await client.listPlans();
		return { ok: true, value: plans.find(plan => plan.name === quota.value.planName) ?? null };
	} catch (error) {
		return failure(error);
	}
}

/**
 * Read the account state and the catalogue in one pass.
 *
 * The three auxiliary lookups run concurrently: they are independent, and the
 * model list is the only one whose failure is fatal to registration.
 */
export async function loadKenariSnapshot(
	client: KenariClient,
	filterPayPerUse: boolean,
	logger: ExtensionAPI["logger"],
): Promise<KenariSnapshot> {
	const [models, pricing, quota, systemOneIds] = await Promise.all([
		client.listModels(),
		resolvePricing(client),
		client.quota().then(
			value => ({ ok: true as const, value }),
			error => failure(error),
		),
		client.listSystemOneIds().then(
			value => ({ ok: true as const, value }),
			error => failure(error),
		),
	]);
	const plan = await resolvePlan(client, quota);
	const catalogue = models.filter(model => model.endpoints.includes("chat"));
	const registered = selectKenariModels(catalogue, plan.ok ? plan.value : null, filterPayPerUse);

	if (!quota.ok) logger.warn("Kenari quota lookup failed; listing every chat model", { error: quota.error });
	if (!pricing.ok) logger.warn("Kenari pricing lookup failed; using fallback FX rate", { error: pricing.error });
	// A renamed System One model would silently break the judge role, so the
	// pinned id is checked against the live roster instead of assumed.
	if (systemOneIds.ok && !systemOneIds.value.includes(KENARI_JUDGE_MODEL_ID)) {
		logger.warn("Kenari no longer serves the pinned judge model", {
			pinned: KENARI_JUDGE_MODEL_ID,
			served: systemOneIds.value,
		});
	}
	const retiring = scheduledRetirements(catalogue, Date.now());
	if (retiring.length > 0) logger.warn("Kenari models scheduled to retire", { models: retiring });

	return { catalogue, registered, plan, pricing, quota, systemOneIds };
}

/** Effective IDR-per-USD rate for cost conversion. */
export function effectiveRate(pricing: LookupState<KenariPublicPricing>): number {
	return pricing.ok && pricing.value.usdIdrRate > 0 ? pricing.value.usdIdrRate : FALLBACK_IDR_PER_USD;
}

/** Provider registrations for the resolved catalogue. */
export function modelsFor(snapshot: KenariSnapshot, pricing: LookupState<KenariPublicPricing>) {
	const rate = effectiveRate(pricing);
	return snapshot.registered.map(model => toProviderModel(model, rate));
}
