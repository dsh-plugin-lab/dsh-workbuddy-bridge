# 决策：peer 与 dev 版本不一致，一律「dev 跟 peer」（2026-10-20）

状态：**部分被取代** —— 决策本身（dev 跟 peer、peer 一个字节不动）仍生效；理由里「peer 是对宿主的兼容声明 / 收窄 peer 会让宿主静默跳过本插件」已被取代：自 0.2.1-alpha.4 起，包自己声明了 `engines.dsh` 就只按它判，`@deepseek-ai/dsh*` 的 peer 区间不参与兼容性判定（真源是宿主 `plugin-compatibility.ts`）。正文保留原样，作为当时的判例。

## 问题

组织判据 `peer and dev versions must agree`（**Must agree** 档，见
[criteria.md](https://github.com/dsh-plugin-lab/.github/blob/main/docs/criteria.md)）在本仓实测三处漂移：

| 包 | `peerDependencies` | `devDependencies` |
|---|---|---|
| `@deepseek-ai/cordis` | `^4.0.4` | `4.0.4` |
| `@deepseek-ai/schemastery` | `^3.18.4` | `3.18.5` |
| `react-dom` | `^18.2.0` | `^18.3.1` |

另三个插件仓逐条相等（balance 14/14、zhihu 13/13、debugging 9/9），只有本仓不是；本仓也**没有**
这条判据的红线断言，所以它一直是「只写在散文里的规则」。追踪 issue：
[dsh-plugin-lab/.github#8](https://github.com/dsh-plugin-lab/.github/issues/8)。

## 决策

**三处一律让 dev 跟上 peer 的区间**，peer 一个字都不动：

| 包 | peer（不动） | dev 改前 → 改后 |
|---|---|---|
| `@deepseek-ai/cordis` | `^4.0.4` | `4.0.4` → `^4.0.4` |
| `@deepseek-ai/schemastery` | `^3.18.4` | `3.18.5` → `^3.18.4` |
| `react-dom` | `^18.2.0` | `^18.3.1` → `^18.2.0` |

并补一条红线（[tests/redlines.spec.ts](../../tests/redlines.spec.ts) 的 `依赖分层` →
「每个 peer 的版本必须与同名 dev 的版本逐字相等」），**范围是全部 peer**：`react-dom` 正是非
`@deepseek-ai/` 包里的那一处漂移，只查官方包会让判据只对一半清单成立。

### 为什么方向是「dev 跟 peer」，不是反过来

- **peer 是对宿主的兼容声明，dev 是本地装出来的那棵树。** 把 peer 收窄成精确版本（`4.0.4`、
  `3.18.5`）会让装到别的补丁版本的宿主**静默跳过本插件** —— peer 冲突被 `catch` 进
  `skippedBundles`，症状是「插件像没装」（见 [AGENTS.md](../../AGENTS.md)「活跃坑 · 宿主版本
  可能与 devDeps 错位」）。这条代价比「dev 的写法不够精确」重得多。
- **peer 的区间宽度是实测出来的兼容面，不是笔误**：宿主 meta 包 `@deepseek-ai/dsh@0.1.7-rc.1`
  依赖 `@deepseek-ai/schemastery: ~3.18.4`，`0.2.1-rc.2` 依赖 `~3.18.5` —— 本仓 `engines.dsh`
  同时声明这两族，所以 schemastery 的 peer 下限**必须**留在 `^3.18.4`。把 peer 抬成 `^3.18.5`
  等于在兼容声明与判据之间制造新的自相矛盾。
- **dev 用 caret 不减损「我们测的是什么」**：`^3.18.4` / `^18.2.0` / `^4.0.4` 在今天的 registry
  上分别解到 `3.18.5` / `18.3.1` / `4.0.4`，与改前**逐条相同**（见下面的实测）。

## 替代方案

| 方案 | 否决理由 |
|---|---|
| dev 不动，把 peer 改成精确版本（`4.0.4` / `3.18.5`） | 精确 peer 是**兼容性收窄**：宿主补丁版本不同就静默跳过本插件，且本仓 `engines.dsh` 仍是三族并集，声明面自相矛盾 |
| dev 不动，把 peer 抬到 dev 的值（schemastery `^3.18.5`、react-dom `^18.3.1`） | 丢掉 `0.1.7` 宿主线（它带的是 `~3.18.4`）；判据只要求**两边相等**，没要求取哪一边 —— 那就该取不损失兼容面的那一边 |
| 只给 `@deepseek-ai/*` 补断言，`react-dom` 登记为已知偏差 | 判据原文是「所有 peer」；只查官方包的断言会让「闸门只对一半清单成立」变成新的假绿 |
| 什么都不改，长期挂在 `known-findings.json` | 这是 Must agree 档，且修法没有风险（实测只改声明、装出来的树一模一样）；豁免的成本比修高 |

## 影响

- `package.json`：三处 dev 版本（peer 不变）；`pnpm-lock.yaml` 只跟着改三行 `specifier`。
  pnpm 重解析时顺带把 cordis 的传递依赖 `@deepseek-ai/cosmokit` 从 `1.8.5` 抬到 `1.8.6`
  （同一区间内的新版，由 pnpm 自己写进锁文件，**不手改锁文件**）。
- **实测（2026-10-20，本机 Windows）**：改后 `pnpm install --config.node-linker=hoisted` 解出的
  版本与改前逐条相同 —— cordis `4.0.4`、schemastery `3.18.5`、react `18.3.1`、react-dom `18.3.1`；
  `pnpm run check` 38 个文件 / **568 passed | 11 skipped**；`lint`、`format:check`、`check:release`
  全过。所以这是一次**纯声明面**修正，不动装出来的树、也不动编译结果。
- **红线有牙齿（实测两条反向控制）**：把 cordis 的 dev 改回 `4.0.4` → 红并点出
  `peer "^4.0.4" dev "4.0.4"`；把 `react-dom` 的 dev 改回 `^18.3.1` → 同样红 —— 证明这条断言的
  范围真的覆盖非 `@deepseek-ai/` 包，而不是「官方包相等就算过」。

### 踩到的坑：本地 `pnpm install` 会自愈，只有 CI 的 frozen 模式判红

第一次推送后 **CI 三平台齐红**，卡在 `pnpm install --frozen-lockfile`：

```
specifiers in the lockfile don't match specifiers in package.json
* 1 dependencies are mismatched: react-dom (lockfile: ^18.3.1, manifest: ^18.2.0)
```

成因是上面那两条反向控制：改 `package.json` 做变异时，`pnpm exec vitest` 的
`verify-deps-before-run` 顺手跑了一次 install，把锁文件里的 `react-dom` specifier 写回了
`^18.3.1`；随后把 `package.json` 恢复，但**没有**再 install —— 于是清单与锁文件不一致，
而本机 `pnpm install` 不跑冻结模式，看不出任何异常。

判据与处置：改完依赖**必须**跑一次 `pnpm install --frozen-lockfile --config.node-linker=hoisted`
（与 CI 同一条命令），它才是「清单与锁文件是否一致」的检测器。这条与
[AGENTS.md](../../AGENTS.md) 活跃坑里「本机 `pnpm install` 不带 `--frozen-lockfile` 会静默自愈，
只有 CI 的 frozen 模式才判红」是同一族。

