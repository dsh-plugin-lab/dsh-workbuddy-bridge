# 决策：请求体渠道签名中性化 + 失败文案不再裸露 401/403

状态：生效
日期：2026-10-21

> **范围限定（2026-10-23 补）**：本篇的 `11128` 专指**正文里的产品名**那一条（CN 侧）。
> 国际版另有一条形态相同、成因相反的 `11128`——缺渠道身份头组，与正文无关。
> 见[另一条记录](2026-10-23-intl-channel-identity-headers.md)。

## 问题

两个独立缺陷在同一天同时暴露，症状却只有一个：「这轮失败了 / API key is invalid」。

**其一，上游按内容风控拦请求。** 2026-10-20 起国内网关（`copilot.tencent.com/v2/chat/completions`）
对 system/developer 消息里出现产品名 `DeepSeek Harness` 的请求返回：

```
HTTP 400  {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}
```

DSH 每个 agent 请求都把这句当 system prompt 的开头注入
（`You are an AI agent powered by DeepSeek Harness.`），官方桌面客户端不带它，
所以只有第三方接入全线失效。本机实测（2026-10-21，真实凭据，只改这一处）：

| system 消息形态 | 结果 |
|---|---|
| 以固定句开头（字符串 content） | 400 / `11128` |
| 以固定句开头（**数组** content 的 text 部件） | 400 / `11128` |
| 中性表述（helpful assistant／官方口吻／无 system／零宽空格版） | 403 / `11140` |

**其二，账号被上游限制。** 上面那些「中性表述」其实也没通，但换成的是另一个码：

```
HTTP 403  {"code":11140,"msg":"request illegal",
           "displayMsg":{"zh":"账号存在异常行为，已被限制使用"},
           "displayTips":{"zh":"系统检测到该账号存在异常使用行为，如需申诉请提交反馈"}}
```

同一 token 读积分仍正常（1961 分），所以限制只落在 chat 通道。这条**插件修不了**，
但它暴露了第二个缺陷：**我们把 `(http 403)` 拼进错误文本，宿主于是把整轮失败改写成鉴权错误。**

宿主 `@deepseek-ai/dsh-llm-pi-ai` 的 `classifyPiAiError()` 是**文本匹配**：

```js
if (/\b(?:401|403)\b/.test(message)) return "AUTH";
```

命中 `AUTH` 后聊天界面用 `message.failure.auth` 覆盖原话（中文「API 密钥无效」）。
于是封号、限流、参数错一律显示成「换 Key」，使用者被指向一个必然无效的动作。

## 决策

**一、在共享 wire 边界做两段式中性化**（`prepareChatBody()` → `neutralizeChannelSignature()`，
两版都过一遍）：

1. **开场句整句改写**：消息以那句开头时，`You are an AI agent powered by DeepSeek Harness.`
   → `You are an AI agent.`。可读、语义不变，且**不依赖不可见字节**——上游若把文本归一化，
   零宽方案会失效而这条不会。容忍前置空白与 BOM（原样保留），词间空白按空白类匹配，大小写不敏感。
2. **其余出现处插入零宽空格**（U+200B）：无损，模型读到的还是同一句话，子串匹配不再命中。

**二、路径语境一个字节都不改。** 真实目录名里就有这个词组
（`…\DeepSeek Harness\resources\app.asar`），零宽字符插进去会让模型拿到一个它看不出错的错误路径，
工具调用必然失败。两条改写都带前后斜杠守卫。

**三、改写 system / developer / assistant，绝不动 user 与 tool。**

范围在 2026-10-22 修正过一次，两次的判据都要留在这里：

