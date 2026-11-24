/**
 * 把四份原插件的 client bundle 合成 dsh-yunoseek/client.js。
 *
 * 每份原包都是「顶层若干自执行代码 + 一次 window.__ModuleLoader__.load({id, factory})」：
 *   - 顶层部分（比如桌宠的 Cubism Core + esbuild IIFE）原样保留在最前面；
 *   - factory 的函数体单独抠出来，包成具名函数，由整合入口统一启动。
 *
 * 剥离用带状态的花括号扫描（认字符串 / 模板 / 注释），不用正则硬切，
 * 因为 theme 的 CSS 里有成堆的 `}`。
 *
 * 用法：node src/build.mjs [--check]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** 包名同时是 Loader 里的模块 id，必须一致。 */
const PACKAGE_ID = 'dsh-yunoseek'

/** 顺序即启动顺序：主题先立骨架，其余往上叠。
    源优先取包内 src/parts/（那些是原插件 client.js 的原样备份），
    找不到才回退到旧的工作目录 —— 旧目录删掉之后照样能重建。 */
const SOURCES = [
  { key: 'theme', label: '主题', file: 'src/parts/theme.client.js', original: 'D:/gzq1/dsh-yuno-theme/client.js', required: true },
  { key: 'avatar', label: '头像', file: 'src/parts/avatar.client.js', original: 'D:/gzq1/dsh-yuno-avatar/client.js', required: true },
  { key: 'pet', label: '桌宠', file: 'src/parts/pet.client.js', original: 'D:/gzq1/dsh-yuno-pet/client.js', required: true },
  { key: 'tts', label: '语音', file: 'src/parts/tts.client.js', original: 'D:/gzq1/dsh-yuno-tts/client.js', required: true },
]

/** 按「包内备份 → 原目录」的顺序找源文件。 */
function pickSource(s) {
  const local = join(ROOT, s.file)
  if (existsSync(local)) return local
  if (s.original && existsSync(s.original)) return s.original
  return null
}

/** 扫过一个 JS 字符串字面量，返回结束位置（指向收尾引号）。 */
function scanString(src, i) {
  const quote = src[i]
  i++
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === quote) return i
    i++
  }
  throw new Error('字符串没有收尾，位置 ' + i)
}

/** 在模板字符串里前进；遇到 ${ 就跳到配对的 } 之后。 */
function scanTemplate(src, i) {
  i++ // skip `
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '`') return i
    if (ch === '$' && src[i + 1] === '{') {
      i = scanCode(src, i + 2, true)
      continue
    }
    i++
  }
  throw new Error('模板字符串没有收尾，位置 ' + i)
}

/**
 * 从 i 开始扫代码，返回配对 `}` 之后的位置（mode=code）或 `}` 的位置本身。
 * depth 记录花括号层级。
 */
function scanCode(src, i, insideTemplate) {
  let depth = 0
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? src.length : nl + 1
      continue
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end === -1) throw new Error('块注释没有收尾，位置 ' + i)
      i = end + 2
      continue
    }
    if (ch === '"' || ch === "'") { i = scanString(src, i) + 1; continue }
    if (ch === '`') { i = scanTemplate(src, i) + 1; continue }
    if (ch === '{') { depth++; i++; continue }
    if (ch === '}') {
      if (depth === 0) {
        if (insideTemplate) return i
        return i + 1
      }
      depth--
      i++
      continue
    }
    i++
  }
  throw new Error('花括号没闭合，位置 ' + i)
}

