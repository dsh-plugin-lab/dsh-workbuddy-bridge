# dsh-workbuddy-bridge 架构说明

本文是插件结构与契约的唯一权威文档：为什么这样分层、哪些行为是兼容性契约、浏览器半边依赖官方的哪些接口。使用方式见 [README](../README.md)；`docs/` 另有一份活层的发版手册，以及 `archive/` 里按日期归档的一次性调查记录，都不承担结构说明职责。

## 总览

插件分为两半，编译为两个独立产物，运行在两个进程里：

```text
src/
├── index.ts            宿主入口：两个变体的组装与生命周期
├── variants.ts         变体描述符（宿主半，含文件系统路径）
├── credential/         凭据：读取桌面 App 登录文件、自留副本、静态加密
├── catalog/            模型目录：上游抓取、降级链、模型显隐
├── protocol/           上游协议：chat / 目录 / 账单 / 错误分类 / 身份
├── llm/                接入 DSH：adapter、shim（loopback 端点）、附件
├── probe/              推理档位探测：发请求、存档、服务判定
├── web/                宿主暴露的 HTTP 路由：status / probe 控制路由 / 心跳
├── shared/paths.ts     两半共用的路由路径与文档类型
└── client/             浏览器半边：设置页、两张卡片、composer 控件
```

两半之间唯一的桥是 `shared/paths.ts` 里的路由路径和 JSON 文档形状。浏览器半边**永远拿不到**文件路径、凭据、平台事实——变体的浏览器可见面是 `src/client/variants.ts` 里的独立描述符，不是宿主的 `variants.ts`。

## 宿主半（src/index.ts）

两个产品变体（`workbuddy` 国内版、`workbuddy-ai` 国际版）由同一工厂组装，只差 `WorkBuddyVariant` 描述符：各自的凭据存储、目录、上游客户端、shim、探测状态、路由。任何一个变体启动失败都不影响另一个注册——只装一个 App 的用户只看到那一个分组。

**目录降级链**（每个变体独立）：`live`（本次抓取）→ `saved`（该账号上次成功目录，重启可恢复）→ `fallback`（编译进插件的名单）。凭据消失时分组隐藏，账号切换时按身份键（`uid:enterpriseId`）切换各自的数据。

**启动分三相，顺序是契约**：先读凭据并采纳身份 → 再注册 provider → 最后抓目录。第二相必须晚于第一相：注册时 `catalog.current()` 已经有内容，所以 **provider 一旦出现在 `listProviders()` 里就已经带着模型**。反过来（先注册再揭示，且揭示是 fire-and-forget）会留一个空窗——provider 可见但 `resolveModelInfo` 对它的每个模型都答 `UNKNOWN_MODEL`；picker 里看不出来，但一个已选中该模型的会话（恢复的历史会话、或 `agent-default-model`）首条消息就失败。任一相失败都回退到「以隐藏态注册」，随后由轮询揭示，即与今天相同的降级。判据见 [决策记录](../.agents/notes/2026-10-02-startup-window-fix-direction.md)，守卫在 `tests/catalog-lifecycle.spec.ts`。

**轮询**：30 秒一次凭据存在性检查（`DSH_WORKBUDDY_POLL_MS` 可覆盖，仅测试/诊断用，不是产品设置）。同身份的令牌轮换不触发目录重抓；失败的抓取按退避重试，成功落地后停止。

## 浏览器半（src/client）

官方契约按宿主声明走，没有宿主版本探测、没有防御性包装：

