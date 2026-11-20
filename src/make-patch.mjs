/**
 * 把 yuno-mode 的 patch 拿过来，并把 dsh-yunoseek 本体插到同一个 insert 块的最前面。
 * 用法：node src/make-patch.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/* 优先用包内备份，旧的工作目录只是回退 —— 那些目录删掉之后照样能重建 */
const SRC_LOCAL = join(HERE, 'parts', 'yuno-mode.patch.yml')
const SRC = existsSync(SRC_LOCAL) ? SRC_LOCAL : 'D:/gzq1/dsh-yuno-mode/cordis.patch.yml'
const OUT = join(HERE, '..', 'cordis.patch.yml')

const src = readFileSync(SRC, 'utf8')
const lines = src.split(/\r?\n/)

/* 丢掉源文件顶部的注释和空行，找到 `- insert:` 那一行 */
let start = 0
while (start < lines.length && (lines[start].startsWith('#') || lines[start].trim() === '')) start++
if (lines[start].trim() !== '- insert:') throw new Error(`源文件第 ${start + 1} 行不是 - insert:，结构变了`)

/* insert 项 -> 它们都在 4 空格缩进下 */
const items = lines.slice(start + 1)
const firstItem = items.findIndex((l) => l.startsWith('    - id:'))
if (firstItem === -1) throw new Error('找不到 insert 的条目')

const header = `# ============================================================================
# dsh-yunoseek —— 整合包的挂载声明
# 一个包挂两部分：
#   1. yuno-kit     本体：主题 / 头像 / 桌宠 / 语音（宿主侧 index.js + 浏览器 client.js）
#   2. preset-yuno  Agent 预设「yuno」：工具集与 standard 一致，只换人设
#
# 装法（装到哪都行，别塞进 DSH 自己的 node_modules）：
#   dsh plugin --profile <profile> add link:<这个目录的绝对路径>
# 或者在该 profile 的 package.json 里加 "dsh-yunoseek": "link:<路径>"。
# ============================================================================

- insert:
    - id: yuno-kit
      name: dsh-yunoseek
`

const out = header + items.slice(firstItem).join('\n').replace(/\s+$/, '') + '\n'
writeFileSync(OUT, out, 'utf8')
console.log('cordis.patch.yml 写好了：', out.length, 'chars，条目：', (out.match(/^    - id:/gm) || []).length)