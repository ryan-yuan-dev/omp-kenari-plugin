/**
 * Kenari HTTP surface.
 *
 * Every method is a thin wrapper over one endpoint; the callers decide what a
 * failure means. Discovery failures degrade (an unfiltered catalogue is better
 * than none), while tool calls surface the error to the model, so the error
 * text carries the status and the provider's own message.
 */

export const KENARI_ORIGIN = "https://kenari.id";

/** Chat-completions base URL registered with omp (the transport appends `/chat/completions`). */
export const KENARI_CHAT_BASE_URL = `${KENARI_ORIGIN}/v1`;

/**
 * Judge base URL. `TypeSafeJudge` appends its own route (`/v1/systemone`), so
 * this must stay origin-only — a `/v1` here yields `/v1/v1/systemone`.
 */
export const KENARI_JUDGE_BASE_URL = KENARI_ORIGIN;

/** Bounds one discovery request; the registry also caps `fetchDynamicModels` overall. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Tool calls run user-visible work, so they get a longer leash than discovery. */
const TOOL_TIMEOUT_MS = 120_000;

/** Fallback IDR-per-USD rate; `/api/public/pricing` publishes the live one. */
export const FALLBACK_IDR_PER_USD = 17_500;

/** Kenari quotes prices in whole rupiah scaled by one million. */
const MICRO_PER_IDR = 1_000_000;

/** Per-million-token prices exactly as Kenari quotes them (micro-IDR). */
export interface KenariPricing {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Parsed row of `GET /v1/models`, limited to the fields this plugin consumes. */
export interface KenariModel {
	id: string;
	contextLength: number | null;
	/** Serving modes the id is exposed on; only `chat` is reachable through the registered API. */
	endpoints: string[];
	inputModalities: string[];
	/** Whether the model emits reasoning content at all. */
	reasoning: boolean;
	/** Wire values accepted as `reasoning_effort`, ascending. Empty when the model takes none. */
	reasoningOptions: string[];
	/** True when the model costs nothing regardless of plan. */
	free: boolean;
	/** Prices in micro-IDR; convert with {@link usdPerMillion}. */
	pricing: KenariPricing;
	/** Epoch seconds when Kenari stops serving this id, or null when nothing is scheduled. */
	sunsetAt: number | null;
}

/** Parsed row of `GET /api/plans`. */
export interface KenariPlan {
	id: string;
	/** Display name, the only handle `GET /v1/account/quota` reports back. */
	name: string | null;
	/** Model ids included at no per-token charge. */
	scopeModels: string[];
	/**
	 * This plan's own daily allowance for `:free` models, or null when the plan
	 * sets none and the subscription-wide default applies. Counted separately
	 * from the paid quota windows.
	 */
	freeDailyQuota: number | null;
}

/** Remaining and consumed Rupiah for one quota window. */
export interface KenariQuotaWindow {
	remainingIdr: number;
	usedIdr: number;
	resetsAt: string | null;
}

export interface KenariQuota {
	planName: string | null;
	month: KenariQuotaWindow | null;
	week: KenariQuotaWindow | null;
}

export interface KenariSearchResult {
	title: string;
	url: string;
	content: string;
}

export interface KenariFetchedPage {
	title: string;
	content: string;
	links: string[];
}

export interface KenariRerankHit {
	index: number;
	relevanceScore: number;
}

/** Rate limits for the `:free` model lane: requests/minute and requests/day. */
export interface KenariFreeTierRate {
	rpm: number | null;
	daily: number | null;
}

/**
 * Free-lane limits, split by account state.
 *
 * These are three separate tiers, not one figure with overrides: a brand-new
 * account gets `base`, topping up past `thresholdIdr` unlocks `toppedUp`, and an
 * active subscription uses `subscriber`. Reporting `base` to a subscriber
 * understates their limit by 3x on RPM, so the caller must pick by account
 * state rather than printing the first tier.
 */
export interface KenariFreeTier {
	base: KenariFreeTierRate;
	toppedUp: KenariFreeTierRate;
	subscriber: KenariFreeTierRate;
	/** Balance in Rupiah past which `toppedUp` replaces `base`. */
	thresholdIdr: number | null;
}

/** Public pricing feed: the live FX rate and the free-tier allowance. */
export interface KenariPublicPricing {
	usdIdrRate: number;
	freeTier: KenariFreeTier;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Convert a micro-IDR per-million-token price into USD per million tokens. */
export function usdPerMillion(microIdr: number, idrPerUsd: number): number {
	if (microIdr <= 0 || idrPerUsd <= 0) return 0;
	return microIdr / MICRO_PER_IDR / idrPerUsd;
}

function parsePricing(raw: unknown, free: boolean): KenariPricing {
	if (free) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const pricing = asRecord(raw) ?? {};
	const rate = (key: string): number => Math.max(0, asFiniteNumber(pricing[key]) ?? 0);
	return {
		input: rate("input"),
		output: rate("output"),
		cacheRead: rate("cache_read"),
		cacheWrite: rate("cache_write"),
	};
}

function parseModel(value: unknown): KenariModel | null {
	const raw = asRecord(value);
	if (!raw || typeof raw.id !== "string" || raw.id.length === 0) return null;
	const free = asRecord(raw.pricing)?.free === true || raw.id.endsWith(":free");
	return {
		id: raw.id,
		contextLength: asFiniteNumber(raw.context_length),
		endpoints: asStringArray(raw.endpoints),
		inputModalities: asStringArray(asRecord(raw.modalities)?.input),
		reasoning: raw.reasoning === true,
		reasoningOptions: asStringArray(raw.reasoning_options),
		free,
		pricing: parsePricing(raw.pricing, free),
		sunsetAt: asFiniteNumber(raw.sunset_at),
	};
}

function parsePlan(value: unknown): KenariPlan | null {
	const raw = asRecord(value);
	if (!raw || typeof raw.id !== "string" || raw.id.length === 0) return null;
	const name = raw.name;
	return {
		id: raw.id,
		name: typeof name === "string" && name.length > 0 ? name : null,
		scopeModels: asStringArray(raw.scope_models),
		freeDailyQuota: asFiniteNumber(raw.free_daily_quota),
	};
}

function parseQuotaWindow(value: unknown): KenariQuotaWindow | null {
	const raw = asRecord(value);
	if (!raw) return null;
	const resetsAt = raw.resets_at;
	return {
		remainingIdr: asFiniteNumber(raw.remaining_rp) ?? 0,
		usedIdr: asFiniteNumber(raw.used_rp) ?? 0,
		resetsAt: typeof resetsAt === "string" ? resetsAt : null,
	};
}

export class KenariClient {
	readonly #apiKey: string | undefined;