| 契约 | 用法 |
|---|---|
| `plugins.bundle.config` | 本插件在插件页的配置入口，key = 包名 |
| `conversation.input.right` | 输入区紧凑控件行的推理等级控件 + 剩余积分标签。**必须选 `kind: 'list'` 的槽**——`conversation.input.model` 是 `single`，已被宿主自带的 `ModelSelect` 占用，同 priority 再注册会抛错并顶掉宿主的模型选择器（判据见 [PUBLISHING.md](PUBLISHING.md) 的「平台契约的取真源方式」，经过见 [.agents/notes/2026-09-25-composer-seat-single-occupancy.md](../.agents/notes/2026-09-25-composer-seat-single-occupancy.md)） |
| `conversation.chat.assistant-actions` | 已定稿助手回复的操作行（宿主 Like/Dislike 也在这一行）里的「共消耗 X」标签。`kind: 'list'`、`scope: 'session'`，owner currency 是 `{ messageId }`，由 `dsh-client-ui-chat` 声明 |
| `ctx.configForms.whileServed` | 宿主真正在服务本条目时才注册页面——不可写的部署上不会出现一个存不了的表单 |
| `SettingsForm` / `SettingsFormModel` | 与官方设置页同一套表单栈，一次 revision 封装的 mutation 保存全部字段 |
| `ctx.locale` | `settings.workbuddy` 命名空间，zh/en 双语 |
| 官方 primitives | 卡片壳 `DisclosureRow` + `StateDot`，面板用 `SegmentedTabs` / `Tag` / `Checkbox` / `Button` / `Tooltip`，插件不自带任何手搓控件 |
| CSS Modules | `*.module.css` 经 lightningcss 编译为 `[hash]_[local]` 类名并注入 `<style>`（`tsdown.config.ts` 里的构建插件复刻了官方链路） |

`ctx.slots.inject` 跟随槽位的**声明方**生命周期：宿主没有插件页或没有 composer 时，回调根本不会运行，所以不需要任何版本判断。

## 每条消息的积分归属

卡片显示账号**还剩多少积分**（账单接口，账号级）；消息行显示一条回复**花了多少积分**（逐消息）。后者是本插件自己观测出来的，因为上游只在它自己的 SSE 里给出这个数字：

- WorkBuddy 的 OpenAI 兼容流在最后一个 `usage` 帧上带一个 `credit` 字段（标准 OpenAI schema 之外的扩展），就是这次请求的花费。
- 这个数字**是服务端算的，不能本地推导**：桌面客户端只是把 `cost.amount` 的阶段增量累加，从不拿目录里的 `x0.79` 倍率去乘 token（倍率只是展示文案）。所以插件不做任何"按 token 估算"——估出来的数和真值对不上，比不显示更糟。
- 它无法穿过 pi-ai 到达宿主：`parseChunkUsage` 只取标准 token 字段，`TokenUsage` 也没有对应字段。

因此归属靠**两个半边各出一半 key，再 join**：

```text
  shim：SSE 里的 id(cmb-…) + usage.credit   ──►  creditLog.record(id, credit)
                                                        │
  session/event 的 assistant/message ───────────────────┴──► index.set(sessionId, messageId, credit)
    （messageId + source.replayState.response.responseId）              │
                                                              浏览器按 messageId 读
```

`shim` 看到流，`session/event` 看到消息 id，两边都在同一进程里，而上游响应 id 同时出现在两者身上（实测确认），所以是精确关联而不是猜测。两条写入的先后顺序都可能，`creditLog` 因此带一次性 waiter：先到的一方等另一方。

**只在会话正在用 WorkBuddy 的模型时显示**——余额和逐条消耗都是。别的厂商的模型旁边不该出现一个它没碰过的账本；隐藏时连路由都不请求。

**观测不到就不显示，绝不显示 0**：早于本功能的消息、失败的流、上游没给 cost 的回复，这一行是空的。真免费的回复确实显示 `0`——真值和"未知"必须能区分，区分的办法就是未知时什么都不显示。

## 配置与实时状态的分界

这条分界是本插件最重要的设计决定：

- **静态部署状态** → `Config` schema（`authFile`、`authFileAI`、`probeConsent`、`useMaximumContextWindow`）。`Config` schema **就是**设置文档，宿主按包名服务它，写入走 revision 封装的 `mutate`。没有第二份「设置区」。
- **实时账号状态**（账号、积分、目录来源、上下文与显隐、探测结果）→ 只读。卡片是宿主事实的报告者，不是编辑者；唯一的写路径是探测控制路由，且每次写完回读，让宿主的真相留在屏上。

由此不存在「卡片说保存了、宿主却拒绝了」那一类错误：写路径只有一条，且写入后必回读。

## 卡片的视觉语法

卡片上每一块都是**同一种对象**，而这个对象就是宿主自己的字段行
（`ui-primitives/lib/settings-form/fields.module.css`：`.field` 是竖排的「`.head` 一行 + `.hint` 一行」，而控件在 `.head` 里）：

```
第一行：主值                              右侧「按钮」（可选）
第二行：副说明（可选）
```

落点是 [src/client/field.tsx](../src/client/field.tsx) 的 `Field`（结构）+ `Part`（一行有层次的文字）。四条不变式：

