# magpie-vertex-ai

[English](README.md) | 简体中文

维护分支：[yayamahardika/magpie-vertex-ai](https://github.com/yayamahardika/magpie-vertex-ai)，基于 [HzTTT/magpie-vertex-ai](https://github.com/HzTTT/magpie-vertex-ai)。保留原始版权与 MIT 许可证。

面向 **Google Vertex AI** 的 [magpie](https://usemagpie.ai) / OpenCode 提供者（Provider）插件。使用服务账号（Service Account）JSON 或应用默认凭据（Application Default Credentials，ADC）登录后，插件会将你的 GCP 项目实际可调用的全部模型作为单一提供者暴露出来——涵盖 Gemini 对话与图像模型、TTS 语音合成、Veo 视频生成、Lyria 音乐生成、Embeddings 向量嵌入、音频转写、MaaS 合作伙伴模型（DeepSeek、Qwen、GLM、Kimi、MiniMax、gpt-oss、Grok、Gemma）以及 Claude。

- 提供者 ID：`vertex-ai`。所有模型均以 `vertex-ai/<key>` 的形式寻址（如 `vertex-ai/gemini-3.8-flash`、`vertex-ai/veo-3.1-generate-001` 等）。
- 纯 ESM `.mjs` 实现，零运行时依赖，在 magpie 插件宿主内的 Bun 环境中运行。
- 工作原理：magpie 将发往该提供者模型的所有请求路由到插件在哨兵基址（sentinel base URL）上的 `fetch`；插件根据模型家族将路径映射到对应的 Vertex 端点（`:streamGenerateContent`、`:rawPredict`、OpenAI 兼容的 `endpoints/openapi` 接口等），使用保存的凭据签发 OAuth 访问令牌（作用域 `cloud-platform`），按顺序尝试模型的可用服务区域，并以客户端智能体所使用的协议流式返回响应。

## 为什么使用 `vertex-ai` 而不是 `google-vertex`

`google-vertex` 是 magpie 内置 Vertex 预设的 ID（`magpie provider add google-vertex ...`）。如果插件的 `auth.provider` 与内置预设 ID 相同，magpie 会将其强制重命名（为 `google-vertex-plugin`），从而破坏模型寻址与登录流程。而 `vertex-ai` 未被占用。同时 models.dev 上也没有 `vertex-ai` 条目，因此插件会在自身的 `config` 钩子中自行声明该提供者及其完整的模型目录。

## 安装

```sh
magpie plugin add github:yayamahardika/magpie-vertex-ai
# 或使用本地检出目录：magpie plugin add /path/to/magpie-vertex-ai
magpie plugin login vertex-ai
```

## 登录

### 方式 1 — 服务账号 / 凭据 JSON（推荐）

依次包含三个输入提示：

1. **Credentials（凭据）** — JSON 文件路径（例如 `~/.config/gcp/vertex-sa.json`；支持展开 `~` 和 `$VARS` 环境变量），或直接粘贴为单行的 JSON 文本。留空则读取 `$GOOGLE_APPLICATION_CREDENTIALS`。支持两种格式：`type: "service_account"`（服务账号）和 `type: "authorized_user"`（`gcloud auth application-default login` 生成的用户凭据文件）。
2. **GCP project id（GCP 项目 ID）** — 留空时依次回退使用凭据中的 `project_id`、`quota_project_id`，最后回退到 `$GOOGLE_CLOUD_PROJECT`。
3. **Region（区域）** — `auto`（推荐：每次请求自动选用首个支持该模型的区域）或指定的固定 Vertex 区域。

### 方式 2 — Application Default Credentials（应用默认凭据）

优先读取 `$GOOGLE_APPLICATION_CREDENTIALS`；若未设置，则在设置 `$CLOUDSDK_CONFIG` 时读取其中的 `application_default_credentials.json`，否则在 Windows 上读取 `%APPDATA%\gcloud`、在 Linux/macOS 上读取 `~/.config/gcloud` 下的该文件（可通过 `gcloud auth application-default login` 生成）。项目与区域提示同上。凭据路径同时支持 `~/` 与 `~\`。

### 存储内容与令牌续期

magpie 会将登录信息保存在其配置目录（`~/.config/magpie` 或 `$XDG_CONFIG_HOME/magpie`）下的 `plugin-auth.json` 中（权限模式 600，结构与 OpenCode 的 `auth.json` 相同）：完整的凭据 JSON 文本保存在账号的 `refresh` 字段中，签发的访问令牌及其过期时间保存在 `access` / `expires` 中。在令牌过期前（提前 5 分钟），magpie 会通过插件的 `auth.refresh` 钩子自动续期；该钩子会跳过缓存，直接使用保存的凭据签发新令牌。若凭据不再被 Google 接受（如 `invalid_grant` 等），会作为登录过期抛出，提示你重新登录。在同一进程内，相同凭据身份的并发请求会共享同一个已签发的令牌（single-flight）。

### 所需 IAM 权限

- 项目上的 `roles/aiplatform.user` 角色（或具备 Vertex 推理权限的等效角色）。
- 若使用 Chirp 3 HD 语音，需启用 **Cloud Text-to-Speech API**——`chirp3-hd` 直接调用 `texttospeech.googleapis.com`，而非经过 Vertex。
- Claude 模型还要求项目的结算账号具备 Vertex 上 Anthropic 模型的使用资格；否则所有请求都会因 Anthropic 服务条款错误而被拒绝。

## 模型

### 模型家族

| 家族 | 示例模型 | 调用方式 | 返回结果 |
|---|---|---|---|
| Gemini 对话 | `gemini-3.8-flash`、`gemini-3.5-flash`、`gemini-2.5-pro`、`gemini-2.5-flash` | 对话（从任意智能体调用）——magpie 会将 chat-completions / Responses / Anthropic 请求转换为 Gemini `streamGenerateContent`。若请求以 `/chat/completions` 形式到达插件（例如 `magpie provider test vertex-ai <model>`），则会作为 `google/<id>` 发往 Vertex 的 OpenAI 兼容端点 | 流式文本、思考过程（thinking）与工具调用；在模型支持时可携带附件（图像、音频、视频、PDF） |
| Gemini 图像 | `gemini-3-pro-image`、`gemini-nano-banana-2.1`、`gemini-2.5-flash-image`、`gemini-3.1-flash-image` | 对话 | 图像会写入本地磁盘，回复中包含 Markdown `![image](file:///...)` 链接及绝对路径。使用 Gemini 协议的智能体还会额外收到原始 `inlineData` 部分；由于 magpie 会为 chat-completions、Anthropic 和 Responses 客户端丢弃内联媒体，这些客户端仅保留文本链接 |
| Gemini TTS | `gemini-2.5-flash-tts`、`gemini-2.5-pro-tts`、`gemini-3.1-flash-tts-preview` | 对话 | WAV 文件（Vertex 返回 24 kHz PCM，由插件封装 RIFF 头）及 `file://` 链接；语音通过 `ttsVoice` 配置 |
| Chirp 3 HD | `chirp3-hd` | 对话 | 来自全局 Cloud Text-to-Speech API 的 MP3 文件；语音通过 `chirpVoice` 配置，语言通过 `chirpLanguage` 配置（默认为 `en-US`；当提示词包含中日韩字符时默认为 `cmn-CN`） |
| Veo | `veo-3.1-generate-001`、`veo-3.1-fast-generate-001`、`veo-3.1-lite-generate-001`、`veo-3.0-generate-001`、`veo-3.0-fast-generate-001`、`veo-2.0-generate-001` | 对话 | MP4 文件及 `file://` 链接。任务通过 `:predictLongRunning` 提交（被拒绝的任务直接返回 HTTP 错误）并轮询；轮询进度会作为推理文本（`"Veo generating... Ns"`）配合 SSE 保活信号持续输出，避免长耗时生成超时。在提示词中附带一张图片可作为首帧，附带第二张图片可作为尾帧（仅限 Veo 3）。若结果以 `gcsUri` 返回，则仅报告该 URI，不会下载 |
| Lyria | `lyria-002` | 对话 | 约 30 秒的纯音乐 WAV 文件及 `file://` 链接。Lyria 仅接受美式英语提示词，且其语言检测会拒绝简短片段（如 `"calm lo-fi piano loop"`）；请使用完整英文句子描述音乐（曲风、情绪、乐器、速度）。提示词中的 Markdown 和链接会被自动剥离 |
| Embeddings（向量嵌入） | `text-embedding-005`、`gemini-embedding-001`、`gemini-embedding-2`、`text-multilingual-embedding-002`、`multimodalembedding` | `POST /v1/embeddings`（OpenAI 格式，`model` 为 API ID） | OpenAI 格式的 embeddings 响应：`data[].embedding` 为浮点数数组，或在指定 `encoding_format: "base64"` 时为 base64 编码的 float32；在模型支持时转发 `dimensions` / `task_type`；输入会自动分批（`text-embedding` 系列每次 `:predict` 最多 250 条，`gemini-embedding-001` / `gemini-embedding-2` / `multimodalembedding` 每次 1 条），并按输入顺序返回结果 |
| Transcription（音频转写） | `json` 与 `text` 格式使用 `gemini-3.5-transcribe-preview`；`srt`、`vtt` 与 `verbose_json` 格式运行在 `gemini-2.5-flash` 上（因为纯转写模型不返回时间戳） | `POST /v1/audio/transcriptions` / `/v1/audio/translations`，multipart 表单（`file`、`model`，可选 `language`、`prompt`、`temperature`、`response_format`） | OpenAI 格式的转写结果。`response_format` 支持 `json`（默认）、`text`、`srt`、`vtt`、`verbose_json`——带时间戳的格式会包含分段信息（segments）。音频大小不得超过 15 MB（Vertex 内联上限）。`/translations` 始终以英文返回结果 |
| MaaS 合作伙伴模型 | `deepseek-v3.2-maas`、`deepseek-r1-0528-maas`、`deepseek-ocr-maas`、`qwen3-coder-480b-a35b-instruct-maas`、`qwen3-235b-a22b-instruct-2507-maas`、`glm-5-maas`、`glm-5.2-maas`、`kimi-k2-thinking-maas`、`minimax-m2-maas`、`gpt-oss-120b-maas`、`grok-4.1-fast-reasoning`、`grok-4.20-non-reasoning`、`gemma-4-26b-a4b-it-maas` | 对话（chat-completions 协议） | 通过 Vertex 的 OpenAI 兼容端点（`.../endpoints/openapi/chat/completions`）返回流式补全；请求体除将 `model` 重写为 `publisher/id`（以及流式传输时默认启用 `stream_options.include_usage`）外原样透传 |
| Claude | `claude-opus-4-8`、`claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5`、`claude-haiku-4-5@20251001`、`claude-opus-4-5@20251101`、`claude-3-opus@20240229` | 使用 Anthropic 协议对话（magpie 发送 `/messages`） | 通过 Vertex `:rawPredict` / `:streamRawPredict` 返回 Anthropic Messages 响应；插件会自动添加 `anthropic_version: "vertex-2023-10-16"`，将 `anthropic-beta` 请求头移入请求体的 `anthropic_beta` 字段，并移除 magpie 注入的 `web_search_...` 服务端工具（Vertex 不提供该工具） |

模型键（key）中绝不包含 `/`：MaaS 模型的键会省略发布者前缀（例如 `vertex-ai/deepseek-v3.2-maas` 实际调用 `deepseek-ai/deepseek-v3.2-maas`），带版本号的 Claude ID（如 `claude-opus-4-5@20251101`）对应的键为 `claude-opus-4-5`。启用区域变体（`regionVariants`）后，任意模型还可以通过 `key@region` 的形式指定区域调用。

### 区域与自动发现

- 内置目录（`lib/catalog.mjs`）列出了每个模型的可用服务区域（例如 Gemini 3.x 和大多数 MaaS 模型位于 `global`，Veo 和 Gemini 2.5 Pro 位于 `us-central1`，Claude 3 Opus 位于 `us-east5` / `europe-west1` / `europe-west4` / `asia-southeast1` 等）。
- **区域故障切换（Region failover）**：每次请求时，插件优先尝试固定区域（当以 `key@region` 调用时）；否则若登录时指定的区域支持该模型，则尝试登录区域；否则按顺序尝试目录中的所有区域（优先 `global`，其次 `us-central1`，随后为其余区域）。当遇到 404 / 429 / 5xx，或响应体表明模型在该区域不可用/无法提供服务的 400 / 403 时，插件会自动切换到下一个区域；其他情况下直接返回最后一次上游错误。
- **后台模型发现（Background discovery）**：首次列出模型时，插件会按项目与凭据身份探测当前账号实际可调用的模型。它会遍历所有服务区域中的全部 Vertex 发布者，并按区域逐一探测每个模型：Gemini 使用 `countTokens`，`gemini-embedding-*` 使用 `:embedContent`，其他向量嵌入模型使用 `:predict`，MaaS 使用 1-token 对话，Claude 使用 `count-tokens`，Veo/Lyria 使用元数据 GET 请求，Chirp 使用语音列表接口。HTTP 200 视为可用；严格匹配的少数参数校验类 HTTP 400 也视为端点已接受。429/5xx 会重试一次。由于 `countTokens` 会忽略模型级别的门禁限制，每个通过初步探测的 Gemini 对话模型还会在其首个可用区域额外执行一次 1-token 的 `generateContent`（Gemini TTS 则执行一次单词语音合成）。若某个模型仅因临时性错误（配额 429、网络故障、5xx）失败，它不会被丢弃，而是保留并标记为 `transient: true`：若该模型在内置目录中，则保留其内置目录区域；否则保留列出了该模型的区域。探测结论会原子写入并缓存至 `<magpie 配置目录>/vertex-ai/catalog-<project>-<fingerprint>.json`（按凭据身份隔离）。大多数探测请求免费；产生计费的探测开销极小（仅 1-token 对话、单词 TTS、单条向量嵌入探测）。启用自动发现（`autoDiscover`）期间，若缓存文件缺失或账龄超过 `discoverTtlHours`，插件会在后台刷新缓存，并在文件更新后立即重新加载。最终仅向用户提供经探测证实可调用或作为临时故障保留的模型。
- **手动发现（Manual discovery）**：运行 `bun scripts/discover.mjs --credentials <file> [--project <id>] [--dir <magpie config dir>]`（`dir` 默认为 `$XDG_CONFIG_HOME/magpie` 或 `~/.config/magpie`）。该脚本会打印可调用模型及其区域的汇总表格，并说明不可用模型的失败原因。

## 选项

可通过 `magpie plugin options magpie-vertex-ai '<json>'`（或在应用的 Plugins -> Installed -> Options 中）设置。代码中读取的默认值如下：

| 选项 | 默认值 | 说明 |
|---|---|---|
| `include` | 全部模型 | 精确模型键或 `/正则/` 字符串组成的数组；仅提供匹配的模型键 |
| `exclude` | 无 | 格式同上；在应用 `include` 之后移除匹配的模型键 |
| `regionVariants` | `false` | 为每个模型的每个服务区域额外暴露一个 `<key>@<region>` 模型 |
| `location` | `auto` | 登录时未固定区域情况下的首选区域；`auto` 会使用首个支持该模型的区域 |
| `autoDiscover` | `true` | 当缓存文件缺失或过期时启动后台模型目录发现 |
| `discoverTtlHours` | `24` | 重新触发自动发现的缓存有效期（小时） |
| `mediaDir` | `<magpie 配置目录>/vertex-ai/media` | 生成的图像、音频与视频的保存目录（按需自动创建） |
| `ttsVoice` | `Kore` | Gemini TTS 模型的预置语音名称 |
| `chirpVoice` | `Achernar` | Chirp 3 HD 语音名称；实际请求使用 `<language>-Chirp3-HD-<chirpVoice>` |
| `chirpLanguage` | `en-US`（中日韩文本为 `cmn-CN`） | Chirp 3 HD 的 BCP-47 语言代码 |
| `veo.durationSeconds` | `8` | 视频片段时长（秒） |
| `veo.aspectRatio` | `16:9` | 视频片段宽高比 |
| `veo.resolution` | `720p` | 仅发往 Veo 3+ 模型（Veo 2 会拒绝该参数） |
| `veo.generateAudio` | `true` | 仅发往 Veo 3+ 模型 |
| `veo.negativePrompt` | 无 | 作为 `negativePrompt` 转发 |
| `veoPollMs` | `10000` | Veo 异步任务的轮询间隔（毫秒） |
| `veoTimeoutSec` | `900` | Veo 轮询超时放弃的秒数 |
| `lyria.negativePrompt` | 无 | 作为 `negative_prompt` 转发 |

## 安全与账号隔离（2026-10-16）

- 令牌交换仅接受以下精确的 HTTPS 端点：`https://oauth2.googleapis.com/token`、`https://accounts.google.com/o/oauth2/token` 与 `https://www.googleapis.com/oauth2/v4/token`。省略 `token_uri` 时默认使用第一个端点；其他任何端点均会在发起令牌请求前直接报错拒绝。令牌交换、模型发现与推理请求均禁止重定向。
- 缓存中的模型 ID、发布者、模型家族与区域在使用前均经过校验。服务区域必须存在于 `lib/regions.mjs` 白名单中；如需使用新的 Google 区域，请先将其加入该文件。项目 ID/编号及资源路径段在拼接路径或 URL 前均经过校验。生产请求封装层还会对最终的 Google API 主机名、协议、端口和用户信息进行二次校验。
- 模型发现缓存按项目与凭据的 SHA-256 指纹进行隔离：`<magpie 配置目录>/vertex-ai/catalog-<project>-<fingerprint>.json`。手动发现脚本使用相同的命名规则。旧版仅按项目命名的缓存会被插件忽略；若设置了 `autoDiscover: false`，请使用相同凭据运行手动发现脚本以重新生成缓存。该指纹不包含明文密钥，但它只是稳定的标识符，并非加密。
- 新登录账号会在 `accountId` 中包含项目标识；具有相同 OAuth 客户端 ID 的 ADC 用户会通过刷新令牌（refresh token）指纹加以区分。升级后重新登录可能会在旧登录记录旁创建一个新账号。已保存的旧凭据仍可正常工作；确认新账号可用后，可通过 Magpie 移除淘汰的旧账号。
- 区域变体会在传递给插件的 API ID 中携带固定区域标识（`@region`）。带时间戳的音频转写在切换回退模型时会保留该固定区域，若回退模型不支持该区域，则会在上传音频前直接返回 HTTP 400。`location` 选项仍是支持故障切换的区域偏好；当登录区域设为 `auto` 时，`options.location` 会生效。请注意，这并非严格的数据驻留（Data Residency）合规策略：自动发现会探测多个区域，且 Chirp 始终使用全局 TTS API。
- 生成的媒体文件与目录缓存文件在创建时请求 `0600` 权限模式，新创建的目录请求 `0700` 权限模式。Windows ACL 及已存在目录的实际权限仍取决于运行环境。媒体文件采用独占创建模式以防止意外覆盖，且不会自动删除。
- 凭据 JSON 全文仍保存在账号的 `refresh` 字段中。[官方插件开发文档](https://usemagpie.ai/docs/zh/plugins)记录了 `plugin-auth.json` 及 `auth.refresh` 返回结果的合并机制；但这并不构成本机上的加密存储、Windows ACL 保护或备份/同步防护。

关于核验范围与回归检查详情，请参阅 [README.audit.md](README.audit.md)。

0.1.1 版本还在所有错误处理器中保留了上游重试响应头（如 `Retry-After`），为非流式 Gemini/媒体请求返回标准 JSON，在带时间戳的音频转写回退时使用当前账号的发现目录，支持带编码路径/文件名的旧式域作用域项目 ID（如 `example.com:project-id`），并在模型发现失败后退避 60 秒。流式请求仍保持原有的 SSE 行为。

## 运行限制

- magpie 仅将 `/v1/images/generations`（及 `/v1/images/edits`）和 `/v1/videos` 路由给其内置提供者；插件的 `fetch` 永远不会收到这些端点的请求。因此 Imagen 和 Veo 是作为**对话模型（chat models）**暴露的。（本插件未包含 Imagen：原作者项目中未开通任何 Imagen 模型，因此 `:predict` 图像路径未经过实测。）
- magpie 没有 `/v1/audio/speech` 端点，因此 TTS 同样作为返回本地文件的对话模型暴露。
- 未暴露 Gemini Live / 原生实时音频模型（基于 WebSocket 的 `BidiGenerateContent`）：magpie 不支持 WebSocket 透传，且 `generateContent` 会拒绝这些模型。
- 生成的媒体文件会写入本地磁盘（`mediaDir`）并以 `file://` 链接形式返回；插件不会将文件上传到任何地方，也不会自动清理这些文件。内联媒体块（`inlineData`）仅会传递给使用 Gemini 协议的智能体（详见上方表格）。
- `/v1/audio/transcriptions` 和 `/v1/audio/translations` 需要 magpie v0.1.1233 或更高版本；旧版本网关没有音频路由，会返回 404。
- 内置目录中的上下文/输出 token 上限是根据 Google 文档尽力整理的参考值；文档未公布上限的模型使用默认值。
- 直接执行不带模型名的 `magpie provider test vertex-ai` 会报告 `codeassist 404 · has no endpoint`：magpie 无法向任何插件提供者发送其 Gemini（CodeAssist）探测请求。请指定具体模型名进行测试（例如 `magpie provider test vertex-ai gemini-3.8-flash`），这会走 `/chat/completions` 并正常工作。

## 开发与测试

```sh
bun test
```

测试通过传入模拟的 `ctx.fetch` 拦截所有上游调用，不会发起任何真实网络请求。

若想在不影响本机现有配置的情况下使用真实 magpie 测试本插件，可在沙箱环境中运行 magpie（引自 magpie 插件文档）：

```sh
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add /path/to/magpie-vertex-ai
m plugin --json
m plugin login vertex-ai
m provider test vertex-ai
m provider test vertex-ai gemini-3.8-flash
```

## 许可证

MIT
