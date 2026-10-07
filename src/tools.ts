/**
 * Kenari's non-chat capabilities, exposed as omp tools.
 *
 * These ride endpoints the provider registration cannot reach: omp has no
 * extension seam for a `web`-role search backend, and an extension cannot
 * register a non-chat model kind (see AGENTS.md). Tools are the supported route
 * for both, so the plugin offers them explicitly rather than silently omitting
 * the capability.
 *
 * Every tool resolves the credential through omp's registry rather than reading
 * the environment, so a key configured in `config.yml` works identically to one
 * exported in the shell.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { KenariClient } from "./client";

/** Embedding ids Kenari serves; the catalogue's `?modality=embedding` set. */
const EMBEDDING_MODELS = ["bge-m3", "qwen3-embedding-0.6b", "text-embedding-3-large", "text-embedding-3-small"];
const DEFAULT_EMBEDDING_MODEL = "bge-m3";

/** Reranker ids Kenari serves; the catalogue's `?modality=rerank` set. */
const RERANK_MODELS = ["bge-reranker-base"];
const DEFAULT_RERANK_MODEL = "bge-reranker-base";

/** Cap on returned text so a tool result cannot flood the context window. */
const MAX_FETCH_CHARS = 40_000;
const MAX_SEARCH_CONTENT_CHARS = 1_200;

/**
 * Resolve the Kenari credential for a tool call.
 *
 * `modelRegistry.getApiKey` walks omp's credential layers (config, env, store)
 * for the `kenari` provider, which is registered with
 * `apiKey: "KENARI_API_KEY"`. Falls back to the environment when the registry
 * has no Kenari model registered — `discoveryEnabled: false` removes the chat
 * provider, but the tools still work from the raw key.
 */
async function resolveClient(ctx: ExtensionContext): Promise<KenariClient> {
	const model = ctx.modelRegistry
		.getAvailable()
		.find(candidate => candidate.provider === "kenari" || candidate.provider === "kenari-judge");
	const fromRegistry = model ? await ctx.modelRegistry.getApiKey(model, ctx.sessionManager.getSessionId()) : undefined;
	return new KenariClient(fromRegistry ?? process.env.KENARI_API_KEY);
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

function oneLine(value: string, max: number): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

// Parameter shapes are named explicitly: omp injects its zod shim as a loosely
// typed module, so `Static<typeof schema>` collapses to `unknown` and the
// `execute` callbacks would lose every field.
interface SearchParams {
	query: string;
	maxResults?: number;
}
interface FetchParams {
	url: string;
}
interface EmbedParams {
	input: string[];
	model?: string;
}
interface RerankParams {
	query: string;
	documents: string[];
	model?: string;
	topN?: number;
}

/** Register the search, fetch, embedding and rerank tools. */
export function registerKenariTools(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "kenari_search",
		label: "Kenari Search",
		description:
			"Search the live web through Kenari and return ranked result titles, URLs and snippets. Use it when the answer depends on current information the local workspace does not contain.",
		parameters: z.object({
			query: z.string().describe("Search query."),
			maxResults: z.number().int().min(1).max(10).optional().describe("Number of results (1-10, default 5)."),
		}),
		approval: "read",
		async execute(_id: string, params: SearchParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			signal?.throwIfAborted();
			const client = await resolveClient(ctx);
			const results = await client.search(params.query, params.maxResults ?? 5);
			if (results.length === 0) return textResult(`No results for ${JSON.stringify(params.query)}.`);
			const body = results
				.map((result, index) => {
					const snippet = oneLine(result.content, MAX_SEARCH_CONTENT_CHARS);
					return `${index + 1}. ${result.title}\n   ${result.url}${snippet ? `\n   ${snippet}` : ""}`;
				})
				.join("\n\n");
			return textResult(`${results.length} result(s) for ${JSON.stringify(params.query)}:\n\n${body}`);
		},
	});

	pi.registerTool({
		name: "kenari_fetch",
		label: "Kenari Fetch",
		description:
			"Fetch one URL through Kenari and return its main content as clean Markdown, with the page title and outbound links. Prefer it over raw HTTP when a page is script-rendered or the HTML is noisy.",
		parameters: z.object({
			url: z.string().describe("Absolute URL to fetch."),
		}),
		approval: "read",
		async execute(_id: string, params: FetchParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			signal?.throwIfAborted();
			const client = await resolveClient(ctx);
			const page = await client.fetchPage(params.url);
			const truncated = page.content.length > MAX_FETCH_CHARS;
			const content = truncated ? `${page.content.slice(0, MAX_FETCH_CHARS)}\n\n[truncated]` : page.content;
			const header = page.title ? `# ${page.title}\nURL: ${params.url}\n\n` : `URL: ${params.url}\n\n`;
			const links = page.links.length > 0 ? `\n\nLinks:\n${page.links.slice(0, 50).join("\n")}` : "";
			return textResult(`${header}${content}${links}`);
		},
	});

	pi.registerTool({
		name: "kenari_embed",
		label: "Kenari Embed",
		description:
			"Embed text into vectors through Kenari. Returns the model, vector count and dimensions, plus the leading values of the first vector — enough to sanity-check similarity work without dumping whole vectors into context.",
		parameters: z.object({
			input: z.array(z.string()).min(1).describe("Texts to embed, in order."),
			model: z.string().optional().describe(`Embedding model. One of: ${EMBEDDING_MODELS.join(", ")}.`),
		}),
		approval: "read",
		async execute(_id: string, params: EmbedParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			signal?.throwIfAborted();
			const client = await resolveClient(ctx);
			const model = params.model ?? DEFAULT_EMBEDDING_MODEL;
			const vectors = await client.embed(model, params.input);
			const dims = vectors[0]?.length ?? 0;
			const preview = vectors[0]?.slice(0, 8).map(value => value.toFixed(4)).join(", ") ?? "";
			return textResult(
				`model: ${model}\nvectors: ${vectors.length}\ndimensions: ${dims}\nvector[0][0:8]: [${preview}${dims > 8 ? ", …" : ""}]`,
			);
		},
	});

	pi.registerTool({
		name: "kenari_rerank",
		label: "Kenari Rerank",
		description:
			"Rerank candidate documents by relevance to a query through Kenari, best first. Use it to order search or grep hits before reading them.",
		parameters: z.object({
			query: z.string().describe("Query the documents are judged against."),
			documents: z.array(z.string()).min(1).describe("Candidate documents, in their original order."),
			model: z.string().optional().describe(`Rerank model. One of: ${RERANK_MODELS.join(", ")}.`),
			topN: z.number().int().min(1).optional().describe("Return only the best N."),
		}),
		approval: "read",
		async execute(_id: string, params: RerankParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			signal?.throwIfAborted();
			const client = await resolveClient(ctx);
			const model = params.model ?? DEFAULT_RERANK_MODEL;
			const hits = await client.rerank(model, params.query, params.documents, params.topN);
			if (hits.length === 0) return textResult("No reranked results.");
			const body = hits
				.map(hit => {
					const document = params.documents[hit.index] ?? "(missing)";
					return `${hit.index}  score=${hit.relevanceScore.toFixed(4)}  ${oneLine(document, 200)}`;
				})
				.join("\n");
			return textResult(`model: ${model}\nranked (original index, score, preview):\n${body}`);
		},
	});
}