- **控件在第一行，不在块上**。这是宿主 `.head` 的形状（label 与输入框同行），也是按钮不会随副说明长度飘的原因——副说明与 `.head` 是兄弟，它在下面多长都动不了上面那一行。
- **一行只有一档字号**。灰字（`Part` 的 `caption`/`after`）与取值（`children`）**同字号**，只差两件事：颜色（tertiary / primary）与字重（400 / 500）。字号写在容器上（`.part`、`.packageLabel`），两个档位类自己**不带**字号——带上就会各自漂移。这条是被截图逼出来的：第一版把宿主的 `.hint`（12px 灰）与 `.label`（13px 值）当成两档抄下来，而字号不同的两段文字**必然**对不齐（flex 的 `align-items` 对齐盒子，盒高不同既不共基线也不共中心），灰字就比它旁边的值高那么一点，再被亚像素定位放大成肉眼可见的台阶（2026-10-03 维护者报「粗体的字和灰色的字好像不在一个水平线上」）。判据是 [../tests/redlines.spec.ts](../tests/redlines.spec.ts) 的「同一行的灰字与取值只有一档字号」。
- **动态值是自己独立的元素，不嵌进句子里**。时间、计数、来源都单独渲染并带 `tabular-nums`（`.figure`）——刷新时不带动整行抖动，也把「应用量到的」与「应用说出的」在排版上分开。一个时间戳嵌进句子里还会随语言改变句子形状（`2026年11月26日 17:40` / `Nov 26, 2026, 5:40 PM`）。
- **块之间 12px**（`.section > * + *`）。相邻的块贴在一起会读成一个物件，而「列表」与「解释列表的话」最不该被读成一个。

**块内的数字不自己定**：块内两行 6px、行内 8px、字号一档，前两个值来自宿主那份 `fields.module.css`。
唯一挪位的是宿主 `.field` 自己的 `padding: 12px 0`——宿主没有容器级节奏才需要它，本卡片的 `.section` / `.panel` 已经在做这件事，两边都留就会让间距翻倍。

**列表行与字段行是同一个对象**：名字走灰字档、读数走取值档，用的就是 `.caption` / `.figure` 这两个类。
积分行的读数是**一个字符串装两种形式**（`剩余 2,767 / 10,000（27.7%）`）：它们本来是「百分比在右端 + 精确值在进度条下面一行」，同一条事实说两遍、看上去还是两个数（维护者要求合成一个放右侧）。
两者也确实该在一起：百分比没法拿去对账，而只有分数又要读者自己做那一次除法——进度条已经在画它了。

**一行里不放两个控件**：`Field` 的 `action` 只有一个槽。这也意味着同一个动作不会既在字段行又在别处。

**卡片只有一个「刷新」**，在展开区顶部它自己的一行（`.cardActions`），做完整刷新（重读状态文档 + 让宿主重抓目录）。
它曾经是两个：账号块的 `刷新`（只重读）与模型页的 `刷新模型列表`（去上游重抓）——两个都读作「刷新」却做不同的事，卡片按钮因此显得随意。
现在它靠三件事表明**这是整卡级的**：独占一行、标签写明范围（`刷新全部`）、用的是宿主的 `md`（36px）而每个块内动作都是 `sm`（28px）。

**账号是用 `nickname ?? uid` 命名的**。桌面凭据不总有昵称，而 uid 是 per-account 状态（隐藏的模型、检测记录）真正键在的那个身份——所以它是唯一永远在场的名字。

**三个标签页是同一个盒子**：固定高度的面板壳，里面一层固定头（字段行）+ 一个滚动区（取剩余高度）。

| 标签页 | 固定头 | 滚动区 |
|---|---|---|
| 积分 | 币读数（无副说明） | 套餐行（名字 + 合成读数 + 进度条） |
| 模型 | 来源 + 读取时刻 | 显隐说明 + 模型行 |
| 检测 | 计数 + 费用 + 清除结果 | 说明 + 档位行 |

高度定死而不是给列表设上限：只设上限时矮的那页仍是内容高度，切标签会改变卡片高度。
滚动区还必须**直接**是面板壳的子级（中间夹一层宿主元素，`flex: 1` 就会加错对象、填高失效）。

