/**
 * 红线：这些不是风格偏好，是「错了会静默坏掉」的不变量。
 *
 * 每条都尽量写成**可执行**的：读源码 / 读清单 / 读锁文件，而不是复述散文。
 * 扫描类的断言一律自带「扫描器真的看到了东西」的自检 —— 否则它就是永不触发的假绿。
 *
 * 唯一例外是 `文档不抄实测值` 里那条宿主版本提示：它只 **warn**、不 fail —— 判据是形状，
 * 规则管的是意图，两者不可能完全对齐，所以它只配提示复核（见该处注释）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string
  version: string
  private?: boolean
  engines: { node: string; dsh?: string }
  exports: Record<string, unknown>
  files: string[]
  icon?: string
  dsh: { bundle?: { patch?: string }; client?: { platform?: string; inject?: string[] } }
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
}

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

describe('依赖分层', () => {
  it('@deepseek-ai/* 绝不进 dependencies', () => {
    const deps = (pkg as { dependencies?: Record<string, string> }).dependencies ?? {}
    expect(Object.keys(deps).filter((name) => name.startsWith('@deepseek-ai/'))).toEqual([])
  })

  it('每个 peer 都同时在 dev —— 否则本机装不出可编译的树', () => {
    const missing = Object.keys(pkg.peerDependencies).filter(
      (name) => pkg.devDependencies[name] === undefined,
    )
    expect(missing).toEqual([])
  })

  it('dsh 平台包的 peer 与 dev 都必须能读出一个下限', () => {
    const bounds = Object.keys(pkg.peerDependencies).filter((name) =>
      name.startsWith('@deepseek-ai/dsh'),
    )
    // 自检：这条断言必须真的有对象可查。
    expect(bounds.length).toBeGreaterThan(0)
    for (const name of bounds) expect(pkg.devDependencies[name], name).toBeTruthy()
  })
})

describe('插件清单', () => {
  it('声明宿主兼容范围', () => {
    expect(typeof pkg.engines.dsh).toBe('string')
    expect((pkg.engines.dsh ?? '').trim()).not.toBe('')
  })

  it('客户端入口是 exports["./client"]，且声明了 web 平台', () => {
    expect(pkg.exports['./client']).toBeTruthy()
    expect(pkg.dsh.client?.platform).toBe('web')
  })

  it('dsh.client.inject 只列真实客户端图行（不夹带类型面）', () => {
    const inject = pkg.dsh.client?.inject ?? []
    // 自检：扫描器必须看到一份非空清单。
    expect(inject.length).toBeGreaterThan(0)
    const suspicious = inject.filter((name) => !name.startsWith('@deepseek-ai/'))
    expect(suspicious).toEqual([])
  })

  it('展示元数据与图标都在 files 覆盖里', () => {
    expect(pkg.files).toContain('icon.svg')
    expect(pkg.files).toContain('locale/*.json')
    expect(pkg.exports['./locale/*.json']).toBe('./locale/*.json')
  })

  it('dsh.bundle 的有无必须与 private 一致（否则被 dsh plugin 回填成双挂载）', () => {
    const declaresBundle = pkg.dsh.bundle?.patch !== undefined
    expect(declaresBundle).toBe(pkg.private !== true)
  })
})

describe('锁文件与源', () => {
  it('本仓的 .npmrc 不许把 registry 指到镜像站', () => {
    if (!existsSync(new URL('../.npmrc', import.meta.url))) return
    const npmrc = read('.npmrc')
    // 判据与另两仓一致：仓库级配置不覆盖 registry，跟随使用者/CI 的官方源。
    expect(npmrc).not.toMatch(/registry\s*=\s*https?:\/\/[^\s]*npmmirror/)
    expect(npmrc).not.toMatch(/registry\s*=\s*https?:\/\/[^\s]*taobao/)
  })
})

describe('插件展示元数据', () => {
  const localeDir = new URL('../locale/', import.meta.url)
  const localeFiles = readdirSync(localeDir)
    .filter((name) => name.endsWith('.json'))
    .sort()

  it('en.json 是发现入口，且存在', () => {
    expect(localeFiles).toContain('en.json')
  })

  it('中英两份的键集逐字相同，且只有 title / description', () => {
    expect(localeFiles.length).toBeGreaterThan(1)
    const shapes = localeFiles.map((name) => {
      const parsed = JSON.parse(readFileSync(new URL(name, localeDir), 'utf8')) as {
        meta: Record<string, string>
      }
      return { name, keys: Object.keys(parsed.meta).sort() }
    })
    for (const shape of shapes) expect(shape.keys, shape.name).toEqual(['description', 'title'])
    for (const shape of shapes.slice(1)) expect(shape.keys, shape.name).toEqual(shapes[0]!.keys)
  })

  it('门面点名的插件显示名与 locale 的标题逐字一致', () => {
    const en = JSON.parse(read('locale/en.json')) as { meta: { title: string } }
    const readme = read('README.md')
    const readmeEn = read('README_en.md')
    // 自检：门面里必须真的点了这个名 —— 否则这条断言查的是一个没人提的名字。
    expect(readme).toContain(en.meta.title)
    expect(readmeEn).toContain(en.meta.title)
  })
})

describe('插件图标', () => {
  it('是良构 XML 且声明的路径在包内', () => {
    expect(pkg.icon).toBe('./icon.svg')
    const svg = read('icon.svg')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
    // 标签成对：开标签数 == 闭标签数（自闭合的 <circle ... /> 不计）。
    const opens = (svg.match(/<[a-zA-Z][\w:-]*(?![^>]*\/>)[^>]*>/g) ?? []).length
    const closes = (svg.match(/<\/[a-zA-Z][\w:-]*>/g) ?? []).length
    expect(opens).toBe(closes)
  })

  /**
   * 控件与插件页图标各自是**一份自绘墨迹**，但都必须落在官方边距档位里。
   *
   * 这条守卫的来历值得留着：改版之前，控件渲染的是宿主的 `IconThinkOutlineRegular`，
   * 本仓一份私有墨迹都不维护，红线因此钉的是「icon.svg 的路径与宿主逐字相同」。
   * 2026-09-26 维护者改弦更张 —— 控件换成自己给的灯泡（未检测 / 已检测两态），
   * 插件页图标换成自己给的徽章；**钉字形的断言随之作废**，留下的是仍然成立的两条：
   *
   * - 控件的 svg 是**两态**的：闪电只在有检测记录时出现（生命周期见 probe-control 的 `lit`）；
   * - icon.svg 的墨迹**边距必须与官方同档** —— 「太大、周围太空」是量出来的，不是看出来的。
   */
  it('控件的灯泡是两态，icon.svg 的边距与官方同档', () => {
    const svg = read('icon.svg')
    const control = read('src/client/probe-control.tsx')

    // 控件：自绘灯泡，闪电走条件渲染而不是两套图形。
    expect(control).not.toContain('IconThinkOutlineRegular')
    expect(control).toContain('BULB_BODY')
    expect(control).toContain('BULB_BOLT')
    expect(control, '闪电必须是条件渲染的').toContain('{lit ?')

    // 插件页图标：仍是 36 格，且那组缩放变换还在（下面按它算边距）。
    expect(svg).toContain('viewBox="0 0 36 36"')

    /*
     * 边距：把 transform 解出来，算墨迹落在画布上的范围。
     * 官方的三个图标内容都在离边 6–9 之间，本仓取 7，所以断言 6–9 这个窗口。
     * 源徽章是满幅的 0..280（不是 16 格的字形），所以这里用**源图自己的外接框**换算，
     * 而不是宿主的字形框 —— 换图形时这一点必须跟着换，否则断言量的是别的图形。
     */
    const m = /<g transform="translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)"/.exec(svg)
    expect(m, 'icon.svg 里读不出那个缩放组').not.toBeNull()
    const [, tx, , s] = m as unknown as [string, string, string, string]
    const SOURCE_MIN = 0
    const SOURCE_MAX = 280
    const inkLeft = SOURCE_MIN * Number(s) + Number(tx)
    const inkRight = SOURCE_MAX * Number(s) + Number(tx)
    const margins = [
      ['左', inkLeft],
      ['右', 36 - inkRight],
    ] as const
    for (const [edge, margin] of margins) {
      expect(margin, `图标${edge}边距偏离官方档位`).toBeGreaterThanOrEqual(6)
      expect(margin, `图标${edge}边距偏离官方档位`).toBeLessThanOrEqual(9)
    }
    expect(inkLeft + inkRight, '图标没有居中').toBeCloseTo(36, 1)
  })
})

