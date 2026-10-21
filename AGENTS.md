# dsh-workbuddy-bridge — 维护索引

## 状态

- 版本与发布状态**现查**：npm `latest` → [npm 包页](https://www.npmjs.com/package/dsh-workbuddy-bridge)，tag / Release → 仓库 Releases 页。
  **发布走 [.github/workflows/release.yml](.github/workflows/release.yml)，两个入口**：推 tag（`git push origin v<版本>`）
  或手动 dispatch；两条进同一个 job，全有或全无（先发成功、再建 tag 与 Release）。流程与判据见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。
  `0.1.0` 是维护者本地 `npm publish` 发的（当时 workflow 还没用上，git 侧产物缺失）；`0.2.0` 起全部由 workflow 产出。
- 装法默认只有一条：`dsh plugin --profile <profile> add <包名或仓库路径>`。包内声明了 `dsh.bundle.patch`，
  安装器自己会把它写进该 profile 的 `dsh.profile.bundles`；**不要再往 profile 的 `cordis.patch.yml` 手写 patch 行**，
  两者并存就是双挂载。**唯一例外是本地开发的 `link:` 形态**（见下条），它必须摘除 bundle 条目并改回手动 insert。
- 运行形态：装进 profile 的 `node_modules`，由该 profile 的 `dsh.profile.bundles` 装载（bundle 层来自包内的 `cordis.patch.yml`）。
  **本机维护者的 profile 走 `link:` 形态**（2026-10-02 起）：依赖指向本仓、`bundles` 摘除本插件、`cordis.patch.yml` 手动 insert、
  `node_modules/<包名>` 是 symlink。所以 `build` 完**只需重启 dsh**，不用再同步 `lib/`。
  四步与三条判据、回滚方式见 [docs/PUBLISHING.md](docs/PUBLISHING.md) 的「本地开发装法」。
- **`lib/` 是构建产物，不跟踪**（与另两个插件仓一致）：`.gitignore` 忽略它，
  由 `pnpm build`（或 `pnpm check`）产出。`link:` 装法直接读它，所以**改源码后必须重建**，
  否则跑的是旧产物 —— 但**不必提交**它：发布流程自己跑 build，不依赖 git 里的产物。
  clone 之后第一件事是 `pnpm install && pnpm build`。

## 全局规则

- 架构与设计决策 → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 子树手册 → [src/README.md](src/README.md)、[tests/README.md](tests/README.md)、[scripts/README.md](scripts/README.md)、[assets/README.md](assets/README.md)、[locale/README.md](locale/README.md)
- 决策记录 → [.agents/notes/](.agents/notes/)（写法见该目录 `AGENTS.md`，不建索引）
- 发布手册（发版流程、版本号语义、平台契约取真源方式）→ [docs/PUBLISHING.md](docs/PUBLISHING.md)
- 来源与双版权 → [NOTICE](NOTICE)；许可证 → [LICENSE](LICENSE)
- **平台契约只从实装宿主读**：注册一个槽之前先查它的 `kind` 与现有占用者 —— `single` 槽同 priority 再注册会抛错，
  而抛出方是后注册的那一个（宿主自带 UI 会因此消失）。判据与先例见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 常用命令（本机实测）

- 本地钩子：`pre-commit install`（每个 clone 一次；本体 `uv tool install pre-commit`）——提交前自动 `prettier --write` + `eslint --fix`（`pnpm --config.verify-deps-before-run=false exec`，不联网）；CI 只读新增 lint + format:check
  - 装完**要重开终端**（或重载 shell 配置），`~/.local/bin` 才进 `PATH` —— 否则 `pre-commit` 命令找不到

- 装依赖：`pnpm install --config.node-linker=hoisted`
- 全量检查（**顺序固定，build 必须在 test 之前**）：`tsc --noEmit` → `tsdown`（重建 `lib/`）→ `vitest run`
  - [tests/version.spec.ts](tests/version.spec.ts) 断言 `lib/` 产物里的版本与包一致，先跑测试会红（刻意设计）
  - 上面三步就是 `pnpm check`；CI 的 Test 步带覆盖率门槛：`pnpm exec vitest run --coverage`（阈值与 include / exclude 见 [vitest.config.ts](vitest.config.ts)）
- `node_modules/.bin` 为空时按直接路径跑：`node node_modules/typescript/bin/tsc --noEmit`、`node node_modules/tsdown/dist/run.mjs`、`node node_modules/vitest/vitest.mjs run`
- 链接校验：`python <maintenance-flow>/check-markdown-links.py <本仓> --fragments --refs` —— 本仓不自带脚本，用维护者 skill 目录里那份；[ci.yml](.github/workflows/ci.yml) 不跑这一条，改完文档手工跑
- 换行校验：`git diff --check` —— 与链接校验一样本仓不带脚本、改完文档手工跑

## 事实来源（只查不抄）

本文件与各文档一律不抄会漂的值，要精确值时现查：

- 版本号、依赖范围、`engines` → [package.json](package.json)
- 测试数量与类型检查结果 → 现跑 `vitest run` / `tsc --noEmit`（CI 落地后改指 CI 运行记录）
- 产物清单与体积 → `Get-ChildItem lib` 现查
- 宿主槽名与 `kind`、客户端服务名 → 实装宿主包：`<DSH 安装目录>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-*/**`
- 发布态该有什么 → [scripts/check-release.mjs](scripts/check-release.mjs) 的断言集合

## 验证快照

- **[ci.yml](.github/workflows/ci.yml) 跑三平台矩阵**（ubuntu / windows / macos），每格：install → typecheck（两半体）→ build →
  离线 shim 验证 → test（带覆盖率门槛）→ lint → format:check → check:release。
  2026-10-01 首跑三格全绿；macOS 格上 `tests/electron-discovery.spec.ts` 不再是全跳（只剩 win32 专属那两条），
  说明三条真 `plutil` + 真 `X_OK` 守卫真的执行了。跑没跑、绿不绿看
  [CI 运行记录](https://github.com/dsh-plugin-lab/dsh-workbuddy-bridge/actions/workflows/ci.yml)，数字不抄。
- 本机（Windows）实跑：`vitest` 全绿（文件数随套件增减，现跑现看）；skip 的那些是**平台专属断言**，不是缺陷 ——
  平台矩阵就是为它们存在的：POSIX 语义那几条在 ubuntu / macOS 上真跑，打真实 `reg.exe` 的只在 Windows 上跑，
  真 `plutil` + 真 `X_OK` 的只在 macOS 上跑
- 链接校验 0 errors、0 warnings（文件与链接计数随文档增删变，不抄）

## 待办

- **每次发版后都要人工过一眼 Release notes**（常设规则，不是某一次的任务）：正文来自 Release Drafter 草稿，
  草稿只机械罗列 PR 标题。两件事必须补进去才发得出去：
  - **真机脚本跑过哪些 case、跳过了什么** —— 别把「CN 五个 case 过了」说成「身份矩阵全过」，
    也别声称 macOS 自动发现已验证（本机是 Windows，那条链打 `SKIP`；判据见 [docs/PUBLISHING.md](docs/PUBLISHING.md) 第 5 条）；
  - **用户可感知的语义变化**要单独成段，别藏在 PR 标题里。
  做法是 `gh release edit <tag> --notes-file <file>`（2026-10-20 发 `v0.5.1` 时即按此补写）。
- [ ] **windows-leg 偶发 `EPERM`（已知 flaky，不是回归）**：`tests/catalog-lifecycle.spec.ts` 的
  「hides the group when the credential disappears…」清理临时目录时删不掉
  `.workbuddy-host-heartbeat.json`，子进程句柄还没释放。撞到就重跑，别当成自己的改动有问题。
  根因在清理逻辑：应改成删除失败重试、或先等句柄释放再删目录。

## 活跃坑

- **上游按提示词内容风控，产品名是敏感串；错误文案里的状态码会被宿主读成鉴权结论**：
  2026-10-21 实测，国内网关对 system/developer 里出现 `DeepSeek Harness` 的请求回
  400 / `11128`，中性化后实测 **200**（小体 197 B 与大 3 KB 两档都测过——社区流传的
  "请求体 >1KB 才触发"不是普遍规律，别当判据）；同一天该账号还回过 403 / `11140`
  （`displayMsg`「账号存在异常行为，已被限制使用」），那是**账号级限制，与提示词无关**，
  插件修不了，只能申诉或换号，且实测会解除——排查时别把两者混成一条。
  两件事的处置都在 wire 边界与 shim：签名中性化住 `prepareChatBody()`
  （**路径语境不碰**，真实目录名里就有这个词组）；错误文案住 `failureMessage()`
  ——宿主 `dsh-llm-pi-ai` 用 `/\b(?:401|403)\b/` 文本匹配判 `AUTH`，
  拼了 `(http 403)` 就会把封号/限流/参数错一律显示成「API 密钥无效」。
  **只有 `session_dead` 允许带状态码**。
  判据在 `tests/prepare.spec.ts` 与 `tests/shim.spec.ts`，推理与实测矩阵见
  [.agents/notes/2026-10-21-channel-signature-and-error-text.md](.agents/notes/2026-10-21-channel-signature-and-error-text.md)。
- **`off` 只是选择器的档位名，不是 wire 拼写；两个端点都拒它**：`thinkingLevelMap.off` 必须是字符串
  （`null` 会让 Off 从选择器消失），而 pi-ai 同时拿它当"未指定档位时自动发送的值"。上游对这个字面量
  一律 400 / `11133`，国际版见 #49、国内版见 #13。所以 strip 挂在**两版共用**的 `prepareChatBody()`，
  `chatStream()` 两个 region 都过一遍归一化 —— 别再把它挪回 region 分支，"CN 原样透传"正是 #13 的故障形态。
  `'none'` 不替换、不删除（`gpt-6-astra` 拒它、`kimi-k2.8-preview` 收下却忽略）；`off` 也不进探测候选
  （探测只能证明"收下"，证明不了"关掉了"）。判据与替代方案见
  [.agents/notes/2026-10-20-off-effort-strip-both-regions.md](.agents/notes/2026-10-20-off-effort-strip-both-regions.md)。
- **宿主版本可能与 devDeps 错位**：本仓 devDeps 锁在某个宿主编译，实际运行的宿主可能更新。
  改代码前先跑 `dsh --version` 对比 [package.json](package.json) 的 devDeps；错位可能导致编译通过但运行时崩。
  升级 devDeps 要同步决定 `engines.dsh` 的兼容范围。
  连带一条：宿主线升级时，**宿主包的传递依赖也可能被抬**（`dsh-llm-pi-ai` 曾把 `@earendil-works/pi-ai`
  从 `^0.85.1` 抬到 `^0.87.1`）。本仓若把它写死在旧版，pnpm 会装出**两份同名包**，
  类型互不兼容 → 编译报「A 不能赋给 B」而两个路径都是 `node_modules`。判据：报错里出现两个
  不同层级的 `node_modules`；处置：把本仓那份升到与宿主同源的范围。
  核验兼容性用**仓库外**的临时目录装目标线宿主包。在仓内建目录的代价是双份的：
  pnpm 把它当 workspace 成员，`pnpm add` 会顺带重排本仓 `node_modules`，并往 `pnpm-lock.yaml`
  写一条 **importer** 记录 —— 目录删了记录还在，而**本机 `pnpm install` 不带 `--frozen-lockfile`，
  会静默自愈**，只有 CI 的 frozen 模式才判红（2026-10-02 三平台齐红，失败在第一步 install）。
  判据：`Select-String pnpm-lock.yaml '<目录名>'`；处置：`pnpm install` 重解析（别手工编辑 lockfile）。
- **浏览器产物里不能出现 `process` 这个词，注释也不行**：`tests/redlines.spec.ts` 拿它当「内联了 React 运行时」的
  signature（2026-09-25 真机事故：整份 react-dom 被内联，顶层 `process.env.NODE_ENV` 在浏览器里抛错）。
  判据是对**整份产物**做正则，**注释同样命中** —— 而打包器会把被引用语句周围的注释一起留下。
  共用模块（`src/shared/paths.ts`）被浏览器半引用时，它的措辞别用宿主专有的词。
- **`lib/client.js` 的 CSS 类名随构建路径变**：lightningcss 的 `[hash]` 把 CSS 文件的**绝对路径**算进去了
  （同一份内容、三个不同路径 → 三个不同 hash，实测）。在别处 checkout 重建，产物 hash 会整批不同 ——
  不影响功能，但提交 `lib/` 前最好在维护者本机路径重建一次。
  连带一坑：`tests/version.spec.ts` 那条「类名表有序」原来扫**整份产物**，而 hash 以数字开头时会被转义成前导下划线、
  正好被旧正则 `"[0-9a-zA-Z]+_…"` 跳过 —— 它其实只扫到一个样式表，换路径或新增样式表就会翻红。
  已改成**按样式表**检查有序，这才是 `tsdown.config.ts` 保证的粒度。
- **tag 触发的守卫必须排除「正在发的那个 tag」**：`git describe --tags --abbrev=0` 会解析出刚推上去的那个 tag 自己，
  `<tag>..HEAD` 恒为空 → 一次完全正常的发布被判「没有可发布的内容」（2026-09-26 `v0.2.0` 首发实踩）。
  判据：守卫那步带 `--exclude=${{ github.ref_name }}`（dispatch 触发时它是空操作）。
- **发布链分段，前一段绿不等于后一段绿**：`v0.2.0` 那次 npm 已经发成功，只有一个瞬时 HTTP 500 让 GitHub Release 没建出来。
  重跑靠幂等自愈（版本已在 npm 上 → 跳过 publish，只补 git 侧）；git 侧步骤本身也要对 5xx 重试，别让一次抖动把整条链判死。
- **设置命名空间 = loader 条目 id，不是包名**：`configForms.get()` 收的是命名空间，
  而宿主按 `ns: entry.options.id` 发布设置文档。喂包名的表现是**静默**的 —— 那个命名空间
  从没被服务过，`whileServed` 永不触发，**配置页根本不出现**（2026-09-25 真机踩过）。
  分工：槽 key 取**包名**（宿主按 `pkg.name` 派发），命名空间取**条目 id**；
  两个常量各自由红线钉在 `cordis.patch.yml` 上
- **Windows 上取凭据要用 WorkBuddy 自带的 Electron**：桌面凭据是 at-rest 加密的，
  密钥助手就是那个 exe。**发现策略按平台选**（`cnAppDiscovery()`，宿主与 CLI 共用一处）、
  **默认路径按策略取** —— 两者混用会让一条策略报出另一条平台的路径，与紧随其后的
  发现流程自相矛盾
- **`reg query` 的退出码 1 有两种形状、都是「这一格没有」**：键在但没匹配 → stdout 打本地化的
  「找到 0 匹配」；键不在 → stdout 空、消息走 stderr。只有**被杀死（超时）**或**没起来**
  （非数字 code）才算「查不了」。这条猜不出来 —— 别用替身测，红线上有一条打真实 `reg.exe` 的守卫
- **槽的 `kind` 决定能不能注册**：`kind: 'single'` 的槽一格只能有一个占用者 —— 同 priority 再注册会抛错，
  而**抛出方是后注册的那一个**（宿主自带 UI 会因此消失）；要并排只能选 `kind: 'list'` 的槽。
  判据与先例见 [docs/PUBLISHING.md](docs/PUBLISHING.md) 的「平台契约的取真源方式」
- **pnpm 11 的供应链门禁会拒收刚发布的宿主 rc**：默认拒收发布不足 24 小时的版本，
  而本插件跟的就是宿主的 rc 线 —— 报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，install 直接失败
  （本机与 CI 同样）。处置见 [pnpm-workspace.yaml](pnpm-workspace.yaml)
- **pnpm 11 的 symlink 链接器在本机会卡死**（343 个包已就位却搭不出 `node_modules`）→ 一律加 `--config.node-linker=hoisted`
- `node_modules/.bin` 可能为空 → 按上面的直接路径调用工具
- `Rename-Item` 对正在被 install/build 占用的目录会失败 → 改名前先确认无相关进程
- **测试断言里不许出现 locale 相关字面量**（「11月19日」这类 `Intl` 产物）：本机系统 locale 是中文
  所以绿，ubuntu runner 默认 en，同一 `Intl` 调用产出 "Nov 19"，断言必红 —— 平台差被本机掩盖
  （2026-09-25 CI 实踩，3eb0098 起两轮红）。日期/数字断言一律走 `format.ts` 的格式化器或
  `t(key)`，断言字面量只允许平台无关的（如 "Status"）
- **`.gitignore` 里一行裸 `AGENTS.md` 曾把整张文档网络吞掉**（13 份都不入库）：新增忽略规则时用具体路径，
  别用会匹配到文档名的裸文件名
- **反引号里的文档路径不在链接校验的扫描范围**：`check-markdown-links.py` 只解析 `.md` 里的 `[..](..)`，
  代码注释与正文里的 `` `docs/x.md` `` 一律照不到 —— 目标被搬走、或压根没入库，都是静默的。
  判据：动过文档路径就 `git grep -n <文件名>` 现查目标存在（2026-09-29 就是这么查出四份从未入库的规划文档
  被 10 处注释引用，处置见 [.agents/notes/2026-09-29-dead-doc-references-retargeted.md](.agents/notes/2026-09-29-dead-doc-references-retargeted.md)）
- **覆盖率有三条判据**：`@vitest/coverage-v8` 必须与 `vitest` 同版（不同版是双向 unmet peer，`pnpm peers check` 当场报，
  两个包要一起装）；`include` 写 `src/**` 会把子树的文档双件与 `.css` 一起交给 v8 解析 ——
  每次刷 20 组 `RolldownError: Parse failed`（收窄成 `src/**/*.{ts,tsx}` 即无）；不开 `exclude` 则浏览器 lane 里
  inline 的官方包会因缺 `.js.map` 让 v8 的 remap 直接抛。全套定义在 [vitest.config.ts](vitest.config.ts)
- **真机脚本进不了 CI，落点是发版清单**：`scripts/issue-48-forced-fallback-e2e.mjs` 读真机凭据文件、且开头就是前提断言，
  托管 runner 上必崩（不是缺陷，是平台事实）；三条真机脚本的位置是 [docs/PUBLISHING.md](docs/PUBLISHING.md)「发版前确认」第 5 条
- **活文档里的宿主版本提示只警告、不阻断**（[tests/redlines.spec.ts](tests/redlines.spec.ts)）：按**行**看，同一行既点名宿主
  （`DSH` / `宿主` / `Harness`）又出现 `package.json` 里那个下限值、而该段没点出处也没标历史 → 打一条 warning 给人判一眼。
  写历史陈述请用仓库陈词（`先例` / `当时` / `历史` / `X 起`）；判据与替代方案见
  [.agents/notes/2026-10-01-live-doc-host-version-guard.md](.agents/notes/2026-10-01-live-doc-host-version-guard.md)
- **katex 的 low 告警（GHSA-238p-pmpm-9mq7）消不掉，修复方是宿主包**：本仓直接依赖那份 katex 已是 `^0.18.2`
  （锁里 0.18.10），残留的 vulnerable 实例挂在 `micromark-extension-math@3.1.0` 上（pnpm 快照精确钉死 `katex: 0.16.47`，
  上游 registry 声明 `^0.16.0` 且**无更新版本可升**）。它**不是死依赖**——`@deepseek-ai/dsh-client-ui-primitives`
  的 manifest `dependencies: null`，却在 `lib/index.js` 运行时 import 它，本仓 devDependencies 声明它正是替宿主包补位。
  **实测 `pnpm remove` 会打断宿主包**（3 个 browser 测试红）；`pnpm.overrides` 会把兼容性责任转到本仓，不值。
  正确修复方是宿主包声明缺失的依赖，或上游发新版。

## 文档网络与自更新

- **一条事实只有一个 home**：根 [README.md](README.md) 讲门面，本文件讲规则与仪表盘，子目录的双件里文档层讲「有什么 / 改哪」、
  规则层讲「在这里怎么干」，[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 讲不变的设计，[.agents/notes/](.agents/notes/) 讲为什么。
  别处一律链接。
- **能自证的不抄**：测试数字、产物体积、版本号一律指向 CI、`package.json` 或现查命令。
- **改根 [README.md](README.md) 必同改 [README_en.md](README_en.md)**：能力清单、上手步骤、指针逐条对齐，冲突以中文为准。
- **记录层不追改**：[docs/archive/](docs/archive/) 写的是当时的事实，批量改名不许扫进那一层（判据见 [docs/AGENTS.md](docs/AGENTS.md)）。
- **坑按作用域分流**：只在某个子目录才会踩的坑写进该目录的 `AGENTS.md`（进入即自动注入），本文件只留跨模块、致命的那几条。
- 改完文档跑一次链接校验；新增或改名文件后回填所在目录文档层的「变更影响路由」。

## 文档地图

- 门面 → [README.md](README.md) · [README_en.md](README_en.md)
- 规则与仪表盘 → 本文件
- 设计、契约、发布手册与文档层说明 → [docs/README.md](docs/README.md)；兼容与限制 → [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)；命令行 → [docs/CLI.md](docs/CLI.md)
- 决策记录（当时为什么这么定）→ [.agents/notes/](.agents/notes/)
- 源码手册 → [src/README.md](src/README.md)；浏览器半边 → [src/client/README.md](src/client/README.md)
- 测试手册 → [tests/README.md](tests/README.md)；脚本 → [scripts/README.md](scripts/README.md)
- 门面截图与重截判据 → [assets/README.md](assets/README.md) · [assets/AGENTS.md](assets/AGENTS.md)
- 来源与双版权 → [NOTICE](NOTICE)
- 跨仓规范 → [plugin-conventions](https://github.com/dsh-plugin-lab/.github/blob/main/docs/plugin-conventions.md)
  （插件仓共同遵守的公约；判这条算不算缺陷见 [criteria](https://github.com/dsh-plugin-lab/.github/blob/main/docs/criteria.md)）