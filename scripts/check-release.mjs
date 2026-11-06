/**
 * 发布前检查。
 *
 * 本仓是发布态：`dsh.bundle.patch` 在、`private` 不在、展示元数据（`locale/` + `icon.svg`）齐。
 * 本脚本把「发布态该有什么」变成可执行断言，避免靠人记得。
 *
 * 其中一组是**插件展示元数据**：宿主**直接读包内的** `locale/*.json` 与 `package.json`，
 * 一行代码都不经过我们 —— 所以「文件在不在、有没有被 `exports` 与 `files` 覆盖」只能在这里守。
 * 覆盖不全时宿主**静默回落**（标题退成包名、描述退成 `package.json.description`、图标退成默认图），
 * 界面上不报错。回落链与字段规则见 locale/AGENTS.md。
 *
 * 另一组是**声明面自洽**：`engines.dsh` 与全部 `@deepseek-ai/dsh-*` 声明的下限必须同形、不得低于
 * `engines.dsh` 的下限。兼容性由 `engines.dsh` 单独决定（自 0.2.1-alpha.4 起，包声明了它之后
 * peer 的 `dsh*` 区间不参与判定），所以这份比对守的是「同一件事别写两个值」，不证明任何版本
 * 组合装得上 —— 「peer 与宿主版本不一致就装不出来」是 0.2.1-alpha.4 之前的旧规则。
 *
 * 退出码：0 = 全过 / 1 = 有未过 / 2 = 前置条件缺失（读不到 `package.json`）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname } from 'node:path'

const failures = []
let pkg
try {
  pkg = JSON.parse(readFileSync('package.json', 'utf8'))
} catch (error) {
  console.error('读不到 package.json —— 发布检查的前置条件不成立。')
  console.error(String(error))
  process.exit(2)
}

/** 断言一条发布态不变量。 */
function require_(label, ok, hint) {
  if (!ok) failures.push(`${label} —— ${hint}`)
}

require_(
  'dsh.bundle.patch',
  pkg.dsh?.bundle?.patch === './cordis.patch.yml',
  'bundle 层依赖它；缺了装出来的包不会被 profile 装载。',
)
require_('private', pkg.private !== true, '发布前要移除 private: true。')
require_('engines.dsh', typeof pkg.engines?.dsh === 'string', '宿主兼容范围必须声明。')
require_(
  'files 含 cordis.patch.yml',
  Array.isArray(pkg.files) && pkg.files.includes('cordis.patch.yml'),
  'bundle 层依赖它。',
)
require_('LICENSE 存在', existsSync('LICENSE'), 'package.json 声明 MIT，仓库里必须有对应文件。')
require_('NOTICE 存在', existsSync('NOTICE'), '来源与双版权声明是发布产物的一部分。')
require_(
  'files 含 NOTICE',
  Array.isArray(pkg.files) && pkg.files.includes('NOTICE'),
  'NOTICE 不在 files 里就不会进包。',
)

/** npm 的 `files` 语义：先看有没有正面模式覆盖，再看不被否定模式排除。 */
function published(file, files) {
  const covered = (pattern) => {
    const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    return (
      normalized === '.' ||
      normalized === '' ||
      matchesGlob(file, normalized) ||
      matchesGlob(file, `${normalized}/**`)
    )
  }
  return (
    files.some((pattern) => !pattern.startsWith('!') && covered(pattern)) &&
    !files.some((pattern) => pattern.startsWith('!') && covered(pattern.slice(1)))
  )
}

/** 只认 `*`（段内）与 `**`（跨段）两种通配 —— 够读 `files` 里的模式，不引依赖。 */
function matchesGlob(file, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
  return new RegExp(`^${body}$`).test(file)
}

/** 非空字符串。 */
function isText(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** 读一个 JSON 文件；读不到或解析失败记账后返回 undefined。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    failures.push(`${file} —— 读不到或不是合法 JSON：${String(error)}`)
    return undefined
  }
}