/**
 * 菜单材质成对：凡用 `--dsw-specific-menu` 画背景的表面，必须在**同一条规则**里带
 * `--dsw-menu-backdrop-filter`。宿主把菜单材质拆成了这两条 token，只写填充就是
 * 「透光但不磨砂」；而宿主自己的门禁只扫官方包，插件侧没有任何自动保护。
 *
 * 判据抄 dsh-ds-balance 的同形红线。
 */
describe('菜单材质成对', () => {
  it('画了 --dsw-specific-menu 的规则，同一条里必有 backdrop-filter', () => {
    const files = ['src/client/probe-control.module.css', 'src/client/workbuddy.module.css']
    let checked = 0
    for (const file of files) {
      const css = read(file)
      // 按规则块切：选择器 { ... }，花括号不嵌套（本仓的 CSS 没有 @media 嵌这些 token）。
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!(body ?? '').includes('--dsw-specific-menu')) continue
        checked += 1
        expect(
          body,
          `${file} 的 ${(selector ?? '').trim()} 画了菜单填充却没有 backdrop-filter`,
        ).toContain('--dsw-menu-backdrop-filter')
      }
    }
    // 自检：真的扫到了那条规则，否则这个断言永不触发。
    expect(checked, '没有扫到任何菜单填充规则 —— 判据是不是失效了？').toBeGreaterThan(0)
  })
})

/**
 * 浏览器半体的产物守卫：**绝不把宿主提供的运行时打进包里**。
 *
 * 2026-09-25 真机事故：`probe-control.tsx` 用了 `react-dom` 的 `createPortal`，
 * 而 `tsdown.config.ts` 的 `CLIENT_EXTERNALS` 里没有它 —— rolldown 于是把整份
 * react-dom 内联进来（80 KB → 1 MB），它模块顶层的 `process.env.NODE_ENV` 判断
 * 在浏览器里直接抛 `process is not defined`，插件装载失败、整页报 import error。
 *
 * 判据放在**产物**上而不是源码上：源码里写 import 是正常的，错的是它没被外部化。
 */