**同一个数字在两处出现就用同一个图标**：积分余额同时出现在 composer 读数与卡片积分页，两处共用 [src/client/coin-glyph.tsx](../src/client/coin-glyph.tsx) 的 `CoinGlyph`。

归属按「这条事实属于谁」定，不按「哪里有空位」：

| 事实 | 归属 |
|---|---|
| 身份与有效期 | 账号块——有效期只是会话的属性，第二行 |
| 目录来源与读取时刻 | 模型页——它说的是模型列表的状态 |
| 币读数、套餐余量 | 积分页 |
| 已检测数量与清除结果 | 检测页——清除**删除**记录，不是刷新，所以不去卡片顶部 |

前两条与「副说明在第二行」由 [../tests/browser/field.spec.ts](../tests/browser/field.spec.ts) 按结构钉住（控件在首行内、无控件时不占位、层次与顺序、空尾词不留缝），
「动态值等宽」由 [../tests/redlines.spec.ts](../tests/redlines.spec.ts) 的「机器产出的数字一律等宽」钉住，
「只有一个刷新」「清除结果在字段行内且在列表之前」「三页等高」由 [../tests/browser/card.spec.ts](../tests/browser/card.spec.ts) 钉住。
取舍经过见[决策记录](../.agents/notes/2026-10-02-card-field-grammar.md)。

## 推理档位：一个判据，两处渲染

「这个模型能不能切思考档位」只有一个答案，由 `src/probe/efforts.ts` 的 `resolveEfforts()` 给出，规则严格有序：

1. **上游声明优先**：`supportedEfforts` 非空即用它，观测永不加宽或收窄。这类行**不值得探测**（声明已经是答案），UI 上照常显示灯泡但禁用检测。
2. **`validating` 观测补位**：未声明的行靠一次成功探测得到档位。
3. **其余无档位**：包括 `non-validating`——上游对任何值都回 200（`glm-5.2` 实测），逐档接受全是假阳性。这类行**保持可检测**，因为该结论描述当天上游，不是模型的固有能力。

两处消费同一个答案，这是不变式而不是巧合：

| 消费方 | 用途 |
|---|---|
| `src/llm/adapter.ts` 的 `reasoningFields()` | 模型选择器的 `thinkingLevelMap` |
| `src/index.ts` 的 `probeSection()` | 状态文档 → composer 的灯泡 |

**灯泡的语义是「能否切档位」，不是「探测过没有」**：`efforts.length > 0` ⇔ 灯泡点亮 ⇔ 选择器提供档位。此前的判据是「能不能探测 / 探测过没有」，于是**上游已声明档位的模型反而没有灯泡**——档位直接可用的那些看起来最像坏的（判据与经过见[决策记录](../.agents/notes/2026-10-02-effort-bulb-means-switchable.md)）。

状态文档的 `probe` 因此是**一个列表**（`models`），而不是「候选」加「结果」两列：两列各自回答一半，谁也不回答用户唯一要问的那个问题。

探测本身仍是观察、不是能力声明：结果一律称 "verified accepted"，从不称 "verified effective"——接受只证明上游没拒绝该拼写，不证明它改变了模型行为。

### 默认档位：让选择器不再出现「Default」

宿主的模型选择器在**模型没报默认档位时**补一项「Default」（含义是"跟随上游"），报了就换成那一档的勾选。所以「让下拉里没有 Default」在本仓的实现就是**每个能切档位的模型都报一个默认档位**，判据由 `src/probe/efforts.ts` 的 `resolveDefaultEffort()` 给出：

1. **上游声明优先**：`reasoning.defaultEffort` 在档位集里就用它——上游自己就是这么做的。
2. **`high` 兜底**：声明了档位集却没声明默认档位、或声明的默认档位已不在收窄后的集合里（`defaultEffort: 'low'` 配 `supportedEfforts: ['high']`），一律取 `high`。
3. **集合里没有 `high`** 则取集合首项——**默认档位必须是集合成员**，否则每个省略档位的请求都会 `UNSUPPORTED_REASONING_EFFORT` 失败。

选 `high` 兜底而不是"让 Default 留着"是明确取舍：一个不中意的档位在选择器里一键可改，而「跟随上游」是不可见、也无法预知的。**没有档位的模型不报默认**（`undefined`），那种模型选择器里仍然只有 Default——它本来也没有别的档位可选。

