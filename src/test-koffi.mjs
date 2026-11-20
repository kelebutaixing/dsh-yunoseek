/**
 * 验证 kit 里的 koffi 能不能取到 Win32 全局光标（pet.js 用的就是这段）。
 * 用 createRequire 从 host/ 解析，跟运行时一致。
 */
import { createRequire } from 'node:module'

const require = createRequire('file:///D:/gzq1/dsh-yunoseek/host/pet.js')
try {
  const koffi = require('koffi')
  console.log('koffi 版本:', koffi.version ?? '(未暴露)')
  const user32 = koffi.load('user32.dll')
  const POINT = koffi.struct('POINT', { x: 'long', y: 'long' })
  const GetCursorPos = user32.func('bool GetCursorPos(_Out_ POINT *pt)')
  const p = {}
  const ok = GetCursorPos(p)
  console.log('GetCursorPos 返回:', ok, '坐标:', JSON.stringify(p))
  const p2 = {}
  await new Promise((r) => setTimeout(r, 600))
  GetCursorPos(p2)
  console.log('600ms 后再取:', JSON.stringify(p2), ok && p2.x !== undefined ? '→ 能读到全局光标' : '')
} catch (e) {
  console.log('失败：' + e.message)
  process.exit(1)
}