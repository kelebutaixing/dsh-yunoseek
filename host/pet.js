/**
 * @local/yuno-pet — host 半端
 * ============================================================================
 * 只做两件事：
 *   1. 把 assets/yuno/<outfit>/ 下的 Live2D 模型文件用 /yuno-pet/* 路由发出去；
 *   2. 给浏览器半端一份 manifest（有几套衣服、默认哪套）。
 *
 * 模型不放 $DSH_HOME：这是随插件走的只读资源，升级插件时一起换。
 * Cubism Core 由前端 bundle 带着（见 src/build.mjs），不走网络。
 * ============================================================================
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

export const name = 'yuno-pet'
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
/* 合并进整合包后，本文件在 host/ 下，模型在包根的 assets/yuno/ */
const PKG_ROOT = resolve(HERE, '..')
const ASSET_ROOT = join(PKG_ROOT, 'assets', 'yuno')

/* 配置放宿主的磁盘，不依赖 localStorage：DSH 每次启动端口不同，origin 也会变 */
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = join(DSH_HOME, 'yuno-pet')
const CONFIG_PATH = join(STATE_DIR, 'config.json')
const WINDOW_PATH = join(STATE_DIR, 'window.json')

const CONFIG_KEYS = new Set([
  'enabled', 'outfit', 'size', 'opacity', 'x', 'y',
  'clickReact', 'bubble', 'lipSync', 'follow', 'idleMotion',
  'petVoice', 'focusY',
])

function pickConfig(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const key of CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) out[key] = raw[key]
  }
  return out
}

function readConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')
    return pickConfig(JSON.parse(raw))
  } catch {
    return {}
  }
}

function saveConfig(patch) {
  const next = { ...readConfig(), ...pickConfig(patch) }
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8')
  } catch { /* 写不进去就只在本次生效 */ }
  return next
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolvePromise({})
      try { resolvePromise(JSON.parse(raw)) } catch { reject(new Error('不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/**
 * 全局光标读取器。
 * DSH 的宿主是 ELECTRON_RUN_AS_NODE=1 的纯 Node，拿不到 electron.screen，
 * 所以优先用 koffi 调 Win32 user32.GetCursorPos（物理像素）；
 * 非 Windows / 没有 koffi 时再退回 Electron 的 screen（DIP）。
 */
let cursorReader = null
let cursorUnit = ''
try {
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')
  const POINT = koffi.struct('POINT', { x: 'long', y: 'long' })
  const GetCursorPos = user32.func('bool GetCursorPos(_Out_ POINT *pt)')
  cursorReader = () => {
    const p = {}
    return GetCursorPos(p) ? { x: p.x, y: p.y } : null
  }
  cursorUnit = 'physical'
} catch { /* 非 Windows 或 koffi 装不上 */ }

if (!cursorReader) {
  try {
    const electron = require('electron')
    if (electron && electron.screen && typeof electron.screen.getCursorScreenPoint === 'function') {
      cursorReader = () => electron.screen.getCursorScreenPoint()
      cursorUnit = 'dip'
    }
  } catch { /* 不是 Electron 宿主 */ }
}

/**
 * DSH 主窗口 bounds：桌面宿主固定 1280×820，不记忆尺寸。
 * 这里用 Win32 记外框，启动时恢复、运行中定时保存。
 * 只对标题「千问豆乃包」的窗口生效；找不到就什么都不做。
 */
let win32 = null
try {
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')
  const FindWindowW = user32.func('void* FindWindowW(str16 cls, str16 name)')
  const IsWindow = user32.func('bool IsWindow(void* hwnd)')
  const IsZoomed = user32.func('bool IsZoomed(void* hwnd)')
  const IsIconic = user32.func('bool IsIconic(void* hwnd)')
  const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  const GetWindowRect = user32.func('bool GetWindowRect(void* hwnd, _Out_ RECT *rect)')
  const SetWindowPos = user32.func('bool SetWindowPos(void* hwnd, void* after, int x, int y, int cx, int cy, uint flags)')
  const GetSystemMetrics = user32.func('int GetSystemMetrics(int index)')

  win32 = {
    findWindow() {
      for (const title of ['千问豆乃包', 'DeepSeek Harness', 'DeepSeek']) {
        try {
          const h = FindWindowW(null, title)
          if (h && IsWindow(h)) return h
        } catch { /* 忽略 */ }
      }
      return null
    },
    valid(h) { try { return !!h && IsWindow(h) } catch { return false } },
    zoomed(h) { try { return IsZoomed(h) } catch { return false } },
    iconic(h) { try { return IsIconic(h) } catch { return false } },
    bounds(h) {
      try {
        const r = {}
        if (!GetWindowRect(h, r)) return null
        return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top }
      } catch { return null }
    },
    move(h, b) {
      try {
        // SWP_NOZORDER | SWP_NOACTIVATE
        return SetWindowPos(h, null, b.x, b.y, b.w, b.h, 0x0014)
      } catch { return false }
    },
    clamp(b) {
      try {
        const vx = GetSystemMetrics(76)
        const vy = GetSystemMetrics(77)
        const vw = GetSystemMetrics(78)
        const vh = GetSystemMetrics(79)
        if (vw <= 0 || vh <= 0) return b
        const w = Math.min(Math.max(b.w, 520), vw)
        const h = Math.min(Math.max(b.h, 600), vh)
        const x = Math.min(Math.max(b.x, vx), vx + vw - w)
        const y = Math.min(Math.max(b.y, vy), vy + vh - h)
        return { x, y, w, h }
      } catch { return b }
    },
  }
} catch { /* 非 Windows 或 koffi 不可用 */ }

function readWindowState() {
  try {
    const raw = readFileSync(WINDOW_PATH, 'utf8').replace(/^\uFEFF/, '')
    const b = JSON.parse(raw)
    if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.w) || !Number.isFinite(b.h)) return null
    if (b.w < 400 || b.h < 300) return null
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }
  } catch {
    return null
  }
}