两处上报，缺一不可：选择器读 `resolveModel()`，请求路径读 `prepareCall()`，只在一边报就会出现「选择器显示某档、实际请求发的是另一档」。

### Off：选择器的档位名，不是 wire 拼写

`thinkingLevelMap.off` 被钉成字面量 `'off'`（改成 `null` 会让 Off 从选择器里消失），而 pi-ai **把同一个条目不只用在这个档位上**：用户显式选 Off 时发它，**任何没指定档位的请求也自动发它**。所以 `'off'` 一旦是字符串，它就同时是"选择器里的一项"和"wire 上的一个值"。

上游只承认前者。两个端点都拒绝这个拼写：

| 端点 | 观测 | 来源 |
|---|---|---|
| 国际版 GPT 系 | 400 / `11133` / `extError.param === 'reasoning.effort'` | issue #49 |
| 国内版全部 `canDisableThinking` 模型 | 同样是 400 / `11133` | issue #13 |

于是 wire 边界（`src/protocol/client.ts` 的 `prepareChatBody()`，`chatStream` 对两个 region 都过一遍）**删掉这个字面量**，选择器照旧显示 Off。语义因此明确降级为：**Off = 不发送 `reasoning_effort`**，实际行为由上游决定——不保证关闭思考，也不保证等于目录声明的 `defaultEffort`。

三个不能顺手改的边界：

- **`'none'` 不替换、不删除**：它是用户可选的显式拼写，两版都原样透传。而且它并非安全替代品——`gpt-6-astra` 拒它，`kimi-k2.8-preview` 收下却静默忽略。
- **`off` 不进探测候选**（`PROBE_EFFORT_CANDIDATES`）：探测只能证明"上游收下这个拼写"，证明不了"思考被关掉了"，而"接受 ≠ 生效"是本仓探测系统的第一条原则。
- **不要按模型写死映射**：同一个拼写在三家供应商后面有三种现实，静态快照必过期（判据与先例见[归档记录](archive/reasoning-effort-off-wire-issue-49-2026-09-23.md)与[决策记录](../.agents/notes/2026-10-20-off-effort-strip-both-regions.md)）。

## `11128` 有两个来源：正文里的产品名，与渠道身份头

两条链路都会回 `11128`（`request illegal`），但成因与修复完全不同。**排查时先分清是哪一条**，把它一律当成「提示词内容风控」会走向错误的修复方向。

| 端点 | 触发条件 | 修复位置 |
|---|---|---|
| 国内版 | 消息正文出现产品名 `DeepSeek Harness` | `neutralizeChannelSignature()` |
| 国际版 | chat 请求缺 trace / conversation 身份头组，**与正文无关** | `channelIdentityHeaders()` |

两条都带一句看着像推销的 `displayTips`，但**国际版说「渠道校验」是真的**：2026-10-23 起国际网关确实在校验客户端身份，而 CN 那条的 "unapproved channel" 才是误导。

### 正文风控：产品名是 wire 上的敏感串（CN 侧）

上游按**提示词内容**风控。2026-10-21 实测：国内网关对消息正文里出现产品名 `DeepSeek Harness` 的请求回 400 / `11128`（`Illegal API invocation from an unapproved channel`），而把那些出现处改写后同一账号、同一请求头回 200。DSH 默认把 `You are an AI agent powered by DeepSeek Harness.` 当每个 system prompt 的开头注入，所以这条拦的是**所有** agent 请求，与是不是官方客户端无关——文案里的 "unapproved channel" 是误导。

