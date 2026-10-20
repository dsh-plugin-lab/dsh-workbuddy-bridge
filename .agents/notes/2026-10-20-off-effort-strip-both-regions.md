# 决策：`off` 的 strip 从「仅国际版」扩到两版

状态：生效
日期：2026-10-20

## 问题

`thinkingLevelMap.off` 被钉成字面量 `'off'`，而 pi-ai 把同一个条目不只用在这个档位上：用户显式选 Off 时发它，
**任何没指定档位的请求也自动发它**。这个拼写被上游拒绝时会同时打断两条路径——显式选档与环境默认路径。

**issue #49（2026-09-23，国际版）**已经证过一次：国际端点对 GPT 系回 400 / `11133`，当时的修复是把 strip
放进 `prepareInternationalChatBody()`，**CN 一行不碰**。理由写在[归档记录](../../docs/archive/reasoning-effort-off-wire-issue-49-2026-09-23.md)
里：CN 侧历次实测 `'off'` 都返回 200，且维护者要求"国内版保持原样"。

**issue #13（2026-10-19，CN）**把这个前提打掉：`deepseek-v4.1-flash` 选 Off 后每个请求
400 / `{code:11133,msg:"the request parameters were rejected by the model provider"}`；同一模型的对照是
`'disabled'` 也 400、`'none'` 200。报告者还给出另一层证据：`kimi-k2.8-preview` 返回 200 但 `off` 被**静默忽略**，
思考照常——即"接受"从来就不等于"生效"，CN 侧当年的 200 只说明参数没被拒，不说明 Off 做了什么。

本机实际目录也确认了影响面：`.workbuddy-catalog.json` 里 `deepseek-v4.1-flash` / `kimi-k2.8-preview` /
`glm-5.3-flash` 三行都是 `canDisableThinking: true`，也就是国内版能选到 Off 的模型**全中招**，
而不是某个模型的孤立问题。

## 决策

**把 strip 从 region 分支里提出来，放进两版共用的 wire 边界。**

- `dropUnsupportedEffort()` 仍是一个只认字面量 `'off'` 的三行函数，但它现在由 `prepareChatBody()` 调用，
  而不是由 `prepareInternationalChatBody()` 调用。
- `chatStream()` 对两个 region 都过一遍归一化：`global` 走 `prepareInternationalChatBody()`（内部先调共享那层），
  `cn` 走 `prepareChatBody()`。归一化是幂等的，shim 已经准备过的 body 不会二次变化。
- region 从此只决定**额外要求**（国际版要多补一条 system 消息），不再决定"要不要归一化"。
- **`'none'` 保持透传**：它是用户能显式选的值，不是适配层自己的拼写。而且它并不是安全替代——`gpt-6-astra`
  拒它，`kimi-k2.8-preview` 收下却忽略，所以"把 off 改写成 none"会在另一批模型上制造新的坏法。
- **`off` 仍不进探测候选**：探测只能证明"上游收下这个拼写"，#13 里的 kimi 就是现成的反例
  （200 但思考没关）。探测系统第一条原则是"接受 ≠ 生效"，把 `off` 塞进候选会公开违反它。
- **语义降级要写清**：Off 现在的准确含义是"不发送 `reasoning_effort`"，实际行为由上游决定。

## 替代方案

- **保持"仅国际版 strip"，CN 只改文案**：治标。CN 用户每次选 Off 都拿 400，而错误文案
  （"请求参数有误，请检查请求后重试"）不点名 `reasoning.effort`，用户无从推断。
- **`off: null`（两版都不提供 Off 档）**：能根治，但代价是选择器里彻底没有 Off——那些确实靠省略
  实现"不思考"的模型（#13 的 `none`/省略对照里 200 且无 reasoning 帧）用户反而没入口了。
  而且它同时砍掉自动发送分支，属于把"修 wire"换成"砍功能"。
- **`off → 'none'`**：`gpt-6-astra` 连 `'none'` 都拒（#49 实测），会把"部分模型坏"变成"另一批模型坏"；
  `kimi-k2.8-preview` 收下但忽略（#13 实测），是静默假成功。报告者自己也在 #49 撤回过这个建议。
- **按模型写死映射（GLM 发 `'off'`、GPT 不发）**：静态快照反模式。供应商分化本身就证明快照必过期，
  而 roster 的日级翻转已经教过一次。
- **把 `off` 纳入探测，只发布上游真正接受的拼写**（#13 建议的方向之一）：两个前置问题没解，
  见归档记录 §6——(A) 接受 ≠ 生效，探到 200 证明不了思考被关；(B) pi-ai 耦合，把胜出的拼写填回
  `thinkingLevelMap.off` 会同时恢复"未指定档位时自动发送"那条分支，等于把这次的放大器装回去。
  要做得先设计解耦手段，目前没有。

## 本机复核（2026-10-20，Windows，CN 账号）

`deepseek-v4.1-flash`，经插件真实请求路径（`chatStream` + 真实凭据与请求头），只把 effort 字段注入/省略：

| wire 形态 | 结果 |
|---|---|
| `reasoning_effort: "off"`（修复前会发出的形态） | **400 / `11133`** `the request parameters were rejected by the model provider` |
| `reasoning_effort: "disabled"` | **400 / `11133`** |
| 字段省略（修复后的形态） | 200，流式 3261 B |
| `reasoning_effort: "none"` | 200，流式 3260 B |
| `reasoning_effort: "low"` | 200，流式 3931 B |

两条读法：**修复前的 wire 确实必 400**（与 #13 的表格逐格一致），**修复后的 wire 确实 200**。
`'none'` 只能说明"这个模型收下它"，不能说明思考被关掉——#13 里 `kimi-k2.8-preview` 就是收下却忽略的反例，
所以它不构成把 `off` 改写成 `none` 的理由（见下文替代方案）。

## 影响

- 契约变更（`docs/ARCHITECTURE.md` 的「兼容性契约」已同步）：`chatStream` 对两个 region 都归一化请求体，
  CN 的 wire 不再是"原样透传"。直接调用 `WorkBuddyUpstreamClient.chatStream()` 的脚本会看到
  `stream: true` 被强制补上——shim 路径本来就会补，行为一致。
- 用户可感知：两版选 Off 都不再 400；但"Off 不保证关闭思考"这条限制从国际版**扩到两版**。
  这是把一句本来就不成立的承诺收回，不是新引入的缺陷。
- 守卫：`tests/prepare.spec.ts`（共享层 strip + `none` 透传）、`tests/upstream.spec.ts`
  （`chatStream` 层两版都 strip）、`tests/chat-identity-wire.spec.ts`（CN body 归一化后的形状）。
  原来那条"CN keeps the `off` spelling"的断言被**删除**而不是改写——它钉的正是导致 #13 的行为。
- 真机复核的落点是这条记录本身，不进 CI：它需要真实凭据，托管 runner 上跑不了
  （同 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)「已知未覆盖」的口径）。
- 归档的 #49 记录**不改**：它写的是当时的事实（当时 CN 确实 200，当时确实按区域拆分）。
  结论变了就新写这一条并反向引用。
