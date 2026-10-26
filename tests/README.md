# tests/ — 文件索引

职责：见 [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)

- adapter.spec.ts
- app-version.spec.ts
- auth.spec.ts
- catalog-lifecycle.spec.ts
- catalog-store.spec.ts
- chat-identity-wire.spec.ts —— chat / probe 的身份头硬编码在 wire 上（UA 形态、共享头族逐字节不变），
  以及国际版渠道身份头组：五头形态、每请求重新生成、`X-Trace-ID` 反 UUID、CN 无五头
- client-identity.spec.ts
- credit-log.spec.ts
- credit-route.spec.ts
- css-modules.spec.ts —— CSS module 的类名引用必须能解析：`css.x` 不受类型检查，写错就是**静默无样式**
- desktop-credential-protection.spec.ts
- desktop-doctor.spec.ts
- dual-routes.spec.ts
- efforts.spec.ts —— `resolveEfforts()` 的判据表，含 adapter 与状态文档逐例一致（两半体不能各答一套）；
  另含 `resolveDefaultEffort()`：默认档位永远落在档位集里（它决定选择器里还没有「Default」一项）
- electron-discovery.spec.ts
- electron-reason-code.spec.ts
- host-heartbeat.spec.ts
- locales.spec.ts —— 词条键必须有人读：删掉一个 UI 元素时它的词条会**静默留下**（键集是闭合联合，只挡住反向错误）
- loopback.spec.ts
- model-visibility.spec.ts
- prepare.spec.ts
- probe-route.spec.ts
- probe-service.spec.ts
- probe-store.spec.ts
- probe.spec.ts
- reasoning-merge.spec.ts —— 过真 seam 的合并判据（声明 vs 观测），以及选择器默认档位的两处上报
  （`resolveModelInfo` 与 `resolveCallConfig` 必须给出同一个值）
- redlines.spec.ts —— 红线总集：平台契约（槽的 kind / 设置命名空间）、插件页样式档位（字号 / 行高 / 描边 / token）、文档里的宿主版本提示
- shim.spec.ts
- status-document.spec.ts —— 状态文档形状守卫的两侧：读者能处理的要放行，会在渲染期抛错的要拒绝
- upstream.spec.ts
- variants.spec.ts
- version.spec.ts
- web-status.spec.ts
- 子目录：browser —— **真实 React 树**的浏览器半边用例（卡片渲染契约、composer 控件、配置控制器）。折叠头的展开走 [browser/README.md](browser/README.md) 的 `expandDisclosure`，不是找第一个按钮

变更影响路由：改本目录 → 同步根 [AGENTS.md](../AGENTS.md) 的待办与活跃坑；设计变化写 [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