function saveWindowState(b) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(WINDOW_PATH, JSON.stringify(b, null, 2), 'utf8')
  } catch { /* 忽略 */ }
}

function startWindowMemory(ctx) {
  if (!win32) return
  let hwnd = null
  let last = ''
  let restored = false

  function save(h) {
    if (!win32.valid(h) || win32.zoomed(h) || win32.iconic(h)) return
    const b = win32.bounds(h)
    if (!b || b.w < 400 || b.h < 300) return
    const key = `${b.x},${b.y},${b.w},${b.h}`
    if (key === last) return
    last = key
    saveWindowState(b)
  }

  function tick() {
    if (!hwnd) hwnd = win32.findWindow()
    if (!hwnd) return
    if (!win32.valid(hwnd)) { hwnd = null; return }
    if (!restored) {
      restored = true
      const saved = readWindowState()
      if (saved && !win32.zoomed(hwnd) && !win32.iconic(hwnd)) {
        const target = win32.clamp(saved)
        win32.move(hwnd, target)
        last = `${target.x},${target.y},${target.w},${target.h}`
      }
    }
    save(hwnd)
  }

  tick()
  const timer = setInterval(tick, 1500)
  if (typeof timer.unref === 'function') timer.unref()
  process.once('exit', () => { try { if (hwnd) save(hwnd) } catch { /* 忽略 */ } })
  ctx.effect(() => () => { clearInterval(timer) }, 'yuno-pet: 窗口大小记忆')
  console.log('[yuno-pet] 窗口记忆：' + (win32 ? 'on' : 'off') + '（' + WINDOW_PATH + '）')
}

/** 衣服 id → 显示名（id 和模型文件名里的后缀一致） */
const OUTFIT_LABELS = {
  live_01: 'LIVE（DJ 服）',
  casual_spring_01: '私服（春）',
  school_summer_jhs: '中学夏制服',
  virtual_01: 'バーチャル',
}

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.moc3': 'application/octet-stream',
  '.model3.json': 'application/json; charset=utf-8',
}

function mimeOf(file) {
  const lower = file.toLowerCase()
  if (lower.endsWith('.model3.json')) return MIME['.model3.json']
  if (lower.endsWith('.motion3.json')) return MIME['.json']
  if (lower.endsWith('.exp3.json')) return MIME['.json']
  if (lower.endsWith('.physics3.json')) return MIME['.json']
  if (lower.endsWith('.cdi3.json')) return MIME['.json']
  return MIME[extname(lower)] || 'application/octet-stream'
}

function sendJson(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  try {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-length', String(body.length))
    res.end(body)
  } catch { /* 客户端断了 */ }
}

function sameOriginOk(req) {
  const host = req.headers?.host
  if (!host) return true
  const localHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)
  if (!localHost && !/^(dsh-app|app)(:\d+)?$/i.test(host)) return false
  const pick = String(req.headers?.origin || req.headers?.referer || '')
  if (!pick) return true
  try {
    const u = new URL(pick)
    if (u.protocol === 'dsh-app:') return true
    return String(u.host || '').toLowerCase() === String(host).toLowerCase()
  } catch {
    return false
  }
}