const LOCALE_DIR = 'locale'
const localeFiles = existsSync(LOCALE_DIR)
  ? readdirSync(LOCALE_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort()
  : []

// 宿主先解析 locale/en.json，再枚举同目录下的每一个 *.json；两者都经 Node 子路径导出解析，
// 所以 exports 与 files 少覆盖一个，装出来的包就少一个能读到的语言文件。
require_('locale 目录存在', existsSync(LOCALE_DIR), '插件展示元数据的家。')
require_(
  'locale/en.json 是发现入口',
  localeFiles.includes('en.json'),
  '宿主先解析它；缺它时其余语言文件根本不会被读。',
)
require_(
  'exports 暴露 ./locale/*.json',
  pkg.exports?.['./locale/*.json'] === './locale/*.json',
  '宿主经 Node 解析读语言文件；没有这条子路径导出，一个都读不到。',
)
require_(
  'exports 暴露 ./package.json',
  pkg.exports?.['./package.json'] === './package.json',
  '标题与描述的回落位、以及 icon 声明，都从导出的清单里读。',
)

for (const name of localeFiles) {
  const file = `${LOCALE_DIR}/${name}`
  const language = name.slice(0, -5)
  require_(
    `${file} 的文件名是语言 id`,
    /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language),
    '宿主拿文件名当语言 id，形状不合法会让整包元数据降级成一条诊断。',
  )
  require_(
    `files 收录 ${file}`,
    Array.isArray(pkg.files) && published(file, pkg.files),
    '装出来的包里没有它，只有本地开发时看得见 —— 插件页会静默回落成包名。',
  )
  const parsed = readJson(file)
  if (parsed === undefined) continue
  const meta = parsed.meta
  require_(
    `${file} 的 meta.title`,
    isText(meta?.title),
    '标题必须是非空字符串：字段名写错或写成空串都等于没写。',
  )
  require_(`${file} 的 meta.description`, isText(meta?.description), '描述同上。')
}

// 两份语言文件的键集必须逐字相同：少一个字段只会在那种语言下露出另一种语言。
if (localeFiles.length > 1) {
  const shapes = localeFiles.map((name) => {
    const parsed = readJson(`${LOCALE_DIR}/${name}`) ?? {}
    return {
      name,
      keys: Object.keys(parsed.meta ?? {})
        .sort()
        .join(','),
    }
  })
  const first = shapes[0]
  for (const shape of shapes.slice(1)) {
    require_(
      `${LOCALE_DIR}/${shape.name} 的键集与 ${LOCALE_DIR}/${first.name} 相同`,
      shape.keys === first.keys,
      '键集不同时，缺字段的那种语言会露出另一种语言的文案。',
    )
  }
}

/** 取一个普通文件的信息；读不到或不是普通文件返回 undefined。 */
function fileOf(file) {
  try {
    const stat = statSync(file)
    return stat.isFile() ? stat : undefined
  } catch {
    return undefined
  }
}

