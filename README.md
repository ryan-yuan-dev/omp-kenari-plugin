# omp-kenari

English | [简体中文](https://github.com/ryan-yuan-dev/omp-kenari-plugin/blob/main/README.zh-CN.md)

[Kenari ID](https://kenari.id) provider for the [omp](https://omp.sh) coding agent.

Export `KENARI_API_KEY` and the plugin imports Kenari's live model catalogue,
routes the `judge` model role to Kenari's Jev System One endpoint, and adds tools
for the capabilities a provider registration cannot reach. There is no config
file to write.

## Install

```bash
omp plugin install omp-kenari        # from npm
omp plugin link /path/to/omp-kenari  # local checkout
export KENARI_API_KEY=...
```

The host executes `src/*.ts` directly — there is no build step, so the published
package is exactly the tree you develop against.

## What it registers

| Provider | API | Contents |
| --- | --- | --- |
| `kenari` | `openai-completions` | Every chat model from `GET /v1/models`, discovered live |
| `kenari-judge` | `typesafe` | `jev-1-13-free`, served at `POST /v1/systemone` |

Both resolve the credential through the `KENARI_API_KEY` environment variable, so
the key is never copied into omp's config or credential store.

The `judge` role is pointed at `kenari-judge/jev-1-13-free` **only when the role
is unconfigured**. An explicitly configured judge is left alone, and the role is
not touched without a key — the override is runtime-only and never persisted.

## Tools

| Tool | Endpoint | Purpose |
| --- | --- | --- |
| `kenari_search` | `POST /v1/web/search` | Live web search; ranked titles, URLs and snippets |
| `kenari_fetch` | `POST /v1/web/fetch` | One URL as clean Markdown, plus title and outbound links |
| `kenari_embed` | `POST /v1/embeddings` | Embed text (`bge-m3` by default) |
| `kenari_rerank` | `POST /v1/rerank` | Rerank candidates by relevance (`bge-reranker-base`) |

Search, fetch and rerank are billed to the account's balance; embeddings are
effectively free at this scale. All four resolve the credential through omp's
registry, so a key in `config.yml` works the same as one in the environment.

## Commands

```
/kenari   # plan, quota windows, reset times, model counts, FX rate, free lane
```

A one-line version of the same summary is shown when a session starts. Both read
`GET /v1/account/quota` and `/api/public/pricing`; neither is required for the
providers to work.

The free-lane figures are tier-dependent and the tier is chosen by account
state, not printed from the first entry: a subscriber sees the `plan` tier
(25 req/min), not the new-account tier (5 req/min). A window Kenari omits is
unlimited, not missing — zero means unlimited in their API.

## Settings

```bash
omp plugin config list omp-kenari
omp plugin config set omp-kenari filterPayPerUse false
```

| Key | Default | Effect |
| --- | --- | --- |
| `discoveryEnabled` | `true` | Import the live catalogue. When off, only the judge provider is registered. |
| `filterPayPerUse` | `true` | Keep only models that are free or included in **your account's own plan**. |
| `autoJudge` | `true` | Register the judge provider and default the `judge` role to it. |
| `toolsEnabled` | `true` | Register the four Kenari tools. |
| `startupNotice` | `true` | Show the account summary when a session starts. |

Plan membership is per-plan, not per-catalogue. Every paid plan includes
`claude-sonnet-5`, but `claude-opus-4-7` is in no plan at all and
`gpt-5-6-sol` only in the top two tiers. The plugin reads the account's actual
plan from `GET /v1/account/quota` and filters against that plan's model list,
so models the account cannot use without paying per token are hidden — 23 of
them on a Studio plan, leaving 49 of 72.

When the plan is unknown (no subscription, or the quota endpoint failed), plan
membership is unknown and **every** model is listed: hiding a model the account
may already pay for is worse than showing one that costs per token.

Catalogue-shaping settings are applied when the model list is fetched, and omp
caches that list per provider for 24 hours. After changing a setting, drop the
cache so the new shape is fetched:

```bash
omp models refresh   # or delete ~/.omp/agent/models.db*
```

## Notes

- **Only chat models are registered.** Kenari also serves image
  (`/v1/images/generations`), video, speech, transcription and embedding ids, but
  omp offers no way for an extension to register a non-chat model *kind*, so they
  are intentionally left out rather than registered as chat models they are not.
  The embedding and rerank ids remain reachable through `kenari_embed` and
  `kenari_rerank`.
- Prices arrive as `micro_idr_per_1m_tokens` (whole rupiah × 1e6). omp's cost
  model is USD-only, so they are converted with the **live** `usd_idr_rate` from
  `/api/public/pricing` (falling back to a documented constant) and used only for
  the relative-cost readouts omp derives. They are not a billing source of truth.
- `reasoning_options` maps onto omp's effort levels one-to-one, minus `none`:
  omp expresses "do not think" by omitting `reasoning_effort`, so `none` is not
  offered as an effort level. A reasoning model that publishes no
  `reasoning_options` gets `low`/`medium`/`high`, verified against the live
  endpoint — omp's bundled catalog would otherwise inherit a ladder Kenari
  rejects (`minimal` for `mimo-v2-5` returns HTTP 400).
- If `~/.omp/agent/models.yml` also declares a `kenari` provider, the two
  definitions collide — a config-sourced provider shadows an extension one. Keep
  the definition in exactly one place.

## Scripts

| Script | Purpose |
| --- | --- |
| `bun run dev` | Load this checkout into one throwaway CLI run (`omp models ls -e`) and list what it registers. |
| `bun run typecheck` | `tsc --noEmit` under `strict`. |
| `bun run test` | Alias of `typecheck`; there are no unit tests. |
| `bun run smoke` | Live end-to-end verification; needs `KENARI_API_KEY` and network. |
| `bun run verify` | `typecheck` then `smoke` — the full pre-publish gate. |
| `bun run publish:dry` | `npm publish --dry-run`: build the tarball, run the prepublish gate, send nothing. |

`prepublishOnly` runs `typecheck`, so a broken tree cannot be published.

### Releasing

```bash
bun run verify                 # 1. gate: typecheck + live smoke
bun run publish:dry            # 2. inspect tarball, confirm the gate fires
npm version patch              # 3. bump version + tag
npm publish --access public    # 4. upload
```

## Verify

```bash
bun run verify                 # typecheck + live smoke
KENARI_API_KEY=... bun run smoke

# Or drive it straight from the CLI, loading just this checkout:
bun run dev
```

`test/smoke.ts` loads the plugin through omp's own extension loader and registry,
then exercises the catalogue, a real chat completion, a real judgment, all four
tools and the `/kenari` command. It needs the network and a credential, so it is
deliberately not named `*.test.ts` and never runs under `bun test`.