/** 列出 assets/yuno 下所有带 model3.json 的衣服 */
function scanOutfits() {
  let dirs = []
  try {
    dirs = readdirSync(ASSET_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
  const outfits = []
  for (const id of dirs) {
    const dir = join(ASSET_ROOT, id)
    let files = []
    try { files = readdirSync(dir) } catch { continue }
    const model = files.find((f) => f.endsWith('.model3.json'))
    if (!model) continue
    outfits.push({
      id,
      label: OUTFIT_LABELS[id] || id,
      model: `/yuno-pet/model/${encodeURIComponent(id)}/${encodeURIComponent(model)}`,
    })
  }
  return outfits
}

function serveFile(req, res, file) {
  if (!existsSync(file)) return sendJson(res, 404, { ok: false, error: 'not found' })
  let size = 0
  try { size = statSync(file).size } catch { return sendJson(res, 500, { ok: false, error: 'stat failed' }) }
  res.setHeader('content-type', mimeOf(file))
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('cache-control', 'public, max-age=604800, immutable')

  const range = String(req.headers?.range || '')
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (m) {
      let start = m[1] === '' ? null : Number(m[1])
      let end = m[2] === '' ? null : Number(m[2])
      if (start === null && end !== null) {
        start = Math.max(0, size - end)
        end = size - 1
      }
      start = start ?? 0
      end = Math.min(end ?? size - 1, size - 1)
      if (start > end || start >= size) {
        res.statusCode = 416
        res.setHeader('content-range', `bytes */${size}`)
        return res.end()
      }
      res.statusCode = 206
      res.setHeader('content-range', `bytes ${start}-${end}/${size}`)
      res.setHeader('content-length', String(end - start + 1))
      if (req.method === 'HEAD') return res.end()
      const stream = createReadStream(file, { start, end })
      stream.on('error', () => { try { res.destroy() } catch { /* 忽略 */ } })
      return stream.pipe(res)
    }
  }

  res.setHeader('content-length', String(size))
  if (req.method === 'HEAD') return res.end()
  const stream = createReadStream(file)
  stream.on('error', () => { try { res.destroy() } catch { /* 忽略 */ } })
  return stream.pipe(res)
}

/** 把 /yuno-pet/model/<outfit>/<path> 安全地落到 ASSET_ROOT 里 */
function resolveModelPath(rest) {
  let decoded
  try { decoded = decodeURIComponent(rest) } catch { return null }
  if (!decoded || decoded.includes('\0')) return null
  const parts = decoded.split(/[\\/]+/).filter(Boolean)
  if (!parts.length || parts.some((p) => p === '.' || p === '..')) return null
  const outfit = parts[0]
  const rel = parts.slice(1).join('/')
  if (!rel) return null
  const base = resolve(ASSET_ROOT, outfit)
  const file = resolve(base, ...rel.split('/'))
  if (file !== base && !file.startsWith(base + sep)) return null
  return file
}

async function handle(req, res, url) {
  const path = url.pathname

  if (path === '/yuno-pet/config') {
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, config: readConfig() })
    if (req.method === 'POST') {
      let body
      try { body = await readBody(req) } catch (err) {
        return sendJson(res, 400, { ok: false, error: String(err?.message || err) })
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, { ok: false, error: 'config 必须是对象' })
      }
      return sendJson(res, 200, { ok: true, config: saveConfig(body) })
    }
    return sendJson(res, 405, { ok: false, error: 'method not allowed' })
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { ok: false, error: 'method not allowed' })
  }

  if (path === '/yuno-pet/manifest.json') {
    return sendJson(res, 200, {
      ok: true,
      default: 'live_01',
      outfits: scanOutfits(),
      generatedAt: new Date().toISOString(),
    })
  }

  if (path === '/yuno-pet/icon.png') {
    return serveFile(req, res, join(ASSET_ROOT, 'character.png'))
  }

  if (path === '/yuno-pet/cursor') {
    if (!cursorReader) return sendJson(res, 200, { ok: false, error: 'cursor unavailable' })
    try {
      const p = cursorReader()
      if (!p) return sendJson(res, 200, { ok: false, error: 'cursor read failed' })
      return sendJson(res, 200, { ok: true, x: p.x, y: p.y, unit: cursorUnit })
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: String(err?.message || err) })
    }
  }

  if (path.startsWith('/yuno-pet/model/')) {
    const file = resolveModelPath(path.slice('/yuno-pet/model/'.length))
    if (!file) return sendJson(res, 400, { ok: false, error: 'bad path' })
    return serveFile(req, res, file)
  }

  return sendJson(res, 404, { ok: false, error: 'not found' })
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/yuno-pet',
    handler: async (req, res) => {
      if (!sameOriginOk(req)) return sendJson(res, 403, { ok: false, error: '只接受本机同源请求' })
      try {
        await handle(req, res, new URL(req.url || '/', 'http://127.0.0.1'))
      } catch (err) {
        try { sendJson(res, 500, { ok: false, error: String(err?.message || err) }) } catch { /* 忽略 */ }
      }
    },
  }), 'yuno-pet: /yuno-pet 模型路由')

  startWindowMemory(ctx)

  const outfits = scanOutfits()
  console.log(`[yuno-pet] 已挂载：${outfits.length} 套衣服（${outfits.map((o) => o.id).join(', ')}）；全局光标：${cursorReader ? cursorUnit : '不可用'}；配置：${CONFIG_PATH}`)
}