# src/client/ — 文件索引

职责：见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) 的「浏览器半边」一节。

## 文件

- index.tsx —— 槽注册：`plugins.bundle.config`（key = **包名**）、`conversation.input.right`（探测控件 + 剩余积分）、
  `conversation.chat.assistant-actions`（每消息的消耗积分）
- config-controller.ts —— `ctx.configForms.get(ENTRY_ID)` 的staged 表单模型；四字段全部 volatile
- WorkBuddyConfigPage.tsx —— 配置页：宿主 `SettingsForm`（两个文本字段）+ 两个官方开关行，然后是实时卡片
- WorkBuddyCard.tsx —— 变体卡片：宿主 `DisclosureRow` 壳（`expandOnRowClick`，整行可点）；展开区自上而下是
  **卡片的唯一动作行**（`刷新全部`，`md` 尺寸）+ 账号块，然后按「读者任务」分三个 SegmentedTabs：
  积分（币读数 + 套餐）/ 模型（目录来源 + 显隐/窗口/倍率）/ 检测（档位清单）
- field.tsx —— 卡片的字段行原语（`Field` / `Part`）：**最多两行**——第一行是「主值 + 右端至多一个控件」，
  第二行是副说明。静态词（`Part` 的 `caption`/`after`）走宿主 `.hint` 档的灰字，动态值走宿主 `.label` 档的正常色。
  卡片上每一块都走它；不变式见 [ARCHITECTURE.md](../../docs/ARCHITECTURE.md) 的「卡片的视觉语法」，
  结构守卫是 [../../tests/browser/field.spec.ts](../../tests/browser/field.spec.ts)
- panels.tsx —— 标签页内容：积分条与套餐明细 / 模型目录表（`ModelsPanel`）/ 档位清单（`ProbePanel`，每个推理模型一行）/ Agent assist
- PanelBoundary.tsx —— 面板级错误边界（class 组件，React 只支持 class）。宿主的槽边界会**闩锁**：
  一处抛错整块配置区消失、必须关开插件才回来，所以每个标签页自己包一层
- probe-control.tsx —— 输入区推理档位控件：**灯泡 = 这个模型现在能不能切档位**（不是「探测过没有」）。
  判据只一条：`efforts.length > 0` ⇔ 灯泡点亮 ⇔ 选择器提供档位，两头同源于 `src/probe/efforts.ts`。
  上游已声明档位的模型**照常显示灯泡但禁用检测**（声明已是答案）；`non-validating` 保持可检测。
  自绘灯泡墨迹，闪电只在有档位时出现。浮层**定位交给 CSS**（见下条）：这里只给触发按钮与面板各写一份
  每次实例唯一的锚点名，不测矩形、不做首帧隐藏
- coin-glyph.tsx —— 币图标（细线三枚币，宿主 16 格）。**同一个物件出现在两处**：composer 读数与卡片的积分页；
  两处共用它是为了让读者认出这是同一个数字。图标的布局规则在它自己的 CSS 里，行样式归调用方
- credit-balance.tsx —— 模型选择器左边的剩余积分；只在会话用 WorkBuddy 模型时显示/取数。
  **纯读数、无按钮**：币图标 + 数字，不写「剩余」二字（28px 下文字与它标注的数字抢注意力），
  完整句子留在 `title` 里
- credit-label.tsx —— 助手回复操作行里的「共消耗 X」；同样只在 WorkBuddy 模型时显示，观测不到则不显示（绝不显示 0）
- use-session-credits.ts —— 逐消息积分表的取数与轮询；读失败静默，保留上一份
- use-status.ts —— 状态文档的轮询与读写
- status-document.ts —— 状态文档与积分文档的形状守卫
- locales.ts —— 词条（键集真源）；双语同键
- format.ts —— 数字 / 时间 / token / 积分的展示格式化（积分按账本两位小数精度，不用 `Intl`）
- variants.ts —— 两个变体（CN / AI）与卡片路由
- workbuddy.module.css —— 配置页与卡片的样式
- coin-glyph.module.css —— 币图标自身的布局（`flex: none`）；它出现在两个页面上，所以规则跟着图标走，不留在调用方的样式表里
- probe-control.module.css —— 控件与浮层的样式。浮层的**定位也在这里**（CSS 锚点，不是 JS）：触发器
  `anchor-name`、面板 `position-anchor` 共用一个每次实例唯一的自定义属性名；`bottom: calc(anchor(top) + 8px)`
  是触发器上方的 8px 间隙，`top: max(12px, var(--dsh-frame-overlay-top, 12px))` 与左右 12px 是视口边距，
  `@position-try` 那条兜底负责「靠右放不下时右对齐」。改这几个数就是改视觉，改前先看
  [tests/redlines.spec.ts](../../tests/redlines.spec.ts) 的「浮层定位走 CSS 锚点」