describe('浏览器半体产物不内联宿主运行时', () => {
  const clientPath = new URL('../lib/client.js', import.meta.url)
  const bundle = existsSync(clientPath) ? readFileSync(clientPath, 'utf8') : undefined

  /** 宿主在工厂里 `require` 得到的模块：产物的 require 只允许出现这些。 */
  const HOST_PROVIDED = [
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react-dom/client',
    // staticLinked 平台模块，由宿主装载器提供。
    '@deepseek-ai/dsh-client-ui-primitives',
  ]

  it('产物只 require 宿主提供的模块', () => {
    if (bundle === undefined) return
    const required = [...bundle.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
      (match) => match[1] as string,
    )
    // 自检：真的扫到了 require，否则这条断言永不触发。
    expect(required.length, '产物里一个 require 都没有 —— 扫描失效了？').toBeGreaterThan(0)
    const inlined = [...new Set(required)].filter((name) => !HOST_PROVIDED.includes(name))
    expect(inlined, '这些模块被打进了产物；应加进 tsdown.config.ts 的 CLIENT_EXTERNALS').toEqual([])
  })

  it('产物里没有 process 引用（内联 React 运行时的signature）', () => {
    if (bundle === undefined) return
    expect(bundle).not.toMatch(/\bprocess\b/)
    expect(bundle).not.toMatch(/NODE_ENV/)
  })

  it('产物体积在量级上正常（内联运行时会让它涨十倍）', () => {
    if (bundle === undefined) return
    // 实际约 84 KB；阈值给到 256 KB，只为拦住「整份运行时被内联」这一种情况。
    expect(bundle.length, '客户端产物异常膨胀，检查是不是有依赖被内联了').toBeLessThan(262144)
  })
})

/**
 * 插件页的样式纪律。
 *
 * 这一页长在宿主的 Plugins 页里，所以它的字号、间距、圆角、焦点环都应当是**宿主的**，
 * 不是本插件自己的一档。抄错的表现是「看起来像外来的」，而且是和昨天比出来的 ——
 * 所以判据放在源码上，不靠眼睛。
 *
 * 取值真源：宿主 `ui-primitives/lib/settings-form/fields.module.css` 与
 * `SettingsForm.module.css`（label 13/1.5 w500 primary、hint 12/1.5 tertiary、
 * invalid 12/1.5 error；中性边框 0.5px；圆角与焦点环走 token）。
 */
