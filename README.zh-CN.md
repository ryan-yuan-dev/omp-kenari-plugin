# omp-kenari

[English](https://github.com/ryan-yuan-dev/omp-kenari-plugin/blob/main/README.md) | 简体中文

[omp](https://omp.sh) 编程智能体的 [Kenari ID](https://kenari.id) provider。

导出 `KENARI_API_KEY` 后，插件即导入 Kenari 的实时模型目录、把 `judge` 模型角色
指向 Kenari 的 Jev System One 端点，并补上 provider 注册本身够不到的能力工具。
无需编写任何配置文件。

## 安装

```bash
omp plugin install omp-kenari        # 从 npm 安装
omp plugin link /path/to/omp-kenari  # 或链接本地 checkout
export KENARI_API_KEY=...
```

宿主直接执行 `src/*.ts` —— 没有构建步骤，所以发布出去的包与你本地开发的目录树
完全一致。

## 注册了什么

| Provider | API | 内容 |
| --- | --- | --- |
| `kenari` | `openai-completions` | `GET /v1/models` 返回的全部 chat 模型，实时发现 |
| `kenari-judge` | `typesafe` | `jev-1-13-free`，由 `POST /v1/systemone` 提供 |

两者都通过环境变量 `KENARI_API_KEY` 解析凭据，密钥不会被复制进 omp 的配置或
凭据存储。

`judge` 角色**仅在未配置时**被指向 `kenari-judge/jev-1-13-free`。显式配置过
judge 的不动；没有密钥时也不改。该覆盖只在运行时生效，永不持久化。

## 工具

| 工具 | 端点 | 用途 |
| --- | --- | --- |
| `kenari_search` | `POST /v1/web/search` | 实时网页搜索；返回排序后的标题、URL 与摘要 |
| `kenari_fetch` | `POST /v1/web/fetch` | 把一个 URL 抓成干净的 Markdown，附带标题与外链 |
| `kenari_embed` | `POST /v1/embeddings` | 文本向量化（默认 `bge-m3`） |
| `kenari_rerank` | `POST /v1/rerank` | 按相关性重排候选（`bge-reranker-base`） |

搜索、抓取与重排按账户余额计费；向量化在这个量级上实际免费。四个工具都经 omp 的
registry 解析凭据，因此写在 `config.yml` 里的密钥与环境变量里的等效。

## 命令

```
/kenari   # 套餐、配额窗口、重置时间、模型数量、汇率、免费额度
```

会话启动时会显示同一摘要的一行版本。二者都读取 `GET /v1/account/quota` 与
`/api/public/pricing`；但这两个接口都不是 provider 工作的前提。

免费额度数字随档位变化，档位由账户状态决定，而不是照搬第一条：订阅用户看到的是
`plan` 档（25 req/min），而非新账户档（5 req/min）。Kenari 未给出的窗口表示
无限，而不是缺失 —— 在他们的 API 里零即无限。

## 设置

```bash
omp plugin config list omp-kenari
omp plugin config set omp-kenari filterPayPerUse false
```

| 键 | 默认值 | 效果 |
| --- | --- | --- |
| `discoveryEnabled` | `true` | 导入实时目录。关闭时只注册 judge provider。 |
| `filterPayPerUse` | `true` | 只保留免费、或已包含在**你自己账户套餐**内的模型。 |
| `autoJudge` | `true` | 注册 judge provider 并把 `judge` 角色默认指向它。 |
| `toolsEnabled` | `true` | 注册四个 Kenari 工具。 |
| `startupNotice` | `true` | 会话启动时显示账户摘要。 |

套餐归属是「按套餐」而非「按目录」的。每个付费套餐都包含 `claude-sonnet-5`，但
`claude-opus-4-7` 不属于任何套餐，`gpt-5-6-sol` 只在前两档里。插件从
`GET /v1/account/quota` 读取账户的实际套餐，并按该套餐的模型清单过滤，因此账户
无法在不按 token 付费的前提下使用的模型会被隐藏 —— Studio 套餐下隐藏 23 个，
72 个里保留 49 个。

当套餐未知时（没有订阅，或配额接口失败），套餐归属同样未知，此时**列出全部**
模型：隐藏一个账户可能已经在付费的模型，比展示一个按 token 计费的模型更糟。

影响目录形态的设置只在拉取模型清单时生效，而 omp 会按 provider 缓存该清单 24
小时。改动设置后需要清掉缓存，才会按新形态拉取：

```bash
omp models refresh   # 或删除 ~/.omp/agent/models.db*
```

## 说明

- **只注册 chat 模型。** Kenari 还提供图像（`/v1/images/generations`）、视频、
  语音、转写与 embedding 等 id，但 omp 没有给扩展注册非 chat 模型 *kind* 的途径，
  因此它们被有意排除，而不是冒充 chat 模型注册进来。embedding 与 rerank 的 id
  仍可通过 `kenari_embed` 与 `kenari_rerank` 使用。
- 价格以 `micro_idr_per_1m_tokens` 下发（整数印尼盾 × 1e6）。omp 的 cost 模型只
  认美元，因此用 `/api/public/pricing` 的**实时** `usd_idr_rate` 换算（失败时回退
  到一个有文档记载的常量），且仅用于 omp 派生出的相对成本读数。它们不是计费
  依据。
- `reasoning_options` 与 omp 的 effort 档位一一对应，但不含 `none`：omp 用「省略
  `reasoning_effort`」表达「不思考」，所以 `none` 不作为档位提供。未公布
  `reasoning_options` 的推理模型获得 `low`/`medium`/`high`，已对实时端点验证 ——
  否则 omp 自带的 catalog 会继承一条 Kenari 拒绝的阶梯（`mimo-v2-5` 传
  `minimal` 返回 HTTP 400）。
- 若 `~/.omp/agent/models.yml` 里也声明了 `kenari` provider，两处定义会冲突 ——
  来自配置的 provider 会遮蔽扩展注册的那个。请只保留一处。

## 脚本

| 脚本 | 用途 |
| --- | --- |
| `bun run dev` | 把这个 checkout 载入一次用完即弃的 CLI 运行（`omp models ls -e`），列出注册结果。 |
| `bun run typecheck` | `strict` 下的 `tsc --noEmit`。 |
| `bun run test` | `typecheck` 的别名；本项目没有单元测试。 |
| `bun run smoke` | 实时端到端验证；需要 `KENARI_API_KEY` 与网络。 |
| `bun run verify` | 先 `typecheck` 再 `smoke` —— 完整的发布前门禁。 |
| `bun run publish:dry` | `npm publish --dry-run`：打包、跑发布前门禁，但不发送任何内容。 |

`prepublishOnly` 会执行 `typecheck`，因此坏掉的代码树发不出去。

### 发布

```bash
bun run verify                 # 1. 门禁：typecheck + 实时 smoke
bun run publish:dry            # 2. 检查 tarball，确认门禁被触发
npm version patch              # 3. 提升版本号并打 tag
npm publish --access public    # 4. 上传
```

## 验证

```bash
bun run verify                 # typecheck + 实时 smoke
KENARI_API_KEY=... bun run smoke

# 或者直接从 CLI 驱动，只加载这个 checkout：
bun run dev
```

`test/smoke.ts` 通过 omp 自己的扩展加载器与 registry 载入插件，然后检验目录、
一次真实对话补全、一次真实 judgment、全部四个工具以及 `/kenari` 命令。它需要
网络与凭据，因此刻意不命名为 `*.test.ts`，永远不会被 `bun test` 收集。
