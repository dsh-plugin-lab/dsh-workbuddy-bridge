# 决策：浮层定位交给 CSS 锚点，不再用（已被宿主删除的）JS 定位 hook

状态：生效
日期：2026-11-13

## 问题

宿主自 0.2.2 的 rc 线起，`@deepseek-ai/dsh-client-ui-primitives` **删掉了 `useAnchoredPosition` 值导出与
`AnchoredPositionOptions` 类型**（迁移指南：删掉这两个导入，自定义面板改用 CSS Anchor Positioning）。同族的
`useDismissOnOutsidePointer` / `useAnchoredMaxHeight` / `usePointerGrace` 仍在。

本仓 composer 的推理档位浮层（`src/client/probe-control.tsx`）当时正用这个 hook 定位。它**编译得过**：
本仓 devDependencies 比在跑的宿主慢一个 rc，类型仍然存在。于是缺陷是**潜伏的**——真机今天没崩，只因为这个控件
仅在当前会话选中的模型属于 WorkBuddy 渠道时才渲染；一旦用户选了 WorkBuddy 模型，就是
`TypeError: ... is not a function`，整个槽条目被宿主边界判为崩溃。

同一天同一根因在 `dsh-ds-balance` 是**显性**故障（它的余额面板一直在渲染），真机 console 实测：
`slot entry crashed in 'sidebar.footer.action'`。两仓同源，处置也应是同一套。

## 决策

**浮层的定位完全交给 CSS Anchor Positioning，JavaScript 只提供一个锚点名。**

- 触发按钮 `anchor-name: var(--dsh-workbuddy-probe-anchor)`；面板 `position-anchor:` 同一个变量。
  **名字每次实例唯一**（`useId` 派生，内联自定义属性写进两侧）—— 锚点名是**文档级**的，两个控件共用一个名字
  会让两块面板追同一个触发器。
- 定位与尺寸上限全在 `probe-control.module.css`：`bottom: max(12px, calc(anchor(top) + 8px))`（触发器上方 8px）、
  `top: max(12px, var(--dsh-frame-overlay-top, 12px))` 与左右 `12px`（视口边距，并让开桌面窗口边框）、
  `align-self: safe end`（空间不够时退回顶边而不是飞出屏幕）、`height: fit-content`（既有 `top` 又有 `bottom` 时
  `auto` 高度会被拉伸，对齐就没有余量可用）。
- **尺寸上限沿用改前那两条**（`min-width: min(280px, 100vw - 24px)`、`max-width: min(360px, 100vw - 24px)`）。
  改前那份 hook 另外写过 `--dsh-anchored-max-*`，但本仓样式表从未消费它，所以事实上没有高度上限 —— 保持不变。
- **横向兜底**：卡片 280–360px 宽，而触发器在 composer 右端，按左边缘对齐常会出视口。`@position-try` 那条
  （`left: 12px` + `justify-self: safe end`）把右边缘压回同样的 12px 边距 —— 这正是旧 hook 在 JS 里做的 clamp。
- 首帧「先藏后测」（`visibility: hidden` + `left/top: 0`）随测量一起删掉：CSS 在绘制前就解析完位置，没有闪烁可挡。

**几何不是推断出来的，是量出来的**：真机（playwright + 宿主自己的模型选择器菜单，它就是这套写法的参考实现）
实测「面板底边距触发器顶边 8px、右边缘与触发器右边缘对齐」，随后用**产物里那串 CSS 字节**在 Chromium 里复测本仓
面板（1280/420 两种视口、触发器居中/贴右、内容高于可用空间四组）：gap 恒 8、四周边距 ≥12、宽度落在 280–360，
去掉锚点属性则面板落到视口左上（证明通过的原因是锚点而不是巧合）。

## 替代方案

- **把 devDependencies 钉在 rc.1 线，继续用那个 hook**：真机宿主是 rc.2，`tsc` 绿而浏览器必崩 —— 这正是本次
  潜伏故障的成因，等于把缺陷固定下来。反方向（为本仓自造一份 hook 副本）也不做：定位是需要随宿主 UI 一起演化
  的机制，抄一份就等于自己维护一份会漂的实现，而宿主已经明确把这件事移交 CSS。
- **自己写测量 + `position: fixed` 坐标**（复刻旧 hook 的行为）：能在任何宿主上跑，但要自己处理 scroll / resize /
  transform / 视觉视口，且与宿主未来对菜单的约束（例如缩放下的布局视口语义）分叉。宿主迁移指南明确要求改成
  CSS 锚点，逆着走的成本只会越来越大。
- **改用宿主 `Menu` 原语承载面板**：`Menu` 的 `getAnchorRect` 同样被换成了 `anchorRef` / `anchorPoint`，能编译，
  但本面板不是菜单 —— 它没有键盘导航的行模型，内容是「一段读数 + 一个动作」，套 `role="menu"` 会给出错误的
  无障碍语义（现在的是 `role="dialog"`）。
- **把面板改成内联展开（不 portal、不浮动）**：composer 行会裁掉 `position: fixed`，内联展开会挤压输入区，
  且远离「点了哪个按钮」的因果关系。

## 影响

- `src/client/probe-control.tsx`：不再 import 那个被删的符号；`MEASURE_STYLE` / `POPOVER_GAP` / `POPOVER_MARGIN`
  三个 JS 常量消失（数值搬进 CSS），新增一份内联的锚点属性。
- **`src/` 里不许再写那个符号的名字**（注释也不行）：打包器会把注释原样带进产物，而
  `tests/redlines.spec.ts` 的「浮层定位走 CSS 锚点」扫的是**产物**。符号名只记录在红线注释与本文件里。
  这与既有的 `process` 守卫是同一种交易 —— 那条也扫到散文，本轮真被它抓到过一次。
- 新判据：产物里不出现该符号（并自检产物确实含 `position-anchor`）、源码不再 import 它、CSS 两侧引用同一个
  自定义属性名（TSX 里的常量 ↔ 样式表）、`position-try-fallbacks` 里的每个名字都有对应 `@position-try` 规则
  （否则兜底是死代码）。浏览器 lane 追加两条：触发器与面板共用同一个锚点名、两块控件拿到**不同**的锚点名，
  且面板的 `style` 里不出现 `left` / `top` / `visibility`（出现即 JS 定位回来了）。
- `engines.dsh` 不动：CSS 锚点是浏览器特性，宿主只负责不再提供那个 hook；rc.1 宿主上这套 CSS 同样成立
  （`--dsh-frame-overlay-top` 缺失时回落到 12px）。
- 遗留（不在本条）：**本仓 devDependencies 仍慢在 rc.1 线上，所以类型检查对「宿主删了什么」依旧无感** ——
  这类缺陷只能靠产物级判据拦。升 devDeps 要连带决定 `engines.dsh` 的兼容范围，属单独一次决策。