- credit-balance.module.css —— 积分读数的行样式（28px 高、4px 间距、tertiary 墨色、等宽数字）；
  币图标自身的规则在它自己的模块里
- credit-label.module.css —— 每消息消耗标签的样式
- css-modules.d.ts —— `*.module.css` 的类型声明

## 样式从哪抄（改样式前先看）

**不自定一档**。取值真源按用途分：

- 字段 / 开关行 / 表单节奏 → 宿主 `ui-primitives/lib/settings-form/{fields,SettingsForm}.module.css`
- 开关行（布尔设置的整行）→ 宿主 `dsh-client-ui-settings-subagent` 的 `.toggleRow`/`.toggleLabel`
- 带边框的列表块 / 卡片块 → 官方 `dsh-experimental-client-ui-voice-input` 的 `.models`/`.preparation`/`.settingsCard`
- 宿主自己都没定义的 token（`--dsw-alias-label-error`、`--dsw-alias-bg-layer-4`）不许用

**字段行的形状只有一个 home**：`field.tsx`。卡片上要加一条事实就走 `Field`，不要在调用点手搓
`.fieldText`/`.fieldLabel` 那一组 —— 手搓过一版，三处各自漂移，判据见
[ARCHITECTURE.md](../../docs/ARCHITECTURE.md) 的「卡片的视觉语法」。

指针与检索方式见工作区 `HARNESS-REF.md` 的「配置页样式」（跨仓文件，本仓不链入）。
这几条由 [../../tests/redlines.spec.ts](../../tests/redlines.spec.ts) 的「插件页样式跟着宿主走」一组断言钉着。

## 交互约定

- 卡片折叠头 `expandOnRowClick`：整行可点。**浏览器测试展开用 `tests/browser/harness.ts` 的 `expandDisclosure`**，不要找第一个按钮
- 探测：一个按钮直接跑（无确认/取消）；成本说明只在「还有事可问」时出现（已声明档位的模型不显示）
- 配置与实时状态是两半：表单有保存按钮，卡片没有 —— 不靠标题区分
- **composer 那一行是两个自绘墨迹并排**：灯泡（能否切档位）与币（剩余积分）。两者都走 `currentColor`、
  都在宿主的 16 格上、都是 16px，且都**不写字**——判据是「同一个 28px 行里读起来像一套」。
  宿主自己的 188 个图标里没有币/额度/钱包形状，所以币是本仓自绘的；改它之前先看 `credit-balance.tsx` 的注释
- **浮层定位是 CSS 的事，不是 JS 的事**：面板 `createPortal` 到 `document.body`（composer 行会裁掉
  `position: fixed`），位置由锚点语法算出来。宿主的旧 hook 已在 rc 线里删除，别再引入任何「测矩形再定位」
  的写法——那条路本仓刚踩过：编译过、测试绿、只有真机选到 WorkBuddy 模型时才崩。
  连带一条：**浏览器半体的注释也算进产物**，别在 `src/` 里写宿主已删符号的名字（红线扫产物）

变更影响路由：改本目录 → 同步根 [AGENTS.md](../../AGENTS.md) 的待办与活跃坑；设计变化写
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)；样式改动的判据同步
[../../tests/redlines.spec.ts](../../tests/redlines.spec.ts) 的「插件页样式跟着宿主走」。