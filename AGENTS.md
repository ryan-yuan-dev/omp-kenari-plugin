# Repository Guidelines

`omp-kenari` is an extension package for the [omp](https://omp.sh) coding agent
(`@oh-my-pi/pi-coding-agent`). It registers two model providers and is loaded by
the host at runtime — there is no build step, no bundler, and no compiled output.

## Hard Constraints

**This repository is a plugin. NEVER modify omp's source.**

The host lives outside this repo — a global install under `node_modules` or the
compiled binary behind `~/.bun/bin/omp`. Editing it is never a fix:

- Changes are lost on the next `omp` upgrade, and the plugin must keep working
  against an unmodified host.
- A local patch makes the plugin appear to work while silently depending on it,
  so the breakage surfaces later on someone else's machine.
- Anything the host does not expose is a host limitation to work *around* or
  report upstream — not to patch in place.

When a host limitation blocks a requirement, the plugin either finds a supported
route or documents the limitation (see Known Pitfalls). `node_modules` here is
for typechecking only; treat the installed host packages as read-only reference.

## Project Overview

Setting `KENARI_API_KEY` is the entire configuration:

- **`kenari`** — the live chat catalogue from `GET https://kenari.id/v1/models`,
  registered on omp's bundled `openai-completions` transport.
- **`kenari-judge`** — Kenari's `jev-1-13-free` System One model, registered on
  the `typesafe` api so judgments route natively to `POST /v1/systemone`.
- **`judge` role** — pointed at `kenari-judge/jev-1-13-free` when the role is
  unconfigured, via a runtime override that is never persisted.

The plugin must not require edits to `~/.omp/agent/config.yml` or
`models.yml`; both files are user-owned and are read-only inputs here.

## Architecture & Data Flow

```
omp starts
  └─ extension loader imports src/index.ts          (default export = factory)
       ├─ loadKenariSettings(cwd)                   reads omp's plugin settings
       ├─ pi.registerProvider("kenari-judge", …)    queued, no network
       ├─ pi.registerProvider("kenari", …)          queued, no network
       ├─ registerKenariTools(pi)                   four tools, queued
       └─ pi.registerCommand("kenari", …)           status command
  └─ registry drains queued registrations
  └─ registry.refreshRuntimeProviders()
       └─ fetchDynamicModels()                      our network call, deferred
            └─ loadKenariSnapshot()                 memoized for the process
                 ├─ GET /v1/models                   public
                 ├─ GET /api/plans                   bearer; non-fatal
                 ├─ GET /v1/account/quota            bearer; non-fatal
                 ├─ GET /api/public/pricing          public; non-fatal
                 └─ GET /v1/models?modality=systemone non-fatal
  └─ judgment (planning, find, ttsr)
       └─ resolveJudge() → judge role → kenari-judge → POST /v1/systemone
  └─ tool calls
       └─ resolveClient(ctx) → registry credential → POST /v1/web/search …
```

Two facts drive most of the design:

1. **Registration is synchronous, discovery is deferred.** `registerProvider`
   only queues config; the registry calls `fetchDynamicModels` later. Anything
   the factory needs must be resolved *before* registering, and network work
   belongs inside the callback.
2. **Settings are read once, at factory time.** omp caches the discovered
   catalogue per provider for 24 h in `~/.omp/agent/models.db`. Changing a
   catalogue-shaping setting does not refetch — `omp models refresh` does.

The account snapshot is memoized per process because three consumers need it
(the provider fetch, the tools' credential lookup, and `/kenari`). It is not
cached across processes: `omp models refresh` reloads the extension, which is how
a stale plan is meant to be cleared.

## Key Directories

| Path | Purpose |
|---|---|
| `src/index.ts` | Extension factory: settings, provider registration, judge-role override, tools, command. The only entry point omp loads. |
| `src/client.ts` | Kenari HTTP surface and wire parsing. All `unknown` → typed conversion happens here. |
| `src/account.ts` | Account snapshot: catalogue, plan, quota, pricing, System One ids. Degrades per lookup. |
| `src/discovery.ts` | Catalogue rows → `ProviderModelConfig`: effort mapping, input modalities, pricing, filtering. |
| `src/tools.ts` | The four Kenari tools and their credential resolution. |
| `src/settings.ts` | Plugin settings: defaults, keys, and the `getPluginSettings` read. |
| `test/smoke.ts` | Live end-to-end verification. Not a `bun test` file — see Testing & QA. |
| `package.json` | `omp.extensions` entry point and `omp.settings` schema — both are host contracts. |

## Development Commands

```bash
bun run dev                          # same as `omp models ls -e ./src/index.ts`, HOME isolated
bun run typecheck                    # tsc --noEmit (strict)
bun run smoke                        # live end-to-end; needs KENARI_API_KEY + network
bun run verify                       # typecheck then smoke — the pre-publish gate
bun run test                         # alias of typecheck; there are no unit tests

# Fastest dev loop: load this checkout into one CLI run, no install, no restart.
HOME=$(mktemp -d) omp models ls -e ./src/index.ts

omp plugin link .                    # install this checkout into the host
omp plugin config list omp-kenari    # show effective settings + schema
omp plugin config set omp-kenari filterPayPerUse false
omp plugin config validate
omp models ls                        # confirm both providers registered
omp models refresh                   # drop the 24 h catalogue cache and refetch
```

`omp models ls -e ./src/index.ts` is the loop to use while iterating: it loads
only this extension, so the counts are not polluted by the developer's own
`models.yml`, and it re-imports the module on every run. Reach for
`omp plugin link` only when verifying the real install path.

`omp plugin link` writes a symlink at `~/.omp/plugins/node_modules/omp-kenari`
plus a `~/.omp/plugins/omp-plugins.lock.json` entry; the host resolves plugin
edits immediately, but **extension modules are cached per process**, so restart
`omp` after editing `src/`.

## Code Conventions & Common Patterns

**Imports.** Import the host through its public specifiers only:
`@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-coding-agent/judgment`, and
`@oh-my-pi/pi-coding-agent/extensibility/plugins/loader`. The host rewrites
`@oh-my-pi/pi-*` specifiers onto its own in-process modules, so a plugin never
needs a nested install of the host. Do **not** deep-import `@oh-my-pi/pi-catalog`
or `@oh-my-pi/pi-ai`: they are transitive dependencies, not declared peers.
Derive types from host exports instead (see the `ProviderModelConfig["thinking"]`
pattern in `src/discovery.ts`).

**Parsing at the boundary.** Wire payloads are `unknown` until `src/client.ts`
parses them into `KenariModel` / `KenariPlan`. Downstream code consumes those
named types and never re-guards shape. Do not add local `isRecord`-style helpers.

**Settings are booleans with defaults.** Every setting has a `package.json`
schema entry and a `KENARI_SETTING_DEFAULTS` value; an unset or wrongly typed
value falls back rather than throwing.

**Failure policy.** A discovery failure must degrade, not abort. Every account
lookup is a `LookupState<T>` so a partial failure is visible rather than silent.
Plan-scoped filtering needs the account's *own* plan (`GET /v1/account/quota`),
because membership is per-plan: the union of all plans keeps models the account
cannot use without paying per token. When that lookup fails, plan membership is
unknown and the catalogue is left unfiltered — hiding a model the user pays for
is worse than listing one that costs per token. Only `/v1/models` failing is
fatal to the `kenari` provider.

**Free-lane limits are tier-dependent.** `/api/public/pricing` publishes three
mutually exclusive `free_tier` states — `base` (new account), `next` (topped up
past `threshold_idr`), `plan` (subscribed). Pick by account state; printing the
base figures to a subscriber understates their RPM fivefold (5 → 25 req/min).
The topped-up tier is never claimed: the balance that decides it is not exposed
by any endpoint this plugin may call, so the base figures are reported with the
threshold stated instead. A quota window Kenari omits is unlimited, not missing.

**Pricing.** Kenari quotes `micro_idr_per_1m_tokens` (whole rupiah × 1e6). omp's
cost model is USD-only and has no currency field, so the live `usd_idr_rate` from
`/api/public/pricing` converts them for the relative-cost readouts omp derives,
falling back to `FALLBACK_IDR_PER_USD`. These figures are not a billing source of
truth.

**Tool parameters are named interfaces.** omp injects its zod shim as a loosely
typed module, so `Static<typeof schema>` collapses to `unknown` and the `execute`
callbacks lose every field. Declare a `…Params` interface next to the tool and
annotate `execute` explicitly — do not reach for `ReturnType<typeof z.object>`.

**Effort levels.** `reasoning_options` map one-to-one onto omp's effort levels,
minus `none` — omp expresses "do not think" by omitting `reasoning_effort`, so
offering `none` would present a phantom choice. omp's `Effort` is a `const enum`,
so the wire strings are validated against `KNOWN_EFFORTS` and asserted once, at
the boundary. `reasoning: true` without `reasoning_options` means the model
thinks unconditionally and must still be reported as reasoning.

**omp's catalog is not the authority for a gateway.** A model id registered here
also exists in omp's bundled catalog, which `finalizeCustomModel` consults by id
and inherits two things from: a defensive `stripImageInput: true` for families
whose first-party endpoints reject `image_url` (DeepSeek among them), and an
identity-derived effort ladder for models that publish no `reasoning_options`.
Both are wrong for Kenari — it serves `deepseek-v4-1-flash` with working image
input, and rejects `reasoning_effort: "minimal"` for `mimo-v2-5`. The catalogue
response is the authority; anything the plugin does not pin gets inherited.

## Important Files

| File | Contract |
|---|---|
| `package.json` → `omp.extensions` | Module paths the host loads. Relative, with `.ts` extension. |
| `package.json` → `omp.settings` | Settings schema rendered by `omp plugin config list`. Adding a setting means editing both this and `src/settings.ts`. |
| `src/index.ts` → `default` | The `ExtensionFactory`. May be async; the host awaits it. |
| `src/client.ts` → `KenariClient` | Sole place that performs network I/O and parses wire shapes. |
| `src/discovery.ts` → `selectKenariModels` | Sole place that decides which catalogue rows are exposed. |
| `README.md` / `README.zh-CN.md` | User-facing docs. English is canonical; the Chinese file is a translation and must be updated in the same commit as any user-visible change. Both ship in the npm tarball. |

## Runtime/Tooling Preferences

- **Bun is required** (host `engines.bun: >=1.3.14`); TypeScript is executed
  directly. There is no `tsc` build and no emitted JS.
- `tsc` is used for type checking only (`noEmit`, `strict`).
- `node_modules` exists solely for typechecking and the smoke script; the host
  supplies every runtime dependency.
- No lint or format tooling is configured in this repository. Match the
  surrounding file rather than introducing a formatter.

## Testing & QA

There are no unit tests, so `bun run test` is an alias of `typecheck`. The
verification ladder is:

1. `bun run typecheck` — must be clean.
2. `bun run smoke` — loads the plugin through the host's *own* extension loader
   and registry (`loadCliExtensionProviders` for models, `loadSessionExtensions`
   for tools/commands), then asserts: catalogue size, the pay-per-use filter,
   `reasoningEffortOnWire`, a real chat completion, a real judgment routed to
   `kenari-judge`, all four tools, and the `/kenari` command. Run it with
   `HOME=$(mktemp -d)` to keep your own `config.yml` and `models.yml` out of the
   result.
3. `omp models ls` / `omp models refresh` — confirm the host sees both providers.

`bun run verify` runs steps 1 and 2 in order; it is the gate before publishing
(and `prepublishOnly` re-runs `typecheck` on its own).

`test/smoke.ts` is deliberately **not** named `*.test.ts`: `bun test` globs
`**/*.{test,spec}.ts`, and this script needs the network and a credential.

Delete `~/.omp/agent/models.db*` (or run `omp models refresh`) when changing a
setting that reshapes the catalogue, otherwise the 24 h cache masks the change.

## Known Pitfalls

- **Two capabilities are intentionally not implemented.** `omp usage` never
  loads extensions (`cli/usage-cli.ts` reads `discoverAuthStorage` directly), so
  a `usage` provider registered here is invisible — the same data is exposed
  through `/kenari` instead. `POST /v1/ocr` returned `503 upstream_error` on
  every probe, so no `kenari_ocr` tool exists until Kenari fixes it. Image
  generation is blocked by the `kind` limitation below.
- **Non-chat model kinds cannot be registered by an extension.** The `/model`
  browser's kind section is an *output-task* filter, not an input-modality one:
  `image` is labelled "Image generation" and matches `modelKind(model) === "image"`,
  `speech` matches `tts`, `dictation` matches `stt`. A chat model that *reads*
  images is `chat` and is chosen through the `vision` role instead.
  `kind` is not part of `ProviderModelConfig` nor of `ModelPatch`, and
  `buildCustomModelOverlay` copies a fixed field list, so a `kind` on a registered
  model is dropped and the model resolves as `chat`. Every route fails, verified:
  `registerProvider` + `kind` → `modelKind() === "chat"`; `registerProvider` with
  `api: "openai-images"` → still `chat`; a `models.yml` provider with
  `discovery: openai-models-list` → every row `chat`, because
  `extractOpenAIModelsListOutputTask` reads `output`/`output_modalities`, not
  Kenari's nested `modalities.output`; an explicit `kind: image` under a
  `models.yml` provider → silently ignored (the schema has no `kind`). Kenari's
  image, video, speech and embedding ids therefore stay unregistered.
- **Duplicate provider definition.** A `kenari` provider declared in
  `~/.omp/agent/models.yml` shadows the extension's provider: the config-sourced
  models win, and the plugin's filter never applies. Keep the definition in
  exactly one place.
- **`apiKey` is an env var name, not a secret.** `apiKey: "KENARI_API_KEY"`
  makes the host resolve the variable at request time, which is why the key is
  never copied into omp's config or credential store.
- **The judge base URL is origin-only.** `TypeSafeJudge` appends `/v1/systemone`
  itself, so `https://kenari.id/v1` would produce `/v1/v1/systemone`.
- **Judge role provenance.** `getModelRoleProvenance("judge") !== "default"`
  means the user configured a judge; do not override it. `overrideModelRoles` is
  runtime-only and intentionally not persisted.
