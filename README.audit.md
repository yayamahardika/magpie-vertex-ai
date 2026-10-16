# magpie-vertex-ai：插件规范核验与修复记录

修复日期：2026-10-16。范围：当前目录中的完整插件源码与测试。

## 本次核验依据

已读取用户指定的 [Magpie 中文插件开发文档](https://usemagpie.ai/docs/zh/plugins)，核对插件入口、模型 API ID、账号作用域、登录续期和请求接口。

初次修复工作目录是无 `.git` 的源码快照。复审发布时从 `yayamahardika/magpie-vertex-ai` 克隆，核实其 main 为 `4edf85f45fc602d5921de795a5395e553f308dfa`，并保留既有历史。下方旧报告的 5 文件快照、Git blob 校验和 7 项离线行为属于历史记录。旧报告中的 `security-checks.mjs`、`blob-verification.json`、`LICENSE.upstream` 不在当前目录；本次不再将它们作为依据。当前许可证为根目录 `LICENSE`。

## 官方规范确认

- 入口只导出一个插件函数，测试辅助入口 `_internal` 是对象，符合模块加载要求；`config` 使用 `??=` 保留用户配置。
- OAuth 回调的自定义字段会与 `refresh/access/expires` 一起保存；`auth.refresh` 返回字段会合并进原账号。因此只返回新的 `access/expires` 不会删除原凭据、项目或区域。
- 官方说明 `plugin-auth.json` 位于配置目录，权限模式为 600。这是官方约定，本次未实测宿主文件权限、Windows ACL、加密或同步/备份行为。
- `provider.models` 按账号调用；相同 `accountId` 的新登录会替换已有账号；模型 API ID 会进入请求。因此账号状态必须隔离，区域不能仅保存在模型显示名/键中。

## 本次已修复

| 问题 | 修复与验证 |
|---|---|
| 自定义 `token_uri` 外传风险 | 精确允许 HTTPS Google OAuth 端点；解析、换令牌前双重检查；禁止重定向。HTTP、恶意主机、用户信息、额外端口、查询/片段及缓存命中绕过均有回归测试 |
| 缓存区域可改变请求主机 | 校验缓存 schema、区域白名单、资源段、家族/发布者关系和项目；生产请求再次检查最终 HTTPS 主机、端口及用户信息。污染区域、路径穿越、畸形缓存和项目/账号不匹配均有回归测试 |
| 区域变体丢失固定区域 | `api.id` 携带 `@region`；通过模拟宿主请求和真实路由，覆盖 Gemini、MaaS、带版本 Claude，验证 429 后不跨区域 |
| 时间戳转写回退丢失固定区域 | 切换模型后保留 pin；回退模型不支持该区域时，在发送音频前返回 400。两条分支都有回归测试 |
| ADC 用户身份和令牌缓存冲突 | ADC 身份加入 refresh token 指纹；新账号 ID 加入项目；令牌缓存使用完整认证材料的 SHA-256。相同 client ID、相同 token 后缀的两个用户隔离验证通过 |
| 同项目不同凭据共用发现缓存 | 文件和内存状态按项目/凭据指纹隔离；手动和后台发现命名一致；发现完成后释放进行中标记，后续过期可再次发现。账号隔离已离线验证，TTL 再启动分支为静态核验 |
| 登录 `auto` 屏蔽 `options.location` | 未固定登录区域时采用选项偏好；通过真实 loader 验证目标区域 URL |
| 故障响应丢失重试信息 | 保留 `Retry-After` 等响应头，重建正文时移除过期长度和编码头；已测试 |
| 媒体写入权限和覆盖风险 | 请求目录模式 0700、文件模式 0600；媒体独占创建；发现临时文件使用 UUID。已有媒体/发现测试通过，未实测 Windows ACL |

允许的令牌端点为 `https://oauth2.googleapis.com/token`（默认）、`https://accounts.google.com/o/oauth2/token` 和 `https://www.googleapis.com/oauth2/v4/token`，后两者用于旧 Google 配置兼容。

## 本次验证与升级影响

初次修复使用 Bun 1.4.3 运行 `bun test`：298 通过、0 失败、15 个测试文件。复审后为 **321 通过、0 失败、16 个测试文件**。使用假凭据、假响应及临时 RSA 密钥；请求均被 mock 截获，不调用真实 Google API。新增 `test/security.test.mjs`、`test/review-regressions.test.mjs`，并更新旧测试的行为预期。

## 第二轮审查（0.1.1）

新增用例在修改前复现 17 项失败（含同一问题的多模型用例），修复后与全套测试一起通过：

- 错误处理器在转换协议时再次丢弃 `Retry-After` 等头。现统一保留上游头并移除过期的正文长度、编码、摘要/ETag；覆盖八类实际路由。
- Gemini 非流式请求仍转成 SSE。现调用 `generateContent` 并返回 JSON；TTS、Lyria、Veo 的非流式回复也返回完整 Gemini JSON，流式路径保持 SSE。
- 时间戳转写的模型回退绕过账号发现目录。现使用账号目录中的回退模型及其区域；缺少回退模型时，在上传音频前返回 400。
- 新项目校验拒绝合法的旧式 `example.com:project-id`。现校验域项目格式，并分别编码 URL 路径和缓存文件名，兼容 Windows，继续拒绝路径穿越。
- Windows ADC 默认路径错误且忽略 `CLOUDSDK_CONFIG`。现支持配置目录覆盖、Windows `%APPDATA%\gcloud` 及 Linux/macOS 默认目录；路径中的 `~\` 同样展开。
- 发现完成标记释放后，失败调用可能被立即反复启动。现失败后退避 60 秒；测试覆盖退避、恢复及后续再次刷新。
- 媒体处理器将 AbortError 转成可重试 502。现取消请求会继续抛出，覆盖 Gemini TTS、Chirp、Lyria 和 Veo。
- 已知模型的缓存 family 可与真实目录矛盾。现拒绝这种配置。

发布元数据改为目标 fork，版本更新为 0.1.1，并在包文件清单中补上图标 assets 和本审核文档；保留上游署名和许可证。

Windows 沙箱默认临时目录的 rename 曾返回 EPERM；将测试 TEMP/TMP 指向工作区内临时目录后运行，没有改变生产原子写入逻辑。测试工具在被忽略的 `.tools/` 下，不构成插件运行时依赖。

- 正式插件改用 `catalog-<project>-<credentials-fingerprint>.json`。旧项目级缓存被忽略；关闭自动发现时，用相同凭据运行手动发现填充新缓存。没有有效缓存时仍回退静态目录。
- 新 `accountId` 包含项目和 ADC 用户指纹；重新登录可能在旧账号旁创建新账号，确认可用后可通过 Magpie 移除旧记录。已有登录凭据仍可读取。
- 凭据全文仍交由宿主保存，未迁移到系统凭据库；普通 `location` 仍允许区域故障切换，自动发现会探测多个区域，Chirp 使用全局 API。此修改不构成全面地域合规策略。
- 上游错误和路径未做全面脱敏；媒体不会自动清理；区域白名单需要随 Google 新区域更新。
- 发布前检查了 npm 包文件清单、实际发布副本的测试和 Git 差异，并扫描待上传文件与全部可达历史 blob 的常见私钥、GitHub token、Google API key/access token/ADC refresh token 格式；未发现匹配。工具、临时目录和诊断结果不在上传清单内。
- 本次未执行真实 Magpie 宿主集成、真实登录/云端推理、宿主源码审计、JWT 重放或安装后的运行验收。模型可用性、价格和额度未通过插件开发文档核实。

---

# 历史审核原文（修复前快照，不代表当前项目状态）

审核日期：2026-10-16

仓库：HzTTT/magpie-vertex-ai

对应提交：4edf85f45fc602d5921de795a5395e553f308dfa（提交日期 2026-10-15）

## 结论和范围

这不是完整仓库，也不是修复版插件。它包含本次离线复现使用的 5 个原始模块、校验清单、测试脚本和结果。

此次源码审核没有发现明确的作者主动窃密代码。正常模型调用发送给 Google API；用户提交的对话、上下文和附件会随推理请求上云。但代码存在需要加固的信任边界：凭据 JSON 的 token_uri 未受限制，模型缓存里的 regions 也未经过可信区域校验。完整凭据 JSON 会作为 refresh 交给宿主保存。

前两项外传风险都有前提：攻击者必须先影响相关凭据配置或本地模型缓存。这里没有证明无权限远程利用，也没有证明普通聊天文本能直接篡改上述文件。

## 运行验证

使用已安装的 Node.js 22 运行：

```sh
node security-checks.mjs
```

不需要 npm install。测试中的令牌、客户端密钥及提示词全部为假数据；RSA 私钥在进程中临时生成。native fetch 被禁用，所有请求都由 mock 截获，没有连接真实 Google API，也没有请求测试域名。

测试脚本运行前会校验 5 个原始文件的 Git blob SHA。它们均与 GitHub 返回的对应版本一致。清单在 blob-verification.json。

## 已确认的 7 项行为

1. authorized_user 的 client_secret、refresh_token 会被发往自定义 HTTPS token_uri。
2. HTTP token_uri 也能通过校验并进入请求路径。
3. 登录回调将完整凭据 JSON 原样返回在 refresh 字段。
4. service_account 认证发的是签名 JWT，不是原始私钥；自定义 token_uri 同时被写入 JWT 的 aud。这不证明该 JWT 能在 Google 重放。
5. 含斜杠的异常区域值能令 URL 的实际 hostname 脱离 Google。
6. 原始 MaaS 处理器会对上述主机携带 Bearer token 和提示词正文。
7. 普通 location 偏好在 429 后会继续尝试其他区域；一般 pinned 分支才返回单一区域。

这 7 项不是 7 个独立漏洞。其中包括同一问题的多个验证，以及用于排除误判的正常行为检查。

## 关键静态调用链

- 认证：lib/auth.mjs 的 parseCredentials / mint。
- 凭据交给宿主：lib/auth.mjs 的 signInWith -> callback -> refresh: text。
- 缓存区域污染：index.mjs entriesFor -> lib/catalog.mjs loadDiscovered / mergeDiscovered / discoveredEntry -> lib/failover.mjs regionsFor -> lib/regions.mjs hostFor / locationBase -> 各模型处理器。
- 后两阶段（URL 和 MaaS 处理器）进行了原码离线测试；缓存文件加载和合并链路仅做静态审核，没有在完整 Magpie 中端到端执行。
- 区域注意点：lib/handlers/transcribe.mjs 的带时间戳转写分支会切换到 gemini-2.5-flash，并在切换时不保留原 pinned。

## 其他审核观察

- 正常出站：oauth2.googleapis.com、aiplatform.googleapis.com 及各区域端点、texttospeech.googleapis.com。
- package.json 中的远程图标指向 raw.githubusercontent.com；插件配置了 @ai-sdk/* 适配器，但没有声明直接运行时依赖或安装后脚本。
- 发现请求使用固定的 hi，不抽取用户聊天内容；它会主动联网并进行部分真实模型调用。
- 生成媒体落本地，没有自动清理；写入时未显式指定 0600，权限依赖运行环境。
- 部分上游错误、路径会进入日志或返回内容，没有统一的敏感信息脱敏。
- README 声称宿主将完整凭据保存于 plugin-auth.json、权限 0600；本次没有核验宿主真实的存储实现、操作系统 ACL 或同步/备份行为。

## 建议修复

- 将 token_uri 限制为明确允许的 HTTPS Google 令牌端点，对不符配置报错；敏感请求使用 redirect: "error"。
- 校验缓存 schema、区域白名单、项目 ID；构造 URL 后再次校验协议、主机、端口及用户信息。不能仅凭 URL 字符串包含 googleapis.com 放行。
- 避免把长期凭据重复保存于普通配置文件；采用受保护的凭据引用或系统凭据库，并审计宿主。
- 严格地域要求应覆盖所有处理器、自动发现和模型回退，而不只设置 location。
- 使用专用、最小权限身份和隔离运行环境。不要直接复用高权限个人 ADC。
- autoDiscover: false 仅关闭主动探测；它不会阻止正常推理联网，也不会禁止加载已有缓存。

## 局限

未进行完整 Magpie/Bun 集成运行、真实云端请求、Google JWT 重放、宿主源码审计、完整 Git 历史分析或发布产物对比。本次结论不涵盖宿主遥测、系统代理、其他插件或未来更新。

lib/ 下的文件版权归上游作者所有，适用 LICENSE.upstream。security-checks.mjs 为本次审核新增的测试脚本。
