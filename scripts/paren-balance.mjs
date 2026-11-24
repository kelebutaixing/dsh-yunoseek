// 数一段代码里的括号平衡（忽略字符串内容），定位不配平的位置。
import { readFileSync } from 'node:fs'
const file = process.argv[2]
const from = Number(process.argv[3])
const to = Number(process.argv[4])
const lines = readFileSync(file, 'utf8').split('\n')
let depth = 0
let inS = null, inT = false, esc = false
for (let i = from - 1; i < to; i += 1) {
  const line = lines[i] ?? ''
  let startDepth = depth
  for (const ch of line) {
    if (esc) { esc = false; continue }
    if (inS) {
      if (ch === '\\') { esc = true; continue }
      if (ch === inS) inS = null
      continue
    }
    if (inT) { if (ch === '`') inT = false; continue }
    if (ch === "'" || ch === '"') { inS = ch; continue }
    if (ch === '`') { inT = true; continue }
    if (ch === '/' && false) continue
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
  }
  console.log(String(i + 1).padStart(5), 'depth=' + depth, String(startDepth), '|', line.trim().slice(0, 74))
}