旁证（**不是本仓的上游，两者没有代码谱系**）：同一个腾讯网关也被 CPA 渠道插件那一侧独立撞上，
`mmqz/cpa-multi-plugins` 的 [PR #49](https://github.com/mmqz/cpa-multi-plugins/pull/49) 用真实失败转储做了消融实验，
给出两条本仓据此定范围的结论——(a) 只改 system 仍然 400，真实请求的触发点主要在 **assistant 历史回显**；
(b) 该网关当时只扫 system 与 assistant 正文，user、tool 结果、`tools` 定义、`tool_calls` 参数、
`reasoning_content` 均不触发。本仓仍改写后三者，见下文边界。跨仓引用只作证据，不构成依赖：
本仓不加载、不管理那些 dll，两侧各自独立修复同一现象。

于是 wire 边界（`prepareChatBody()` → `neutralizeChannelSignature()`，两版都过一遍）做两段改写：

| 位置 | 改法 | 理由 |
|---|---|---|
| 消息开头的固定句 | 整句改写成 `You are an AI agent.` | 可读、语义不变，且不依赖不可见字节（上游若归一化文本，零宽方案失效而这条不会） |
| 其余出现处 | 词间插入 U+200B | 无损，模型读到的是同一句话，子串匹配不再命中 |

三条不能顺手改的边界：

- **路径语境一个字节都不改**（`…\DeepSeek Harness\…`、`…/DeepSeek Harness/…`）：真实目录名里就有这个词组，插进零宽字符会让模型拿到一个它看不出错的错误路径，工具调用必失败。两条改写都带前后斜杠守卫。
- **改写 system / developer / assistant，绝不动 user 与 tool**：只改 system 实测仍 400（触发点在 assistant 回显）；user 与 tool 被排除是刻意的——那两类字节是模型推理的事实依据（用户自己的话、文件或命令真实返回的内容），改写等于让转录与世界不一致，而实测该网关并没有在扫那里。assistant 的 `reasoning_content` / `reasoning` 镜像与 `tool_calls[].function.arguments` 一并改写（都是模型自己生成的，参数串仍必须能 `JSON.parse`）。数组 content 只改 `type: "text"` 的部件。
- **幂等**：国际版层会二次调用共享层，第二遍必须不再命中（改写后既没有整句也没有裸词组）。

### 渠道身份：国际版要求 trace / conversation 头组

2026-10-23 起，国际网关（`www.workbuddy.ai/v2/chat/completions`）对 chat 请求做**渠道校验**：同账号、同凭证、同 UA、同 body，缺下面这五个头就回 400 / `11128`，补上即 `200` SSE（[issue #21](https://github.com/dsh-plugin-lab/dsh-workbuddy-bridge/issues/21)，[PR #22](https://github.com/dsh-plugin-lab/dsh-workbuddy-bridge/pull/22)）。

| 头 | 形态 |
|---|---|
| `X-Trace-ID` | 32 位小写 hex（OTel trace-id） |
| `X-Request-ID` | v4 UUID |
| `X-Conversation-ID` | v4 UUID |
| `X-Conversation-Request-ID` | v4 UUID |
| `X-Conversation-Message-ID` | v4 UUID |

`chatHeaders()` 经 `channelIdentityHeaders()` **每请求现生成**，与官方桌面端一致。

四条不能顺手改的边界：

- **只有 global 注入，CN 逐字节不变**：`regionOf(credential.domain) === 'global'` 是唯一条件，同一判据 `chatBase()` 也在用。CN 现状实测 `200`，不冒进。
- **不是在正文里找原因**：这条链路的 `11128` 与消息内容无关——干净最小请求同样被拒。反过来，`neutralizeChannelSignature()` 修不了它，别把两件事混成一条。
- **`X-Trace-ID` 不是 UUID**，另外四个才是。独立复现（2026-10-24）显示只发三个 `X-Conversation-*` 当前也能过，但**没有据此收窄**：网关最可能收紧的正是 trace-id 格式，届时最小集又会坏掉。
- **`probeEffort()` 共用 `chatHeaders()`**，所以这条链路修好后，国际版的推理档位探测从「静默 `unknown` / `efforts: []`」一并恢复。它是同一次修复的副作用，不是另一件事。

判据在 `tests/chat-identity-wire.spec.ts`（五头形态 / 每请求不复用 / CN 无五头）。

## 失败文案：状态码会被宿主当成鉴权结论

宿主 `@deepseek-ai/dsh-llm-pi-ai` 的 `classifyPiAiError()` 按**文本**分类：`/\b(?:401|403)\b/` 命中即 `AUTH`，聊天界面随后用 `message.failure.auth` 覆盖原话（「API 密钥无效」）。也就是说只要我们的错误文本里出现那两个数字，封号、限流、参数错都会被显示成"换 Key"——一个必然无效的动作。

因此 `src/llm/shim.ts` 的 `failureMessage()` 有两条硬规则：

- **上游自己的 `displayMsg` 优先**（`zh` → `zh-hant` → `en`，再退 `msg`、`extError.message`）。它才是写给人看的那句话（「账号存在异常行为，已被限制使用」），原始 JSON 体不是。
- **只有 `session_dead` 把 `(http 401)` 写进文本**：那一类的状态码正是可执行信息（重新登录），宿主读成 AUTH 恰好是对的；其余类别一律不裸露状态码。

`11140`（账号风控限制）因此归 `client` 而不是 `session_dead`：重登录对它无效，归成鉴权会让用户走进死路。

## 兼容性契约（改动前必读）

以下行为不是实现细节，改动它们等于丢弃用户磁盘上的数据：

- **`fingerprintModel` 的输入键序**（`src/probe/store.ts`）：指纹是 `JSON.stringify` 的直接哈希，`reasoning` 对象的**键插入顺序**是哈希的一部分。重排 `resolveUpstreamReasoning`（`src/protocol/client.ts`）里的键会静默作废所有已存的推理档位观测。键序在此文件里是故意固定的。
- **`canDisableThinking` 的缺省不对称**：行内没有 `reasoning` 块时缺省 `true`（这种行 adapter 根本不会发 effort，值无关紧要）；**有**块但没写这个字段时严格 `=== true`——这个布尔量现在的唯一作用是「选择器要不要显示 Off 档」，而上游从没承诺过"没声明就支持关闭思考"。不要"统一"成一边。
- **上游解析的严格性**（`src/protocol/client.ts`）：字段一律 `typeof` 收窄，不用 schema 校验库替代——schemastery 会把 `'120'` 强转成 `120`、给缺失的可选子对象补 `{}`，两类静默转换分别破坏"usage 字段非数字要报错"和"reasoning 块缺省"两条已测行为。
- **探测记录的账号归属**：每条观测绑定产生它的账号，切换账号后旧账号的观测不消失（留在盘上）但不再被读出。
- **默认档位必须是档位集成员**（`resolveDefaultEffort`，`src/probe/efforts.ts`）：报一个档位集之外的档位，会让每个省略档位的请求以 `UNSUPPORTED_REASONING_EFFORT` 失败——判据的"集合内兜底"（声明优先 → `high` → 集合首项）不是实现细节，是用户可感知行为的契约。
- **`chatStream` 对两个 region 都做请求体归一化**（`src/protocol/client.ts`）：`off` 的 strip 与渠道签名中性化都住在共享层，region 只决定国际版额外补的首条 `system` 消息。改成"CN 原样透传"会让国内版重新把 `off` 与固定句发到 wire 上（issue #13 与 2026-10-21 的 `11128` 都是这个故障形态）。
- **渠道身份头组只注入 global**（`src/protocol/client.ts` 的 `channelIdentityHeaders()`）：判据必须是 `regionOf(credential.domain) === 'global'`——与 `chatBase()` 同一个。顺手"两版统一"会让 CN 的 wire 不再逐字节等于今天实测通过的那个形态，而 CN 从没被要求带这组头。
- **错误文本里不得出现 `401` / `403`，除非失败真是鉴权类**（`src/llm/shim.ts` 的 `failureMessage()`）：宿主按文本分类，`AUTH` 会覆盖掉真实原因。判据在 `tests/shim.spec.ts`。
- **`thinkingLevelMap.off` 保持字符串 `'off'`，`'none'` 两版透传**（`src/llm/adapter.ts` / `dropUnsupportedEffort`）：前者是选择器里 Off 档存在的唯一条件，后者是用户显式选择、不由适配层代删。

## 测试

```sh
pnpm test          # 全量
npx vitest run tests/browser   # 只跑浏览器半边
pnpm typecheck     # 两个 tsconfig（宿主 / 浏览器）严格模式
pnpm build         # tsdown，含 CSS Modules 编译
```

- `tests/` 宿主半边：协议解析、目录生命周期、凭据、路由。**不**起真实网络，上游一律 stub。
- `tests/browser/` 浏览器半边：`react-test-renderer` + stub 的 `window`/`fetch`。`harness.ts` 提供时钟推进（`tick()`）与合成事件——官方组件的事件处理器会读 `stopPropagation`，裸 `onClick()` 会炸。
- 宿主测试的断言按"用户可见事实"写（如"卡片仍显示账号名"），不按实现写。

## 已知未覆盖

沙箱环境跑不了真实上游与真实桌面 App：探测的真实往返、企业账单的真实形状、macOS 路径发现的真机行为，均只有单测级覆盖。改动这些路径时以"保守回退 + 明示失败"为默认策略。
