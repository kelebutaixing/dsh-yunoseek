// 找出 DSH 主题里 --dsw-font-family 的赋值方式，确认能不能从 CSS 覆盖。
import { openSync, readSync, closeSync } from 'node:fs'
const ASAR = 'C:\\deepseek harness\\resources\\app.asar'
const head = Buffer.alloc(16)
const fd = openSync(ASAR, 'r')
readSync(fd, head, 0, 16, 0)
const hp = head.readUInt32LE(4), jl = head.readUInt32LE(12)
const jb = Buffer.alloc(jl)
readSync(fd, jb, 0, jl, 16)
closeSync(fd)
const json = JSON.parse(jb.toString('utf8'))
const dataStart = 8 + hp
const files = []
const walk = (n, p) => {
  for (const [k, e] of Object.entries(n.files || {})) {
    const f = p ? p + '/' + k : k
    if (e.files) walk(e, f)
    else if (e.offset !== undefined) files.push({ path: f, offset: Number(e.offset), size: e.size })
  }
}
walk(json, '')
const entry = files.find((f) => f.path.endsWith('dsh-client-ui-theme/lib/client.js'))
const f2 = openSync(ASAR, 'r')
const b = Buffer.alloc(entry.size)
readSync(f2, b, 0, entry.size, dataStart + entry.offset)
closeSync(f2)
const s = b.toString('utf8')

let idx = 0
let n = 0
while ((idx = s.indexOf('--dsw-font-family', idx + 1)) !== -1 && n < 12) {
  const seg = s.slice(Math.max(0, idx - 120), idx + 260)
  if (/--dsw-font-family(-\w+)?\s*:/.test(seg)) {
    console.log('=== @', idx)
    console.log(seg.replace(/\n/g, ' '))
    n += 1
  }
}
console.log('--- hits shown:', n)