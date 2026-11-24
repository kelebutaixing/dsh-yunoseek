/**
 * 从 app.asar 里按路径直读文件（不解包整个 asar）。
 *
 * asar 结构：16 字节头（4+4+4+4）之后是 pickle 格式的 JSON 目录表，
 * 表里每条 { offset, size } 指向 data 区。这里只需要「列路径 + 读指定文件」。
 *
 * 用法：
 *   node src/asar.mjs list <子串>              列出路径含子串的文件
 *   node src/asar.mjs find <子串> [上下文行数]   在所有 js/css 里搜字符串并打上下文
 *   node src/asar.mjs cat <路径>               打印一个文件的头部
 */
import { openSync, readSync, fstatSync, closeSync } from 'node:fs'

const ASAR = 'C:\\deepseek harness\\resources\\app.asar'

function readAsarIndex() {
  const fd = openSync(ASAR, 'r')
  const size = fstatSync(fd).size
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  // 4: uint32 = 4, 8: uint32 = headerPickleSize, 12: uint32 = payloadSize, 16: uint32 = jsonLength
  const headerPickleSize = head.readUInt32LE(4)
  const jsonLength = head.readUInt32LE(12)
  const jsonBuf = Buffer.alloc(jsonLength)
  readSync(fd, jsonBuf, 0, jsonLength, 16)
  const json = JSON.parse(jsonBuf.toString('utf8'))
  const dataStart = 8 + headerPickleSize
  const files = []
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const full = prefix ? prefix + '/' + name : name
      if (entry.files) walk(entry, full)
      else if (entry.offset !== undefined) {
        files.push({ path: full, offset: Number(entry.offset), size: entry.size })
      }
    }
  }
  walk(json, '')
  return { fd, size, dataStart, files }
}

function readFile(entry, dataStart) {
  const fd = openSync(ASAR, 'r')
  const buf = Buffer.alloc(entry.size)
  readSync(fd, buf, 0, entry.size, dataStart + entry.offset)
  closeSync(fd)
  return buf.toString('utf8')
}

const [cmd, needle, extra] = process.argv.slice(2)
const index = readAsarIndex()

if (cmd === 'list') {
  const hits = index.files.filter((f) => f.path.includes(needle || ''))
  hits.slice(0, 200).forEach((f) => console.log(f.size.toString().padStart(9), f.path))
  console.log('---', hits.length, 'files')
} else if (cmd === 'find') {
  const ctx = Number(extra || 0)
  const targets = index.files.filter((f) => /\.(js|css|json)$/.test(f.path) && f.size < 12e6)
  let total = 0
  for (const entry of targets) {
    const text = readFile(entry, index.dataStart)
    let at = text.indexOf(needle)
    while (at !== -1) {
      total += 1
      const before = text.lastIndexOf('\n', Math.max(0, at - 1))
      const after = text.indexOf('\n', at)
      const line = text.slice(before + 1, after === -1 ? undefined : after)
      console.log(`\n=== ${entry.path} @${at}`)
      console.log(line.slice(0, 600))
      if (ctx > 0) {
        const startLine = text.slice(0, at).split('\n').length - 1
        const lines = text.split('\n')
        const from = Math.max(0, startLine - ctx)
        const to = Math.min(lines.length, startLine + ctx + 1)
        for (let i = from; i < to; i += 1) console.log(`${i + 1}: ${lines[i].slice(0, 400)}`)
      }
      at = text.indexOf(needle, at + 1)
      if (total > 80) { console.log('...truncated'); break }
    }
    if (total > 80) break
  }
  console.log('---', total, 'hits')
} else if (cmd === 'cat') {
  const entry = index.files.find((f) => f.path.endsWith(needle))
  if (!entry) { console.log('not found'); process.exit(1) }
  console.log(`=== ${entry.path} (${entry.size} B)`)
  console.log(readFile(entry, index.dataStart).slice(0, Number(extra || 4000)))
} else {
  console.log('usage: list <substr> | find <substr> [ctx] | cat <suffix> [chars]')
}