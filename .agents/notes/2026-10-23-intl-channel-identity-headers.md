# 决策：国际版 chat 注入 trace / conversation 身份头组

状态：生效
日期：2026-10-23

## 问题

2026-10-23 起，国际网关（`www.workbuddy.ai/v2/chat/completions`）对 chat 请求做**渠道校验**：
同账号、同凭证、同 UA、同 body，缺身份头就回

```
HTTP 400  {"code":11128,"msg":"request illegal","displayTips":{"zh":"这次调用没通过渠道校验，可能不是官方客户端发出的。"}}
```

症状与 2026-10-21 的那条 `11128` 一模一样，成因完全不同：那条是**正文里的产品名**
（见[决策记录](2026-10-21-channel-signature-and-error-text.md)），这条是**请求头缺件**。
本仓原来把 `11128` 一律理解成前者，所以排查方向整个是错的 —— 补 `neutralizeChannelSignature()`
对这一条毫无作用，干净最小请求同样被拒。

独立复现两份，方法不同：#21 作者做的是「只加减身份头、其余恒定」的对照，
另一位用插件自己的 `chatStream` 打线上网关做**逐个移除**的消融实验。两者的共同结论：
与 model、消息内容、UA 版本号都无关，只有国际版分组被拒，CN 同机正常。

## 决策

`chatHeaders()` 经 `channelIdentityHeaders()` 注入五个头，**每请求现生成**：

| 头 | 形态 |
|---|---|
| `X-Trace-ID` | 32 位小写 hex（OTel trace-id） |
| `X-Request-ID` | v4 UUID |
| `X-Conversation-ID` | v4 UUID |
| `X-Conversation-Request-ID` | v4 UUID |
| `X-Conversation-Message-ID` | v4 UUID |

三个配套判断：

- **只注入 global**，条件是 `regionOf(credential.domain) === 'global'`——与 `chatBase()` 同一判据。
  CN 的 wire 保持逐字节等于今天实测通过的形态。
- **保留五个而不是三个**：消融实验显示只发三个 `X-Conversation-*` 当前也能过，
  但网关最可能收紧的正是 trace-id 格式（要求合法的 OTel trace id），届时"最小可行集"又会坏掉。
  靠拢官方 App 的实际发送形状，比赌网关当前宽松更稳。
- **`probeEffort()` 共用 `chatHeaders()`**，所以国际版的推理档位探测从「静默 `unknown` / `efforts: []`」
  一并恢复。这是同一次修复的副作用，不是另一件事——发版说明里要单独提，
  否则用户只会发现「检测」按钮突然能用了，却联系不到成因。

## 替代方案

- **最小可行集（只发三个 `X-Conversation-*`）**：当前能用，但把"网关今天不校验 trace id"当成契约。
  官方 App 五头俱全，网关收紧时最小集必坏，且坏的形态（`11128`）与现在这个坑一模一样、更难查。
- **CN 也注入，两版统一**：CN 没有要过这组头，实测现状 200。统一注入等于把一个未验证的变更
  塞进一条本来正常的链路，收益为零。这与 `prepareChatBody()` 那条"两版共用"的口径**不冲突**：
  共用的是**归一化**（去掉上游不接受的东西），头组是**区域专属要求**，性质不同。
- **继续按提示词风控思路修**：方向错误，会同时污染 `neutralizeChannelSignature()` 的改写范围。
- **等上游放开**：`11128` 是硬拦截，没有退路；而 CN 正常意味着插件整体没坏，用户只会以为是自己配置错。
- **`X-Product-Code` / `X-IDE-*` / `b3` 等其余候选头**：实测补上仍 `11128`，
  逐个移除任何一个仍 `200`——都不是校验所必需的，不加。
- **`11158`（套餐不包含该模型）一起处理**：`displayMsg` 为「你的账号类型不支持该模型」，
  是账号等级权益校验，改任何请求头都修不好。它与本条正交，单独跟踪。

## 影响

- 用户可感知：国际版分组从「每轮 400」恢复可用；推理档位探测同时恢复。
- 契约变更：`chatStream()` 与 `probeEffort()` 在国际版下多带五个头；
  直接调用 `WorkBuddyUpstreamClient` 的脚本会看到它们。
- **真机回归由受影响的用户执行**：国际版链路的验证证据来自 #21 的复现者与 #22 的独立复现者，
  本仓本机只验到 CN 未受影响。所以发版说明的口径是"请两位回验"，**不是"已验证"**。`0.5.4` 即按此写。
- 守卫：`tests/chat-identity-wire.spec.ts`（五头形态 / 每请求不复用 / CN 无五头）。
- 未覆盖：macOS / Linux 平台行为（纯 JS 逻辑，无平台分支）；`11158` 分类待单独修。
- 文档落点：[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)「`11128` 有两个来源」与
  「渠道身份：国际版要求 trace / conversation 头组」；根 [AGENTS.md](../../AGENTS.md) 活跃坑首条。