/** 找到 factory 声明的函数体，返回 { bodyStart, bodyEnd }（不含花括号本身）。 */
function findFactoryBody(src, label) {
  const patterns = [
    /factory\s*\(\s*require\s*\)\s*\{/g,          // factory(require) {
    /factory\s*:\s*\(\s*require\s*\)\s*=>\s*\{/g, // factory: (require) => {
    /factory\s*:\s*require\s*=>\s*\{/g,           // factory: require => {
  ]
  let best = -1
  let braceAt = -1
  for (const re of patterns) {
    re.lastIndex = 0
    const m = re.exec(src)
    if (m && (best === -1 || m.index < best)) {
      best = m.index
      braceAt = m.index + m[0].length - 1
    }
  }
  if (braceAt === -1) throw new Error(`[${label}] 找不到 factory 声明`)
  const bodyStart = braceAt + 1
  const bodyEnd = scanCode(src, bodyStart, false)
  return { bodyStart, bodyEnd: bodyEnd - 1, factoryAt: braceAt }
}

/** 拆一份源：顶层的自执行前缀 + factory 体。 */
function splitBundle(file, label) {
  const src = readFileSync(file, 'utf8')
  const { bodyStart, bodyEnd, factoryAt } = findFactoryBody(src, label)
  const loadAt = src.indexOf('window.__ModuleLoader__.load(')
  if (loadAt === -1) throw new Error(`[${label}] 找不到 __ModuleLoader__.load(`)
  if (loadAt > factoryAt) throw new Error(`[${label}] load 调用在 factory 之后，结构不认识`)

  const prefix = src.slice(0, loadAt).trim()
  const body = src.slice(bodyStart, bodyEnd)
  const tail = src.slice(bodyEnd + 1).trim()

  // 尾巴只该剩下 `},\n})` 这类收尾，多了说明切错了。
  if (tail.replace(/[\s,;{}()]/g, '').length > 0) {
    throw new Error(`[${label}] factory 之后还有代码，结构不认识：${tail.slice(0, 80)}`)
  }
  if (!/return\s*\{/.test(body)) throw new Error(`[${label}] factory 体里没有 return {`)
  if (!/inject\s*:/.test(body)) throw new Error(`[${label}] factory 体里没有 inject`)
  return { prefix, body, bytes: src.length }
}

function build() {
  const parts = []
  const chunks = []
  for (const s of SOURCES) {
    const src = pickSource(s)
    if (!src) {
      if (s.required) throw new Error(`缺源文件：${s.file}（原目录也没有）`)
      console.warn(`跳过 ${s.label}：${s.file} 不存在`)
      continue
    }
    const split = splitBundle(src, s.label)
    parts.push(s)
    chunks.push({ ...s, ...split })
    console.log(`  ${s.label.padEnd(4)} ${String(split.bytes).padStart(8)} B  ← ${src.replace(ROOT + '\\', '').replace('D://', '')}`)
  }

  const banner = `/*!
 * ${PACKAGE_ID} — 千石由乃整合包 · 浏览器半端
 * 由 theme / avatar / pet / tts 四份 client bundle 合成，入口 id 必须等于包名。
 * 生成物：改任何一份源之后重跑 src/build.mjs，别手改这个文件。
 */
`
  /* 顶层前缀：桌宠的 Cubism Core + esbuild IIFE 必须留在外面（只执行一次）。 */
  const prefixBlock = chunks
    .filter((c) => c.prefix)
    .map((c) => `/* ---- ${c.label} 前缀 ---- */\n${c.prefix}\n`)
    .join('\n')

  const factoryBlock = chunks
    .map((c) => `    /* ---- ${c.key}（${c.label}） ---- */\n    ${c.key}: (require) => {${c.body}\n    },`)
    .join('\n\n')

  const entry = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(PACKAGE_ID)},
  factory(require) {
    const ORDER = ${JSON.stringify(chunks.map((c) => c.key))}

    /* 四份 factory 体放在函数里定义：顶层不留 const/let，
       bundle 万一被重复执行（HMR / 重新组合），也不会撞「重复声明」。 */
    const __factories = {
${factoryBlock}
    }

    const mods = []
    for (const key of ORDER) {
      try {
        mods.push([key, __factories[key](require)])
      } catch (err) {
        console.error('[yuno-kit] ' + key + ' 初始化失败', err)
      }
    }

    /* 各子插件声明的服务依赖取并集；主开关挨个 apply，坏一个不拖垮其他的。 */
    const inject = [...new Set(mods.flatMap(([, m]) => (m && m.inject) || []))]
    const apply = (ctx) => {
      for (const [key, m] of mods) {
        if (!m || typeof m.apply !== 'function') {
          console.warn('[yuno-kit] ' + key + ' 没有 apply，跳过')
          continue
        }
        try {
          m.apply(ctx)
        } catch (err) {
          console.error('[yuno-kit] ' + key + ' 挂载失败', err)
        }
      }
    }
    return { inject, apply }
  },
})
`

  let out = `${banner}${prefixBlock}
${entry}`

  /* 包内字体内联：assets/fonts 里的 woff2 → base64 塞进 @font-face 的占位符。
     这样装了这个包就自带字体，不依赖系统里装没装。 */
  const fontPath = join(ROOT, 'assets', 'fonts', 'AlimamaShuHeiTi-Bold.woff2')
  if (existsSync(fontPath)) {
    const b64 = readFileSync(fontPath).toString('base64')
    out = out.split('__YUNO_FONT_B64__').join(b64)
  } else {
    console.warn('缺 assets/fonts/AlimamaShuHeiTi-Bold.woff2，字体占位符未替换（会回退到系统字体）')
    out = out.split('__YUNO_FONT_B64__').join('')
  }

  const target = join(ROOT, 'client.js')
  writeFileSync(target, out, 'utf8')
  console.log(`\nclient.js 写好了：${(out.length / 1024).toFixed(0)} KB（${chunks.length} 段）`)
}

build()
