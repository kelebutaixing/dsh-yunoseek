/** 从 asar 里提取某个 module.css 的类名清单，可附带每个类的首条声明块。 */
import { openSync, readSync, fstatSync, closeSync } from 'node:fs'
const ASAR = 'C:\\deepseek harness\\resources\\app.asar'
const head = Buffer.alloc(16)
const fd = openSync(ASAR, 'r')
readSync(fd, head, 0, 16, 0)
const headerPickleSize = head.readUInt32LE(4)
const jsonLength = head.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonLength)
readSync(fd, jsonBuf, 0, jsonLength, 16)
closeSync(fd)
const json = JSON.parse(jsonBuf.toString('utf8'))
const dataStart = 8 + headerPickleSize
const files = []
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const full = prefix ? prefix + '/' + name : name
    if (entry.files) walk(entry, full)
    else if (entry.offset !== undefined) files.push({ path: full, offset: Number(entry.offset), size: entry.size })
  }
}
walk(json, '')
function readFile(entry) {
  const fd2 = openSync(ASAR, 'r')
  const buf = Buffer.alloc(entry.size)
  readSync(fd2, buf, 0, entry.size, dataStart + entry.offset)
  closeSync(fd2)
  return buf.toString('utf8')
}
const needle = process.argv[2] || ''
const entry = files.find((f) => f.path.endsWith(needle))
if (!entry) { console.log('not found:', needle); process.exit(1) }
const css = readFile(entry)
const names = [...new Set([...css.matchAll(/(?:^|\n)\s*\.([A-Za-z][\w-]*)/g)].map((m) => m[1]))]
console.log(`=== ${entry.path}  (${css.length} B, ${names.length} classes)`)
console.log(names.join(' '))