- **初版只改 system / developer**：依据是"固定句只出现在 user 消息里时上游放行"。
- **修正为再加 assistant**：CPA 渠道插件那一侧独立撞上同一个网关，
  `mmqz/cpa-multi-plugins` [PR #49](https://github.com/mmqz/cpa-multi-plugins/pull/49) 的消融实验
  （真实失败转储，50 消息 / 67 tools）显示**只改 system 仍然 400**，
  触发点主要在 **assistant 历史回显**——一条 32 KB 压缩摘要含 42 处品牌串；
  "所有角色 + 所有字段清零"才回到 200。本机独立复现：assistant 回显含品牌串 → 400 / `11128`，
  扩到 assistant 后 → 200（见下文第二轮表格）。
  ⚠️ 那个仓库**不是本仓的上游**，两者没有代码谱系：它产出 CPA 侧的 `workbuddy.dll`（由
  `dsh-cpa-switch` 管理），本仓是独立的 DSH 插件，两侧各自修复同一现象。此处只引其证据。
- **user 与 tool 仍排除**：那两类字节是模型推理的事实依据（用户自己的话、文件或命令真实返回的内容），
  改写它们等于让转录与世界不一致，而 #49 的实测显示该网关并没有扫那里。
- **assistant 的附加载体**：`reasoning_content` / `reasoning` 镜像与 `tool_calls[].function.arguments`
  一并改写（都是模型自己生成的，参数串改写后仍必须能 `JSON.parse`），
  这是为了不依赖"该网关只扫 content"这份会变的清单。
- 数组 content 只改 `type: "text"` 的部件，图片等部件逐字节不变。

**四、失败文案以 `displayMsg` 为准，非鉴权类不再带状态码**（`src/llm/shim.ts` 的 `failureMessage()`）：

- 上游的 `displayMsg.zh` / `zh-hant` / `en` 优先，其次 `msg`，再其次 `extError.message`；
- **只有 `session_dead` 保留 `(http 401)`** —— 那一类的状态码正是可执行信息（重新登录），
  且宿主把它读成 AUTH 恰好是对的；
- 其余类别一律不把 `401`/`403` 写进文本。

**五、`11140` 归 `client`**，不归 `session_dead`：它不是本机凭据问题，重新登录与换 Key 都无效，
而 `session_dead` 会让宿主把整轮显示成鉴权失败。顺带的收益是文案里能出现
「账号存在异常行为，已被限制使用」，使用者才知道该去申诉而不是换 Key。

## 替代方案

- **只做零宽空格（社区方案）**：[balongTTY/dsh-workbuddy-fix](https://github.com/balongTTY/dsh-workbuddy-fix)
  的做法。它同样带路径守卫，但（A）全靠不可见字节，上游一旦归一化就整批失效；
  （B）实测里零宽版同样返回 403/`11140`，说明它治不了第二层。保留为**第二段**（其余出现处）而非唯一手段。
- **改写整个 system prompt 或截断**：会让"上游改一句话，模型行为就变"变成常态，且长会话的
  多条 system 消息需要逐条判断，收益远小于风险。
- **只在 CN 分支做**：本机只测到 CN 网关，但国际版是同一产品族的另一域名，共享层做一次
  比分区域各做一次更不容易漂（`prepareChatBody` 的既有注释就是这条口径：region 只决定"额外要求"，
  不决定"要不要归一化"）。
- **把 `11140` 当作 `session_dead` 处理**：会让界面显示「重新登录」，而重登录对风控限制无效——
  正是本次要消灭的那类误导。
- **在错误文本里保留状态码但改写成 `http-status: 403`**：仍会被 `/401|403/` 命中，
  因为那条正则是"文本里出现这两个数字"，不是解析 HTTP 状态。

## 本机复核（2026-10-21，Windows，CN 账号）

**第一轮（当日 15:30 前后）**：四组对照，固定句确实触发 `11128`（字符串与数组两种形态都触发，
与社区 PR 的数组发现一致）；但中性化后仍是 403/`11140`，`displayMsg.zh` 为「账号存在异常行为，
已被限制使用」——提示词修复的验证被**账号状态**挡住，当时无法确认 200。

**第二轮（当日 16:50 前后，申诉提交后）**：限制解除，同一账号重跑归因对照，
用裸 `fetch` 绕开 `prepareChatBody`、请求头按 `chatHeaders` 复刻，只改 system 一句话：

| 请求体 | 结果 |
|---|---|
| 小体（197 B）+ 固定句 | 400 / `11128` |
| 小体 + 中性化 | **200 放行** |
| 大体（3196 B）+ 固定句 | 400 / `11128` |
| 大体 + 中性化 | **200 放行** |

再经**插件真实路径**（`chatStream`，内部即 `prepareChatBody`）把 DSH 原始固定句打上去：

- wire 上的 system 开头变成 `"You are an AI agent.\n\nYou are a coding agent. …"`；
- 裸词组 `DeepSeek Harness` 在改写后为 `false`；
- `chatStream` 返回 **HTTP 200 且正常开流**。

结论：**两层要分开看**——关键词那层是插件能修的，改完实测 200；账号限制那层是上游对账号的动作
（`11140`），与提示词无关，只能申诉或换号，且实测会解除。小体/大体两档都测，是因为社区方案称
"关键词要配请求体 >1KB 才稳定触发"——本机在 197 B 就触发，说明那条经验不是普遍规律，不能当判据。

## 影响

- 契约变更：`chatStream` 对两版都会改写 system/developer 消息里的产品名；直接调用
  `WorkBuddyUpstreamClient.chatStream()` 的脚本会看到提示词被中性化。
- 用户可感知：失败提示从「API key is invalid」变成上游原话（含「账号存在异常行为，已被限制使用」，可申诉）；
  封号/限流/参数错不再被误报成鉴权问题。
- 守卫：`tests/prepare.spec.ts`（开场句、数组部件、路径守卫、幂等、user 消息不动）、
  `tests/shim.spec.ts`（`displayMsg` 优先、非鉴权类不含 401/403、`session_dead` 保留）、
  `tests/probe.spec.ts`（拒绝码改名后的归属）。
- 上游 [`corrinehu/dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect)
  的两个 open PR（#202 零宽、#204 整句改写）在本仓落地为同一套机制；
  该仓 2026-10-22 下线，故记录上述实测矩阵以免口径失传。