	constructor(apiKey: string | undefined) {
		this.#apiKey = apiKey?.trim() ? apiKey.trim() : undefined;
	}

	get hasApiKey(): boolean {
		return this.#apiKey !== undefined;
	}

	/** Full catalogue, including ids this plugin does not register (image, speech, video). */
	async listModels(): Promise<KenariModel[]> {
		const payload = await this.#request("GET", "/v1/models");
		const rows = asRecord(payload)?.data;
		if (!Array.isArray(rows)) return [];
		return rows.map(parseModel).filter((model): model is KenariModel => model !== null);
	}

	/**
	 * Subscription plans, used only to separate plan-included models from
	 * pay-per-use ones. Requires the bearer token; throws so the caller records
	 * plan membership as unknown rather than assuming it.
	 */
	async listPlans(): Promise<KenariPlan[]> {
		const payload = await this.#request("GET", "/api/plans", { authenticated: true });
		if (!Array.isArray(payload)) throw new Error("Kenari /api/plans returned an unexpected payload");
		return payload.map(parsePlan).filter((plan): plan is KenariPlan => plan !== null);
	}

	/**
	 * Plan, remaining quota and reset times for the key's account.
	 *
	 * This is what makes plan-scoped filtering correct: `/api/plans` lists every
	 * sellable plan, so filtering against their union would keep models the
	 * account cannot use without paying per token — `claude-opus-4-7` is in no
	 * plan at all, while `claude-sonnet-5` is in every plan. Only the account's
	 * own plan says which of the per-plan sets applies.
	 */
	async quota(): Promise<KenariQuota> {
		const payload = asRecord(await this.#request("GET", "/v1/account/quota", { authenticated: true })) ?? {};
		const plan = asRecord(payload.plan);
		const windows = asRecord(plan?.windows);
		const name = plan?.name;
		return {
			planName: typeof name === "string" && name.length > 0 ? name : null,
			month: parseQuotaWindow(windows?.month),
			week: parseQuotaWindow(windows?.week),
		};
	}

	/** Live FX rate and free-tier allowance. Public; no credential required. */
	async publicPricing(): Promise<KenariPublicPricing> {
		const payload = asRecord(await this.#request("GET", "/api/public/pricing")) ?? {};
		const free = asRecord(payload.free_tier) ?? {};
		const rate = (source: Record<string, unknown>): KenariFreeTierRate => ({
			rpm: asFiniteNumber(source.rpm),
			daily: asFiniteNumber(source.daily),
		});
		return {
			usdIdrRate: asFiniteNumber(payload.usd_idr_rate) ?? FALLBACK_IDR_PER_USD,
			freeTier: {
				base: rate(free),
				toppedUp: rate(asRecord(free.next) ?? {}),
				subscriber: rate(asRecord(free.plan) ?? {}),
				thresholdIdr: asFiniteNumber(free.threshold_idr),
			},
		};
	}

	/** Live web search. Billed to the account's balance. */
	async search(query: string, maxResults: number): Promise<KenariSearchResult[]> {
		const payload = asRecord(
			await this.#request("POST", "/v1/web/search", { authenticated: true, body: { query, max_results: maxResults } }),
		);
		const results = payload?.results;
		if (!Array.isArray(results)) return [];
		return results.flatMap(item => {
			const row = asRecord(item);
			if (!row || typeof row.url !== "string") return [];
			return [
				{
					title: typeof row.title === "string" ? row.title : row.url,
					url: row.url,
					content: typeof row.content === "string" ? row.content : "",
				},
			];
		});
	}

	/** Fetch one URL as clean text. Billed to the account's balance. */
	async fetchPage(url: string): Promise<KenariFetchedPage> {
		const payload = asRecord(
			await this.#request("POST", "/v1/web/fetch", { authenticated: true, body: { url } }),
		) ?? {};
		return {
			title: typeof payload.title === "string" ? payload.title : "",
			content: typeof payload.content === "string" ? payload.content : "",
			links: asStringArray(payload.links),
		};
	}

	/** Embeddings. Returns one vector per input string. */
	async embed(model: string, input: string[]): Promise<number[][]> {
		const payload = asRecord(
			await this.#request("POST", "/v1/embeddings", { authenticated: true, body: { model, input } }),
		);
		const rows = payload?.data;
		if (!Array.isArray(rows)) throw new Error("Kenari /v1/embeddings returned no data");
		return rows.map(row => {
			const embedding = asRecord(row)?.embedding;
			if (!Array.isArray(embedding)) throw new Error("Kenari /v1/embeddings returned a malformed vector");
			return embedding.filter((value): value is number => typeof value === "number");
		});
	}

	/** Rerank documents against a query, best first. */
	async rerank(model: string, query: string, documents: string[], topN: number | undefined): Promise<KenariRerankHit[]> {
		const body: Record<string, unknown> = { model, query, documents };
		if (topN !== undefined) body.top_n = topN;
		const payload = asRecord(await this.#request("POST", "/v1/rerank", { authenticated: true, body }));
		const results = payload?.results;
		if (!Array.isArray(results)) return [];
		return results.flatMap(item => {
			const row = asRecord(item);
			const index = asFiniteNumber(row?.index);
			if (row === undefined || index === null) return [];
			return [{ index, relevanceScore: asFiniteNumber(row.relevance_score) ?? 0 }];
		});
	}

	/**
	 * System One judge model ids. Bare `/v1/models` lists chat models only, so
	 * the judge roster needs the explicit modality filter; used to detect drift
	 * from the id this plugin registers.
	 */
	async listSystemOneIds(): Promise<string[]> {
		const payload = await this.#request("GET", "/v1/models?modality=systemone");
		const rows = asRecord(payload)?.data;
		if (!Array.isArray(rows)) return [];
		return rows.flatMap(row => {
			const id = asRecord(row)?.id;
			return typeof id === "string" ? [id] : [];
		});
	}

	async #request(
		method: "GET" | "POST",
		path: string,
		options: { authenticated?: boolean; body?: unknown } = {},
	): Promise<unknown> {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (options.authenticated) {
			if (!this.#apiKey) throw new Error(`Kenari ${path} requires ${"KENARI_API_KEY"} to be set`);
			headers.Authorization = `Bearer ${this.#apiKey}`;
		}
		let body: string | undefined;
		if (options.body !== undefined) {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify(options.body);
		}
		const response = await fetch(`${KENARI_ORIGIN}${path}`, {
			method,
			headers,
			...(body === undefined ? {} : { body }),
			signal: AbortSignal.timeout(method === "POST" ? TOOL_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			// The provider's own message is more useful than the status alone
			// ("insufficient_balance" vs. a bare 402).
			const detail = await response.text().catch(() => "");
			throw new Error(`Kenari ${path} failed: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ""}`);
		}
		return await response.json();
	}
}

/** Credential this plugin is configured with, read from the environment. */
export function readKenariApiKey(env: Record<string, string | undefined> = process.env): string | undefined {
	const value = env.KENARI_API_KEY?.trim();
	return value ? value : undefined;
}