describe('插件页样式跟着宿主走', () => {
  const sheets = ['src/client/workbuddy.module.css', 'src/client/probe-control.module.css']

  it('不写字面色值', () => {
    let checked = 0
    for (const file of sheets) {
      const css = read(file)
      // 先把注释剥掉：说明文字里提到某个 token 名不算使用它。
      const body = css.replace(/\/\*[\s\S]*?\*\//g, '')
      const literals = body.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsl\(/g) ?? []
      expect(literals, `${file} 里有字面色值`).toEqual([])
      checked += body.length
    }
    // 自检：真的读到了样式内容。
    expect(checked).toBeGreaterThan(2000)
  })

  it('字号只用宿主那几档', () => {
    // 官方 settings-subagent 的列表行同时用到 13（名字）、12（说明）、11（元数据），
    // 原语自己的 SegmentedTabs 用 14 —— 这四档就是这页允许的全部。
    const OFFICIAL = new Set(['11px', '12px', '13px', '14px'])
    for (const file of sheets) {
      const body = read(file).replace(/\/\*[\s\S]*?\*\//g, '')
      const sizes = [...body.matchAll(/font-size:\s*([^;]+);/g)].map((m) => (m[1] ?? '').trim())
      expect(sizes.length, `${file} 里一个 font-size 都没有 —— 扫描失效了？`).toBeGreaterThan(0)
      const offScale = [...new Set(sizes)].filter((size) => !OFFICIAL.has(size))
      expect(offScale, `${file} 出现了宿主没有的字号档`).toEqual([])
    }
  })

  it('line-height 只用 1.5 / 1.6（宿主那两档）', () => {
    for (const file of sheets) {
      const body = read(file).replace(/\/\*[\s\S]*?\*\//g, '')
      const heights = [...body.matchAll(/line-height:\s*([^;]+);/g)].map((m) => (m[1] ?? '').trim())
      const offScale = [...new Set(heights)].filter((value) => value !== '1.5' && value !== '1.6')
      expect(offScale, `${file} 出现了非宿主档的 line-height`).toEqual([])
    }
  })

  it('中性描边一律 0.5px（状态色才允许 1px）', () => {
    for (const file of sheets) {
      const body = read(file).replace(/\/\*[\s\S]*?\*\//g, '')
      for (const [, width, rest] of body.matchAll(
        /border(?:-top|-bottom)?:\s*([\d.]+)px\s+solid\s+([^;]+);/g,
      )) {
        const ink = rest ?? ''
        // 1px 只留给状态色；其余中性描边一律 0.5px。
        if (width === '1px') expect(ink, `${file} 的中性描边写成了 1px`).toMatch(/state-/)
        else expect(width, `${file} 的描边宽度不在 {0.5px, 1px} 里`).toBe('0.5')
      }
    }
  })

  it('焦点环走宿主的 --dsw-focus-ring-* token，而不是自己写一圈', () => {
    const rings = ['src/client/probe-control.module.css']
    let found = 0
    for (const file of rings) {
      const body = read(file).replace(/\/\*[\s\S]*?\*\//g, '')
      for (const [, rule] of body.matchAll(/:focus-visible[^{]*\{([^}]*)\}/g)) {
        found += 1
        expect(rule, `${file} 的焦点环没走宿主 token`).toContain('--dsw-focus-ring-width')
        expect(rule, `${file} 的焦点环还带了字面色`).not.toMatch(/#[0-9a-fA-F]{3,8}/)
      }
    }
    expect(found, '没扫到任何 :focus-visible 规则 —— 扫描失效了？').toBeGreaterThan(0)
  })

  it('机器产出的数字一律等宽（tabular-nums）', () => {
    // 时间与计数是**动态**值：每次读取都可能变。不等宽的话，数字一刷新整行就跟着
    // 抖一下，读者会以为别处也变了。`.figure` 是这类值的唯一落点 ——
    // 它由 `src/client/field.tsx` 的 `Part` 渲染，卡片上每个值都走它（名字有数字
    // 也一样，所以不必再分出一档「只给数字」的规则）。
    const css = read('src/client/workbuddy.module.css').replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = /\.figure\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule, '没扫到 .figure —— 改名了？').not.toBe('')
    expect(rule, '.figure 没声明等宽数字，动态值刷新时会抖动').toContain(
      'font-variant-numeric: tabular-nums',
    )
  })

  it('同一行的灰字与取值只有一档字号', () => {
    /*
     * 灰字曾经是宿主的 hint 档（12px）、取值是 label 档（13px），两档抄自
     * `fields.module.css`。字号不同就**必然**对不齐：flex 的 `align-items` 对齐的是
     * 盒子，而盒高不同的两个盒子既不共基线、也不共中心，于是灰字比它旁边那个值高
     * 一点点，再被浏览器的亚像素定位放大成肉眼可见的台阶（2026-10-03 维护者从截图
     * 报出「粗体的字和灰色的字好像不在一个水平线上」）。
     *
     * 维护者的规则更简单：**同一个字体，加粗一下就行**。所以字号只写在容器上
     * （`.part`、`.packageLabel`），两个档位类自己不许带字号——一旦带上就会各自漂移，
     * 而「对齐」这件事就没有任何一条规则在保证了。
     */
    const css = read('src/client/workbuddy.module.css').replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = (name: string): string =>
      new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
    const size = (name: string): string | undefined =>
      rule(name)
        .match(/font-size:\s*([^;]+);/)?.[1]
        ?.trim()
    expect(rule('caption'), '没扫到 .caption —— 改名了？').not.toBe('')
    expect(rule('figure'), '没扫到 .figure —— 改名了？').not.toBe('')
    expect(size('caption'), '.caption 带了自己的字号：灰字会与取值漂开').toBeUndefined()
    expect(size('figure'), '.figure 带了自己的字号：取值会与灰字漂开').toBeUndefined()
    // 两个宿主容器必须同档，否则同一张卡上两处的行内字号又不一致。
    expect(size('part'), '没扫到 .part 的字号').toBeDefined()
    expect(size('packageLabel')).toBe(size('part'))
  })

  it('同一行的名字只有一档字号', () => {
    // 宿主的 `Checkbox` 自带 `font-size: 14px`，而本页的名字档是 13px
    // （`settings-subagent` 的列表行：13 名字 / 12 说明 / 11 元数据）。
    // 模型行的名字有两条渲染路径 —— 有显隐状态时走 `Checkbox` 的 label，
    // 没有时走 `.name` —— 两条必须同档，否则同一个模型会因为
    // 「这一行有没有勾选框」而换个字号。
    const css = read('src/client/workbuddy.module.css').replace(/\/\*[\s\S]*?\*\//g, '')
    const size = (name: string): string | undefined =>
      new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`)
        .exec(css)?.[1]
        ?.match(/font-size:\s*([^;]+);/)?.[1]
        ?.trim()
    expect(size('name'), '没扫到 .name —— 改名了？').toBeDefined()
    expect(size('modelCheck'), '勾选框没有拉回本页字号').toBe(size('name'))
  })
})

describe('客户端接缝', () => {
  it('推理等级控件注在 list 槽上，绝不注 single 槽', () => {
    const source = read('src/client/index.tsx')
    // 自检：源码里必须真的有这条注册。
    expect(source).toContain('slots.register(')
    expect(source).toContain('conversation.input.right')
    // conversation.input.model 是 single 槽，宿主自带 ModelSelect 已占 priority 0；
    // 注上去会抛错并顶掉宿主的模型选择器（2026-09-25 的缺陷）。
    expect(source).not.toContain("'conversation.input.model'")
  })

  it('配置页注册在 plugins.bundle.config，key 取包名', () => {
    const source = read('src/client/index.tsx')
    expect(source).toContain('plugins.bundle.config')
    expect(source).toContain(`const BUNDLE_NAME = '${pkg.name}'`)
  })

  /**
   * 设置命名空间是 **loader 条目 id**，不是包名 —— 两个不同的东西。
   *
   * 宿主 `dsh-settings/lib/index.js:432,443` 把每个插件的 `Config` 文档发布成
   * `ns: entry.options.id`。而 `ctx.configForms.get()` 收的就是命名空间。
   * 传包名的表现是**静默**的：那个命名空间从没被服务过，`whileServed` 永不触发，
   * 配置页根本不出现 —— 没有报错、没有日志。
   *
   * 2026-09-25 真机就是这条：条目 id 是 `llm-workbuddy`，客户端却问包名。
   * 所以这里把两个 id 各自的出处都钉住：包名 → 槽 key，条目 id → 命名空间。
   */
  it('configForms.get() 的实参取自 cordis.patch.yml 的 insert id，不是包名', () => {
    const source = read('src/client/index.tsx')
    const patch = read('cordis.patch.yml')
    const entryId = /-\s*id:\s*(\S+)/.exec(patch)?.[1]
    // 自检：patch 里必须真的能读出一个条目 id。
    expect(entryId, 'cordis.patch.yml 里读不出 insert id').toBeTruthy()
    expect(source).toContain(`export const ENTRY_ID = '${entryId as string}'`)
    expect(source).toContain('ctx.configForms.get(ENTRY_ID)')
    expect(source).toContain('whileServed([ENTRY_ID]')
    // 反过来：不许再把包名喂给命名空间那一侧。
    expect(source).not.toContain('configForms.get(BUNDLE_NAME)')
    expect(source).not.toContain('whileServed([BUNDLE_NAME]')
  })

  it('源码里不再出现宿主已删的旧接缝 conversation.input.right 之外的历史槽名', () => {
    const source = read('src/client/index.tsx')
    expect(source).not.toMatch(/conversation\.input\.(left|model|dock|activity|attachments)'/)
  })
})

describe('发布流程', () => {
  const workflows = existsSync(new URL('../.github/workflows', import.meta.url))
    ? readdirSync(new URL('../.github/workflows', import.meta.url))
    : []

  it('release.yml 里不得出现改写版本的调用（bump 是发布前的独立一步）', () => {
    if (!workflows.includes('release.yml')) return
    const release = read('.github/workflows/release.yml')
    expect(release).not.toMatch(/npm version (patch|minor|major)/)
  })

  it('上面那条检测器有牙齿（反向控制）', () => {
    const detector = (text: string) => /npm version (patch|minor|major)/.test(text)
    expect(detector('run: npm version patch --no-git-tag-version')).toBe(true)
    expect(detector('run: npm publish')).toBe(false)
  })

  /**
   * 发布链的**行为底线**（跨仓一致）：手动与 tag 两个入口、正文读 Drafter 草稿、发完删草稿、OIDC 发包。
   *
   * 为什么要钉成断言而不是留在散文里：这四条漏掉时**都不报错** ——
   * tag 触发那条判据没带事件守卫，红的是每一次 tag 发布而不是某次改动；
   * 草稿没删，下一版读到的是上一批正文，而草稿看上去「有内容」；
   * 草稿读不到而没发 warning，则「发版成功但正文走了回落」与「一切正常」长得一模一样。
   * 散文留不住这种，判据留得住。
   */
  it('四条行为底线都在（入口 / 读草稿 / 删草稿 / OIDC）', () => {
    if (!workflows.includes('release.yml')) return
    const release = read('.github/workflows/release.yml')

    // ① 两个入口：手动 dispatch 与 tag 推送。
    expect(release, '没有手动触发入口').toMatch(/workflow_dispatch:/)
    expect(release, '没有 tag 触发入口').toMatch(/tags:\s*\n\s*-\s*'v\[0-9\]\*'/)

    // ② 正文读草稿，且**读不到时必须发 warning**（区分「读不到」与「读到但为空」）。
    expect(release, '没有读 Release Drafter 草稿的步骤').toContain('gh release view next')
    expect(release, '草稿读不到时没有 warning —— 那就成了静默回落').toMatch(
      /warning::读不到 Release Drafter 草稿/,
    )
    expect(release, '正文没有走草稿那一路').toContain('--notes-file')

    // ③ 发完删草稿。
    expect(release, '没有删除草稿的步骤').toContain('gh release delete')
    // 删的**必须**只删草稿：--cleanup-tag 默认连带删 tag，这里显式关掉。
    expect(release, '删草稿时没有关掉 --cleanup-tag，会连带删掉 tag').toContain(
      '--cleanup-tag=false',
    )

    // ④ OIDC：全程不传 token。
    expect(release, '没有 id-token: write，OIDC 换不出凭据').toMatch(/id-token:\s*write/)
    expect(release, '出现了 token 传递，底线要求全程不传 token').not.toMatch(
      /NODE_AUTH_TOKEN|NPM_TOKEN/,
    )
  })

  it('tag 触发的两道闸都在（缺一条时每次 tag 发布都红，且红的原因不明显）', () => {
    if (!workflows.includes('release.yml')) return
    const release = read('.github/workflows/release.yml')

    // ① 守卫的基线要**排除正在发的那个 tag**。少了它，tag 触发时 `describe` 解析出它自己，
    //    `<tag>..HEAD` 恒空，一次完全正常的发布被判成「没有可发布的内容」（2026-09-26 实踩）。
    expect(release, '守卫基线没有排除正在发的 tag').toMatch(
      /--exclude=\$\{\{\s*github\.ref_name\s*\}\}/,
    )

    // ② 「只接受 main」那道判定要带事件守卫。少了它，tag 触发时 github.ref 是 refs/tags/...，
    //    每一次 tag 发布都红。
    expect(release, '「只接受 main」的判定没有事件守卫').toMatch(
      /github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*github\.ref\s*!=\s*'refs\/heads\/main'/,
    )
  })

  it('上面那两条判据有牙齿（拿缺了这两样的写法比对，必须不满足）', () => {
    // 反向控制一：没有 --exclude 的守卫。
    const noExclude =
      '      - name: Guard against release noise\n' +
      '        run: |\n' +
      "          base=$(git describe --tags --abbrev=0 --match 'v[0-9]*')\n"
    expect(noExclude).not.toMatch(/--exclude=\$\{\{\s*github\.ref_name\s*\}\}/)

    // 反向控制二：没有事件守卫的 main 判定。
    const noEventGuard = "        if: github.ref != 'refs/heads/main'\n"
    expect(noEventGuard).not.toMatch(
      /github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*github\.ref\s*!=\s*'refs\/heads\/main'/,
    )
    // 而真文件里的那行必须满足 —— 判据不是「永远为真」。
    const release = read('.github/workflows/release.yml')
    expect(release).toMatch(
      /github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*github\.ref\s*!=\s*'refs\/heads\/main'/,
    )
  })
})

/**
 * 这条提示只有**警告**，不阻断：活文档里复述了宿主下限那个值时，若不与出处同段、也没标为历史，
 * 就在测试输出里打一条 warning，交给人判一眼。**警告不等于放行**。
 *
 * 为什么是警告而不是红线：判据是能机械判的"形状"，规则管的是"这句话想说什么"，两者不可能完全对齐。
 * 收紧到下面两个真信号后，当前语料上误报为 0，但仍会**漏报**（写旧 / 写错的宿主版本），
 * 所以它只配提示复核，不配替人下结论。
 *
 * 判据是两个真信号，**不用语气词**（只支持 / 要求 / 需要 / only 那类词是普通词，会随机误报：
 * 2026-10-01 那次误报就是「版本 `0.1.0`」与「不**需要**」同段触发的）：
 * 1. **真值**：`package.json` 的 `engines.dsh` 下限（去掉预发布段），不是 `0.1.\d+` 这种形状 ——
 *    形状分不清宿主版本与插件自己的版本号，而且宿主抬线后会**静默失效**。
 * 2. **主语**：同一行点名宿主（`DSH` / `宿主` / `Harness`）。小写 `dsh` 是命令与包名，不算。
 *
 * 出处（`package.json` / `engines`）与历史陈述都按**段**判：散文折行时出处会落到下一行；
 * 标历史用仓库的陈词（先例 / 当时 / 历史 / 旧线 / `X 起`），别让豁免词表无边际地长。
 */
interface HostVersionMention {
  value: string
  line: string
}

/** 宿主下限：唯一真源是 `package.json`，所以这里读它，不写死。并集（`||`）取第一族，运算符 `>=` / `^` / `~` 一律剥掉。 */
const HOST_FLOOR =
  String(pkg.engines.dsh ?? '')
    .split('||')[0]
    ?.trim()
    .replace(/^(?:>=|\^|~)\s*/, '') ?? ''
/** 文档通常只写下限的数值段（`0.1.7`），清单里却带预发布段（`0.1.7-rc.2`）。 */
const HOST_VERSION = new RegExp(`${HOST_FLOOR.replace(/-.*$/, '').replace(/\./g, '\\.')}(?![\\d.])`)
/** 点名宿主。大小写敏感：小写 `dsh` 出现在命令与包名里，不是主语。 */
const HOST_SUBJECT = /DSH|宿主|Harness|deepseek-harness/
/** 明确标为历史。 */
const MARKED_HISTORICAL = /先例|当时|历史|旧线|重做|archive|\d+\.\d+\.\d+\s*起/
/** 同段里点出了出处。 */
const HAS_SOURCE = /package\.json|engines/

/** 这一段里有哪一行复述了宿主下限却没给交代；没有就返回 undefined。 */
function needsSource(paragraph: string): HostVersionMention | undefined {
  if (HAS_SOURCE.test(paragraph)) return undefined
  if (MARKED_HISTORICAL.test(paragraph)) return undefined
  for (const line of paragraph.split(/\r?\n/)) {
    const value = HOST_VERSION.exec(line)?.[0]
    if (value === undefined) continue
    if (!HOST_SUBJECT.test(line)) continue
    return { value, line: line.trim() }
  }
  return undefined
}

/**
 * 这段里有没有「点名宿主 + 下限值」这句话 —— 不管它有没有交代。
 * 自检用它：语料里必须真的存在这类话，否则上面那条警告是空转。
 */
function mentionsHostVersion(paragraph: string): boolean {
  return paragraph.split(/\r?\n/).some((line) => HOST_VERSION.test(line) && HOST_SUBJECT.test(line))
}

describe('文档不抄实测值', () => {
  /** 活文档：随代码走，所以里面不许抄会漂的宿主版本号。 */
  const LIVE_DOCS = [
    'README.md',
    'README_en.md',
    'AGENTS.md',
    'docs/ARCHITECTURE.md',
    'docs/PUBLISHING.md',
    'docs/README.md',
  ]

  it('扫描器真的读到了活文档（否则下面几条是假绿）', () => {
    expect(LIVE_DOCS.length).toBeGreaterThan(0)
    for (const doc of LIVE_DOCS)
      expect(existsSync(new URL(`../${doc}`, import.meta.url)), doc).toBe(true)
  })

  /**
   * 只警告，不阻断。打印出来的每一条都请人工判一眼：
   * 补出处（`package.json` / `engines`），还是标为历史（先例 / 当时 / `X 起`）。
   */
  it('活文档里的宿主版本只给提示，不阻断', () => {
    const hints: string[] = []
    for (const doc of LIVE_DOCS) {
      // 按**段**切、按**段**找出处：散文折行时 `package.json` 会落到下一行。
      for (const paragraph of read(doc).split(/\r?\n\s*\r?\n/)) {
        const mention = needsSource(paragraph)
        if (mention === undefined) continue
        hints.push(
          `  ${doc}:「${mention.value}」没同段点出处（package.json / engines），也没标为历史\n    ${mention.line.slice(0, 140)}`,
        )
      }
    }
    if (hints.length > 0) {
      console.warn(
        `\n[活文档宿主版本] ${hints.length} 处要人工判一眼（警告，不阻断）：\n${hints.join('\n')}\n`,
      )
    }
    // 唯一的硬断言：扫描器真的活着 —— 否则这条警告永远不会有人看到（假绿）。
    const inScope = LIVE_DOCS.flatMap((doc) => read(doc).split(/\r?\n\s*\r?\n/)).filter(
      (paragraph) => mentionsHostVersion(paragraph),
    )
    expect(inScope.length, '活文档里读不到任何「宿主 + 下限值」—— 这条提示已空转').toBeGreaterThan(
      0,
    )
  })

  it('上面那条提示的判据有牙齿（反向控制）', () => {
    // 复述宿主下限、不给出处 → 命中（会提示），并报出命中的值。
    expect(needsSource('本仓只支持 DSH 0.1.7 线，不做跨代兼容。')).toMatchObject({
      value: '0.1.7',
    })
    // 同段补上出处、或标为历史 → 不提示。
    expect(
      needsSource('本仓只支持 DSH 0.1.7 线；下限见 package.json 的 engines.dsh。'),
    ).toBeUndefined()
    expect(needsSource('先例（2026-09-25）：实装宿主 0.1.7-rc.2 里两者都存在。')).toBeUndefined()
    // 插件自己的版本号不在管辖内：判据是清单里的真值，不是 `0.1.\d+` 的形状。
    // 下面两条就是 2026-10-01 那次误报的形状（旧版本号 + 普通词「需要」）。
    expect(needsSource('版本 `0.1.0`；尚未发布到 npm。')).toBeUndefined()
    expect(needsSource('- [x] 首次发布 `0.1.0` 已完成\n- [ ] 这里不再需要走那条路')).toBeUndefined()
    // 值对但没点名宿主 → 也不提示：那可能只是在提一个版本号。
    expect(needsSource('插件 `0.1.7` 版改了接缝。')).toBeUndefined()
    // 真值来自清单，不是写死的形状。
    expect(HOST_VERSION.test('宿主 0.1.7-rc.2')).toBe(true)
    expect(HOST_VERSION.test('宿主 0.1.0')).toBe(false)
    // 自检用的谓词必须看得到「宿主 + 下限值」，哪怕那段已经带了出处。
    expect(mentionsHostVersion('本仓只支持 DSH 0.1.7；下限见 package.json。')).toBe(true)
  })
})

/**
 * 红线 6：门面图**不住在包里**，README 用**相对路径**引用它们。
 *
 * 两件独立的事合成一条判据（缺一面就是另一种坏法）：
 *
 * **① 体积**：市场每小时从 npm 抓四个插件包，只为读包里的 `locale/` 与图标。只给 README 看的
 * 门面图若跟着包发出去，安装者就要为它们付流量，市场那一轮构建也得把它们下下来。
 * 本仓 `assets/` 本来就不在 `files` 里，这一面是**断言现状** —— 防止哪天有人把 `assets`
 * 加进 `files`（一旦加上，七张截图会静默进包，没有别的守卫会发现）。
 *
 * **② 写法**：README 一律用**相对路径**。npm 会把 README 的相对图片路径解析到仓库的 raw 文件
 * （维护者 2026-10-20 在 npm 页面上实地确认；同一事实在 `dsh-zhihu-search/assets/README.md`
 * 早有记录），所以「不进包 + 相对引用」成立且统一 —— 四个插件仓都这么写。
 * 绝对 URL 是**例外形态**：它把 owner/repo/分支硬编码进散文，仓改名或转移就静默破图，
 * 旧版本页面还会跟着 `main` 漂。只有「图确实在别的仓」时才该用，本仓没有这种图。
 *
 * 四面：
 *   1. 两份门面里的图都是**相对路径**，且没有 `raw.githubusercontent.com` 形态；
 *   2. 相对路径指向的文件**在仓里存在**（写错或删了文件没有任何报错，图静默不显示）；
 *   3. `assets/` 下的门面图**不被 `files` 覆盖**；
 *   4. 反向面：**代码有没有按包内路径引用 `assets/`** —— 本仓没有运行期资产，见该面的说明。
 */
describe('红线 6：门面图不进包，README 用相对路径引用', () => {
  /** 门面双件。 */
  const FACADE = ['README.md', 'README_en.md']

  /** 只有 `assets/` 下的图是「只给 README 看」的；`icon.svg` 随包，不在本判据的对象里。 */
  const README_ONLY = /^assets\//

  /** 读出某份门面里所有 `<img src>` 及其行号。 */
  function imageRefs(file: string): { src: string; line: number }[] {
    const out: { src: string; line: number }[] = []
    read(file)
      .split('\n')
      .forEach((line, index) => {
        for (const m of line.matchAll(/<img\s+src="([^"]+)"/g)) {
          out.push({ src: m[1] ?? '', line: index + 1 })
        }
      })
    return out
  }

  /** 某条 `files` 正向条目能不能覆盖目标（只认本仓用到的形态：裸目录、显式路径、`**`）。 */
  function covers(entry: string, target: string): boolean {
    if (entry.startsWith('!')) return false
    const clean = entry.replace(/^\.\//, '').replace(/\/+$/, '')
    if (clean === '') return false
    if (clean === target) return true
    if (clean.endsWith('/**')) return target.startsWith(clean.slice(0, -3) + '/')
    return target.startsWith(clean + '/')
  }

  /** 某条取反条目能不能命中目标（同上，只认本仓用到的形态）。 */
  function negatedEntry(entry: string, target: string): boolean {
    const pattern = entry.slice(1).replace(/^\.\//, '')
    if (pattern === '') return false
    if (pattern.endsWith('/**')) return target.startsWith(pattern.slice(0, -3) + '/')
    const clean = pattern.replace(/\/+$/, '')
    return target === clean || target.startsWith(clean + '/')
  }

  /** 这个路径会不会真的进包：被某条正向条目覆盖、且没被任何取反条目命中。 */
  function shipped(target: string): boolean {
    return (
      pkg.files.filter((e) => !e.startsWith('!')).some((e) => covers(e, target)) &&
      !pkg.files.filter((e) => e.startsWith('!')).some((e) => negatedEntry(e, target))
    )
  }

  /**
   * 判据本体：给定一份门面正文与一个「是否进包」的判定，返回违规描述。
   *
   * 抽成函数是为了**否证能真的跑起来**（把变异后的文本喂回来），而不是只断言「现在通过」。
   *
   * @param readme - 门面文件名，只用于报错文案。
   * @param body - 门面正文。
   * @param isShipped - 路径是否进包；注入是为了变异时能换掉判定而不动磁盘。
   * @returns 违规描述；空数组表示通过。
   */
  function facadeImageOffenders(
    readme: string,
    body: string,
    isShipped: (target: string) => boolean,
  ): string[] {
    const offenders: string[] = []
    body.split('\n').forEach((line, index) => {
      for (const m of line.matchAll(/<img\s+src="([^"]+)"/g)) {
        const src = m[1] ?? ''
        const where = `${readme}:${index + 1}`
        // 面 1：绝对 raw 形态一律不算通过，哪怕目标当前可取（见上方「② 写法」）。
        if (/raw\.githubusercontent\.com/.test(src)) {
          offenders.push(`${where} 用绝对 raw URL 引用图（家族统一用相对路径）：${src}`)
          continue
        }
        // 徽章类外链不在本判据范围内。
        if (/^https?:\/\//.test(src)) continue
        // 面 2：相对引用必须真的指到仓里的文件。
        if (!existsSync(new URL(`../${src}`, import.meta.url))) {
          offenders.push(`${where} 相对引用的文件在仓里不存在：${src}`)
        }
        // 面 3：只给 README 看的图不许进包。
        if (README_ONLY.test(src) && isShipped(src)) {
          offenders.push(`${where} 门面图跟着包发出去了（应留在仓里）：${src}`)
        }
      }
    })
    return offenders
  }

  it('两份门面的图都是相对路径，且没有绝对 raw 形态', () => {
    for (const readme of FACADE) {
      const offenders = facadeImageOffenders(readme, read(readme), shipped)
      expect(offenders, offenders.join('\n')).toEqual([])
    }
  })

  it('扫描器确实看到了图（否则上面那条是假绿）', () => {
    const total = FACADE.reduce((n, file) => n + imageRefs(file).length, 0)
    expect(total, '两份门面里一张 <img> 都没扫到 —— 扫描器坏了').toBeGreaterThan(4)
    const readmeOnly = FACADE.flatMap(imageRefs).filter((ref) => README_ONLY.test(ref.src))
    expect(readmeOnly.length, '`assets/` 门面图一张都没扫到 —— 正则或路径规则坏了').toBeGreaterThan(
      4,
    )
  })

  it('这些门面图确实不在包里（`files` 里没有 `assets`）', () => {
    const targets = FACADE.flatMap(imageRefs)
      .map((ref) => ref.src)
      .filter((src) => README_ONLY.test(src))
    expect(targets.length, '一张 `assets/` 门面图都没取到').toBeGreaterThan(4)
    // 这一面在本仓是**断言现状**：`files` 本来就不含 `assets`。
    // 若哪天有人把它加进去，这条与上面那条会一起红 —— 那正是要的效果。
    for (const target of targets) expect(shipped(target), `${target} 竟然进包了`).toBe(false)
  })

  it('面 4 不适用：本仓 `assets/` 里没有运行期资产（代码不按包内路径找它）', () => {
    // `dsh-plugin-debugging` 的 `assets/` 含 `launcher.js` / `*.vbs` / `stop-window.ps1` 等
    // 运行期资产，那一面在那里断言「必须仍在包里」。**本仓没有这类文件**（`assets/` 全是
    // 为 README 与截图说明服务的图），所以这一面没有对象 —— 但**不静默删掉**：
    // 这里反过来断言「代码里一条对 `assets/` 的包内路径引用都没有」。
    // 将来真加了运行期资产，这条会红，来把它改写成「这些路径必须仍在包里」的那一面。
    const codeRefs: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(new URL(`../${dir === '' ? '.' : dir}`, import.meta.url), {
        withFileTypes: true,
      })) {
        const path = dir === '' ? entry.name : `${dir}/${entry.name}`
        if (entry.isDirectory()) {
          if (['node_modules', 'lib', '.git', 'docs', 'assets', 'tests'].includes(entry.name)) {
            continue
          }
          walk(path)
          continue
        }
        if (!/\.(ts|tsx|mts|js|mjs|cjs)$/.test(entry.name)) continue
        if (read(path).includes('assets/')) codeRefs.push(path)
      }
    }
    walk('src')
    expect(
      codeRefs,
      '代码开始按包内路径引用 assets/ 了 —— 这一面不再是「不适用」，请改写成「必须仍在包里」',
    ).toEqual([])
  })

  it('判据可被否证：改成绝对 URL / 塞进 files / 指到不存在的文件，都会红', () => {
    const body = read('README.md')
    expect(body, 'README.md 里没有相对引用的门面图 —— 变异的前提没了').toContain(
      'src="assets/model-picker.png"',
    )

    // 变异 1：一张图改成绝对 raw URL。
    const absolute = body.replace(
      'src="assets/model-picker.png"',
      'src="https://raw.githubusercontent.com/dsh-plugin-lab/dsh-workbuddy-bridge/main/assets/model-picker.png"',
    )
    expect(absolute, '变异没落地').not.toBe(body)
    expect(facadeImageOffenders('README.md', absolute, shipped).length).toBeGreaterThan(0)

    // 变异 2：把 `assets` 塞进 files —— 门面图会被算成随包。
    expect(
      facadeImageOffenders('README.md', body, (target) => target.startsWith('assets/')).length,
    ).toBeGreaterThan(0)

    // 变异 3：指到一个不存在的文件。
    const missing = body.replace('src="assets/model-picker.png"', 'src="assets/not-there.png"')
    expect(missing, '变异没落地').not.toBe(body)
    expect(facadeImageOffenders('README.md', missing, shipped).length).toBeGreaterThan(0)
  })
})
