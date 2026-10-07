/**
 * Turn Kenari catalogue rows into omp model registrations.
 *
 * Two transports are involved, and the split is not cosmetic:
 *
 * - Chat models ride omp's bundled `openai-completions` transport. Kenari is a
 *   plain OpenAI-compatible gateway, so the bundled transport already knows how
 *   to talk to it and the catalogue only has to describe capabilities.
 * - The Jev judgment model speaks TypeSafe's System One protocol
 *   (`POST /v1/systemone`), not chat completions. It is registered on the
 *   `typesafe` api so omp routes judgments natively instead of prompting it.
 */
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { usdPerMillion, type KenariModel, type KenariPlan } from "./client";

/**
 * omp's `ThinkingConfig`/`Effort` types live in `@oh-my-pi/pi-catalog`, which is
 * a transitive dependency of the coding agent rather than a peer of this
 * plugin. Derive them from the registration shape instead of deep-importing a
 * package the plugin does not declare.
 */
type ProviderThinking = NonNullable<ProviderModelConfig["thinking"]>;
type ProviderEffort = ProviderThinking["efforts"][number];

/**
 * Kenari's `reasoning_options` are wire values for `reasoning_effort`, and omp's
 * effort levels use the same spelling for these six. `none` is deliberately
 * absent — it means "do not think", which omp expresses by omitting the field,
 * so listing it as an effort level would offer a phantom choice.
 *
 * omp models effort as a `const enum`, so the wire strings cannot be typed as
 * `Effort` members without importing the catalog package this plugin does not
 * depend on. They are validated against this table instead and asserted once,
 * in {@link thinkingFor}, at the boundary where wire data becomes a capability.
 */
const KNOWN_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Effort levels used when a reasoning model publishes no `reasoning_options`.
 *
 * Such a model reasons unconditionally, so it accepts `reasoning_effort` but
 * advertises no vocabulary for it. Leaving `thinking` unset is not an option:
 * `finalizeCustomModel` then inherits an identity-derived ladder from omp's
 * bundled catalog, which is wrong here — Kenari rejects `minimal` for
 * `mimo-v2-5` and `xhigh` for `glm-4-7-flash:free` with HTTP 400
 * (`upstream_rejected`), so offering those levels turns a normal effort pick
 * into a failed request. `low`/`medium`/`high` were accepted by every such
 * model probed against the live endpoint, so that verified set is pinned
 * instead of an inherited guess.
 */
const DEFAULT_REASONING_LEVELS = ["low", "medium", "high"] as const;

/** Fallback output ceiling when Kenari publishes no completion limit for a model. */
const DEFAULT_MAX_TOKENS = 32_768;

/** Context assumed only if the catalogue omits `context_length` for a chat model. */
const FALLBACK_CONTEXT_WINDOW = 128_000;

/** The one System One model Kenari serves; `jev-latest` and other spellings 404. */
export const KENARI_JUDGE_MODEL_ID = "jev-1-13-free";

/**
 * Effort surface for a catalogue row: `undefined` when the model does not reason
 * at all, the advertised ladder when it publishes one, and the verified default
 * when it reasons without advertising levels.
 */
export function thinkingFor(model: KenariModel): ProviderThinking | undefined {
	if (!model.reasoning) return undefined;
	// Preserve Kenari's ascending order; `KNOWN_EFFORTS` is the validation set,
	// not the ordering source.
	const advertised = model.reasoningOptions.filter(
		(option): option is (typeof KNOWN_EFFORTS)[number] =>
			(KNOWN_EFFORTS as readonly string[]).includes(option),
	);
	const efforts = advertised.length > 0 ? advertised : [...DEFAULT_REASONING_LEVELS];
	return { mode: "effort", efforts: efforts as unknown as ProviderThinking["efforts"] };
}

/** Only text and image inputs have an omp transport; Kenari also lists audio, video and pdf. */
function inputFor(model: KenariModel): ("text" | "image")[] {
	const inputs = model.inputModalities.filter(
		(modality): modality is "text" | "image" => modality === "text" || modality === "image",
	);
	return inputs.length > 0 ? inputs : ["text"];
}

export function toProviderModel(model: KenariModel, idrPerUsd: number): ProviderModelConfig {
	// `reasoning` and `thinking` answer different questions and Kenari's
	// catalogue separates them too: `reasoning: true` means the model thinks at
	// all, `reasoning_options` means the caller can pick a level. A model with
	// the flag but no options (e.g. `qwen3-8-flash`, `mimo-v2-5`) reasons
	// unconditionally, so it must not be reported as non-reasoning.
	const thinking = thinkingFor(model);
	const input = inputFor(model);
	return {
		id: model.id,
		name: model.id,
		api: "openai-completions",
		reasoning: model.reasoning,
		...(thinking ? { thinking } : {}),
		input,
		cost: {
			input: usdPerMillion(model.pricing.input, idrPerUsd),
			output: usdPerMillion(model.pricing.output, idrPerUsd),
			cacheRead: usdPerMillion(model.pricing.cacheRead, idrPerUsd),
			cacheWrite: usdPerMillion(model.pricing.cacheWrite, idrPerUsd),
		},
		contextWindow: model.contextLength ?? FALLBACK_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		// omp's bundled catalog carries a defensive `stripImageInput: true` for
		// some model families (DeepSeek among them) because their first-party
		// endpoints reject `image_url`. Kenari serves those same ids with image
		// input enabled — verified against `deepseek-v4-1-flash`, which answers
		// correctly about a supplied image — so the inherited guard would drop
		// image parts this gateway does accept. The catalogue is the authority
		// for what Kenari routes, so override the guard from it.
		compat: input.includes("image") ? { stripImageInput: false } : undefined,
	};
}

/** Models in the catalogue scheduled to stop being served, soonest first. */
export function scheduledRetirements(models: KenariModel[], nowMs: number): { id: string; sunsetAt: number }[] {
	return models
		.filter((model): model is KenariModel & { sunsetAt: number } => model.sunsetAt !== null && model.sunsetAt * 1000 > nowMs)
		.map(model => ({ id: model.id, sunsetAt: model.sunsetAt }))
		.sort((a, b) => a.sunsetAt - b.sunsetAt);
}

/**
 * Models this plugin exposes, in catalogue order.
 *
 * With `filterPayPerUse` on, a model is kept when it is free or included in the
 * account's *own* plan. Plan membership is per-plan, not per-catalogue: every
 * paid plan lists `claude-sonnet-5`, but `claude-opus-4-7` is in no plan and
 * `gpt-5-6-sol` only in the two top tiers. Filtering against the union of all
 * plans therefore keeps models the account cannot use without paying per token,
 * which is exactly the outcome this filter exists to prevent.
 *
 * `plan` is the account's own plan, already resolved by the caller, or null when
 * it is unknown. An unknown plan keeps everything: hiding a model the account
 * may already pay for is worse than listing one that costs per token.
 */
export function selectKenariModels(
	models: KenariModel[],
	plan: KenariPlan | null,
	filterPayPerUse: boolean,
): KenariModel[] {
	if (!filterPayPerUse || plan === null) return models;
	const included = new Set(plan.scopeModels);
	return models.filter(model => model.free || included.has(model.id));
}

/** The Jev judgment model, registered on the `typesafe` api against Kenari's origin. */
export function judgeModel(): ProviderModelConfig {
	return {
		id: KENARI_JUDGE_MODEL_ID,
		name: "Jev 1.13 (System One)",
		api: "typesafe",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: FALLBACK_CONTEXT_WINDOW,
		maxTokens: 4096,
	};
}