// 图标那一组照宿主 `iconOf()` 的判据：相对路径、四种扩展名、留在清单目录内、普通文件、<= 256 KiB。
// 任何一条不满足都只是「插件页回落到默认图」加一条诊断 —— 界面上不报错，所以在这里拦。
const ICON_TYPES = ['.svg', '.png', '.jpg', '.jpeg', '.webp']
const MAX_ICON_BYTES = 256 * 1024
if (pkg.icon !== undefined) {
  const icon = typeof pkg.icon === 'string' ? pkg.icon : ''
  const relative = icon.replace(/^\.\//, '')
  const inside =
    relative !== '' &&
    !relative.startsWith('/') &&
    !/^[A-Za-z][A-Za-z\d+.-]*:/.test(relative) &&
    !relative.split(/[\\/]/).includes('..')
  require_(
    'icon 是清单目录内的相对路径',
    inside,
    '绝对路径、URL 或越出清单目录的路径都会被宿主拒绝。',
  )
  require_(
    'icon 的扩展名可用',
    ICON_TYPES.includes(extname(relative).toLowerCase()),
    '宿主只认 SVG / PNG / JPEG / WebP。',
  )
  const iconFile = inside ? fileOf(relative) : undefined
  require_(
    'icon 存在且是普通文件',
    iconFile !== undefined,
    '声明了却读不到，插件页只会用默认图（不报错）。',
  )
  require_(
    'icon 不超过 256 KiB',
    (iconFile?.size ?? 0) <= MAX_ICON_BYTES,
    '超过 256 KiB 会被宿主拒绝。',
  )
  require_(
    'files 收录声明的图标',
    inside && Array.isArray(pkg.files) && published(relative, pkg.files),
    '图标必须自包含并且进包，否则插件页只剩默认图。',
  )
}

// 声明面自洽：`@deepseek-ai/dsh-*` 的下限不得低于 `engines.dsh` 的下限。
//
// 比的是**下限**，不是形状：本仓 `engines.dsh` 与全部 `@deepseek-ai/dsh-*` 声明现同形
// （一族一 `^` 的并集），但形状由维护者定、可能变，所以这条断言只管下限 ——
// 「不管写成哪种形状，能装出来的最低那一版都不低于 `engines.dsh` 的下限」，
// 那才是使用者会踩到的东西。
const floor = typeof pkg.engines?.dsh === 'string' ? pkg.engines.dsh.trim() : ''
const floorVersion = lowerBoundOf(floor)
require_(
  'engines.dsh 能读出一个下限',
  floorVersion !== undefined,
  `engines.dsh 写的是 ${JSON.stringify(floor)}；读不出下限就没法判「peer 的下限不低于它」。`,
)
if (floorVersion !== undefined) {
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/dsh')) continue
    const text = String(range).trim()
    const version = lowerBoundOf(text)
    require_(
      `peer ${name} 能读出一个下限`,
      version !== undefined,
      `peer 写的是 ${text}；认不出的形状要人看一眼，别让它静默跳过。`,
    )
    require_(
      `peer ${name} 的下限不低于 engines.dsh`,
      version !== undefined && compareFloor(version, floorVersion) >= 0,
      `peer 写的是 ${text}（下限 ${version ?? '?'}），engines.dsh 写的是 ${floor} —— 按 peer 装出来的宿主可能不满足 engines。`,
    )
  }
}

/**
 * 从一个依赖区间里取**最低**的那一版；认不出形状时返回 undefined。
 *
 * 支持本仓与另两仓用到的三种写法：`>=1.2.3`、`^1.2.3`、`~1.2.3`，
 * 以及用 `||` 连接的多段（取各段里最低的那个）。带上界的 `>=a <b` 取 `a`。
 */
function lowerBoundOf(range) {
  const parts = String(range).split('||')
  const bounds = []
  for (const part of parts) {
    // `>=a <b` 这类先只取第一个比较符那一项。
    const token = part.trim().split(/\s+/)[0] ?? ''
    const match = token.match(/^(?:>=|\^|~)?\s*v?(\d[\w.-]*)$/)
    if (match === null) return undefined
    bounds.push(match[1])
  }
  if (bounds.length === 0) return undefined
  return bounds.reduce((lowest, next) => (compareFloor(next, lowest) < 0 ? next : lowest))
}

/** 比较两个 `x.y.z[-pre]` 版本；只用于下限排序，不引 semver。 */
function compareFloor(a, b) {
  const parse = (value) => {
    const [core, pre = ''] = value.split('-', 2)
    const nums = core.split('.').map((part) => Number.parseInt(part, 10) || 0)
    return { nums, pre }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0)
    if (diff !== 0) return diff
  }
  // 有预发布段的那一侧更低（`0.1.7-alpha.1` < `0.1.7`）。
  if (left.pre === right.pre) return 0
  if (left.pre === '') return 1
  if (right.pre === '') return -1
  return left.pre < right.pre ? -1 : 1
}

if (failures.length > 0) {
  console.error('release check failed:')
  for (const line of failures) console.error(`  - ${line}`)
  process.exit(1)
}
console.log('release check passed')
