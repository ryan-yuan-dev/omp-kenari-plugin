/**
 * End-to-end smoke run against the live Kenari API.
 *
 * Loads this plugin through omp's own extension loader and model registry, then
 * exercises every path it installs: the discovered chat catalogue, a real chat
 * completion through omp's transport, and a judgment routed via the `judge`
 * role. Run with:
 *
 *   KENARI_API_KEY=... bun test/smoke.ts
 *
 * Not part of `bun test` — it needs the network and a credential. Point HOME at
 * a throwaway directory to keep the developer's own config out of the run; the
 * model cache is keyed by provider, so a stale entry must be deleted when
 * changing catalogue-shaping settings.
 */
import * as path from "node:path";
import { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { sendsImageInputOnWire } from "@oh-my-pi/pi-ai/providers/vision-guard";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { resolveJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import { discoverAuthStorage, loadCliExtensionProviders, loadSessionExtensions } from "@oh-my-pi/pi-coding-agent/sdk";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const cwd = path.resolve(import.meta.dir, "..");
const extensionPath = path.join(cwd, "src/index.ts");
const CHAT_MODEL_ID = "deepseek-v4-1-flash";
const PAY_PER_USE_MODEL_ID = "claude-opus-4-7";

const settings = await Settings.init({ cwd });
const authStorage = await discoverAuthStorage(undefined, { settings });
const registry = new ModelRegistry(authStorage, undefined, { settings });

await registry.refresh("offline");
await loadCliExtensionProviders(registry, settings, cwd, { additionalExtensionPaths: [extensionPath] });

const available = registry.getAvailable();
const kenari = available.filter(model => model.provider === "kenari");
const judgeModels = available.filter(model => model.provider === "kenari-judge");

console.log(`kenari models:       ${kenari.length}`);
console.log(`kenari-judge models: ${judgeModels.map(model => `${model.id}[${model.api}]`).join(", ") || "(none)"}`);
console.log(
	`pay-per-use ${PAY_PER_USE_MODEL_ID} present: ${kenari.some(model => model.id === PAY_PER_USE_MODEL_ID)}`,
);

// Assertions. These encode the three behaviours that are easy to regress:
// plan-scoped filtering, the vision guard, and the reasoning ladder.
const failures: string[] = [];
if (kenari.length === 0) failures.push("no Kenari chat models registered");
if (kenari.some(model => model.id === PAY_PER_USE_MODEL_ID)) {
	failures.push(`${PAY_PER_USE_MODEL_ID} is not in the account's plan but was registered`);
}
const visionModel = kenari.find(model => model.id === "deepseek-v4-1-flash");
if (visionModel && !sendsImageInputOnWire(visionModel)) {
	failures.push("deepseek-v4-1-flash drops images on the wire; the bundled stripImageInput guard leaked through");
}
for (const model of kenari) {
	if (!model.thinking) continue;
	const offered = new Set(getSupportedEfforts(model).map(String));
	for (const level of ["minimal", "xhigh"]) {
		if (offered.has(level) && !model.thinking.efforts.includes(level as never)) {
			failures.push(`${model.id} offers ${level} that Kenari never advertised`);
		}
	}
}

const sample = kenari.find(model => model.id === CHAT_MODEL_ID) ?? kenari[0];
if (!sample) throw new Error("no Kenari chat model was registered");
// `compat` is a union over every transport; only the OpenAI-completions member
// carries the reasoning-effort gate, so narrow before reading it.
const compat = sample.compat as Record<string, unknown> | undefined;
const reasoningEffortOnWire =
	compat?.supportsReasoningEffort === true && compat.omitReasoningEffort !== true;
console.log("sample model:", {
	id: sample.id,
	api: sample.api,
	reasoning: sample.reasoning,
	thinking: sample.thinking,
	input: sample.input,
	contextWindow: sample.contextWindow,
	cost: sample.cost,
	// The wire gate for `reasoning_effort`: omp drops the field when
	// `omitReasoningEffort` is set or `supportsReasoningEffort` is false.
	reasoningEffortOnWire,
});

const key = await registry.getApiKey(sample, "smoke");
if (!key) throw new Error(`no API key resolved for ${sample.provider}`);
const completion = await completeSimple(
	sample,
	{ messages: [{ role: "user", content: "Reply with the single word: ok", timestamp: Date.now() }] },
	// omp models effort as a const enum; the wire string is asserted here as a
	// smoke input, not consumed as a capability.
	{ apiKey: key, maxTokens: 64, reasoning: "low" as never },
);
const text = completion.content.find(block => block.type === "text")?.text ?? "";
console.log("chat completion:", { model: completion.model, stopReason: completion.stopReason, text: text.trim() });

const judge = resolveJudge({ settings, registry, sessionId: "smoke", purpose: "smoke" });
const primary = judge.primaryModel();
console.log("judge primary model:", primary?.provider, primary?.id);
if (primary?.provider !== "kenari-judge") throw new Error("judge role did not resolve to the Kenari provider");

const result = await judge.judge({
	state: "The sky appears blue on a clear day because air scatters short wavelengths more strongly than long ones.",
	questions: {
		q1: {
			type: "noul",
			instructions: "Is the sky blue on a clear day?",
			criteria: { true: "The sky is blue", false: "The sky is not blue" },
		},
	},
});
console.log("judgment:", { provider: result.provider, model: result.model, answers: result.answers });

// --- Tools and the /kenari command -----------------------------------------
// These are registered on the extension runtime, not the model registry, so they
// need their own load pass to be observable.
const loaded = await loadSessionExtensions(
	{ disableExtensionDiscovery: true, additionalExtensionPaths: [extensionPath] },
	cwd,
	settings,
	new EventBus(),
);
if (loaded.errors.length > 0) failures.push(...loaded.errors.map(error => `extension load: ${error.error}`));
const extension = loaded.extensions[0];
const expectedTools = ["kenari_search", "kenari_fetch", "kenari_embed", "kenari_rerank"];
for (const name of expectedTools) {
	if (!extension?.tools.has(name)) failures.push(`tool ${name} was not registered`);
}
if (!extension?.commands.has("kenari")) failures.push("command /kenari was not registered");

const toolCtx = { modelRegistry: registry, sessionManager: { getSessionId: () => "smoke" } } as never;
const toolText = (result: { content: { type: string; text?: string }[] }) =>
	result.content.find(block => block.type === "text")?.text ?? "";
const runTool = async (name: string, params: Record<string, unknown>) => {
	const tool = extension?.tools.get(name);
	if (!tool) return "";
	const out = await tool.definition.execute("smoke", params as never, undefined, undefined, toolCtx);
	return toolText(out as never);
};

const searchText = await runTool("kenari_search", { query: "omp coding agent", maxResults: 2 });
console.log("kenari_search:", searchText.split("\n")[0]);
if (!searchText.includes("http")) failures.push("kenari_search returned no result URLs");

const embedText = await runTool("kenari_embed", { input: ["hello", "world"] });
console.log("kenari_embed:", embedText.replace(/\n/g, " | "));
if (!/dimensions: \d+/.test(embedText)) failures.push("kenari_embed returned no vector dimensions");

const rerankText = await runTool("kenari_rerank", {
	query: "coding agent",
	documents: ["omp is a coding agent", "cats are animals"],
});
console.log("kenari_rerank:", rerankText.split("\n")[2]);
if (!rerankText.includes("score=")) failures.push("kenari_rerank returned no scores");

const notices: string[] = [];
const commandCtx = {
	modelRegistry: registry,
	sessionManager: { getSessionId: () => "smoke" },
	ui: { notify: (message: string) => notices.push(message) },
} as never;
await extension?.commands.get("kenari")?.handler("", commandCtx);
const report = notices[0] ?? "";
console.log("command /kenari:", report.split("\n")[0] || "(no output)");
if (!report.includes("plan")) failures.push("/kenari reported no plan");
// The free-lane tier is state-dependent; a subscriber must not be shown the
// brand-new-account figures (5/min) instead of their own (15/min).
if (report.includes("plan: ") && !report.includes("plan: none") && !report.includes("free lane (subscriber)")) {
	failures.push("/kenari showed a non-subscriber free lane for a subscribed account");
}

authStorage.close();

if (failures.length > 0) {
	console.error(`\nFAILED:\n${failures.map(failure => `  - ${failure}`).join("\n")}`);
	process.exit(1);
}
console.log("\nall assertions passed");
