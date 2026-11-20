/**
 * dsh-yuno-tts — host 半端
 * ============================================================================
 * 把本机的 GPT-SoVITS 接成 DSH 的语音输出：
 *   1. 管一个常驻 Python 引擎（server/yuno_tts_server_gsv.py），模型只加载一次；
 *   2. 提供 /yuno-tts/* 路由：合成、缓存音频、读取/保存配置、启停引擎；
 *   3. 前端半端（client.js）负责「哪条消息要念」「什么时候念」。
 *
 * 家里（$DSH_HOME/yuno-tts/）：
 *   config.json   用户配置
 *   audio/        合成好的 wav（按 text+voice+lang 的哈希命名，命中即复用）
 *   engine.log    引擎输出
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync,
  readFileSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'yuno-tts'
/** 只要 webServer：设置由自己的 config.json 存，不走 DSH settings（少踩坑） */
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
/* 合并进整合包后，本文件在 host/ 下；server / models / refs / scripts 都在包根 */
const PKG_ROOT = resolve(HERE, '..')
const BUNDLED_SERVER = join(PKG_ROOT, 'server', 'yuno_tts_server_gsv.py')
const BUNDLED_PROMPTS = join(PKG_ROOT, 'server', 'gsv_voices.json')
const BUNDLED_REFS = join(PKG_ROOT, 'refs')
const BUNDLED_GPT = join(PKG_ROOT, 'models', 'yuno_gpt_e8.ckpt')
const BUNDLED_SOVITS = join(PKG_ROOT, 'models', 'yuno_sovits_e8.pth')
const BUNDLED_LAUNCHER = join(PKG_ROOT, 'scripts', 'start-engine-hidden.vbs')

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = join(DSH_HOME, 'yuno-tts')
const AUDIO_DIR = join(STATE_DIR, 'audio')
const CONFIG_PATH = join(STATE_DIR, 'config.json')
const ENGINE_LOG = join(STATE_DIR, 'engine.log')
const ENGINE_CACHE = join(STATE_DIR, 'engine-cache')

/* 开机自启：往 Windows 启动文件夹里放一个 vbs，登录时隐藏拉起引擎。
   源文件随包走（scripts/），对方装到哪都能用。 */
const STARTUP_DIR = join(
  process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
)
const BOOT_VBS = join(STARTUP_DIR, 'yuno-engine-warmup.vbs')
const BOOT_SRC = BUNDLED_LAUNCHER

const MAX_AUDIO_FILES = 300
const MAX_LOG_BYTES = 2 * 1024 * 1024

const DEFAULTS = {
  /** 总开关：关掉之后前端一个字都不念 */
  enabled: true,
  /** 新回复自动朗读 */
  autoRead: true,
  /** 一次最多念多少字（长的截断，别让浏览器等太久） */
  maxChars: 180,
  /** 音色文件（留空 = 用 voiceDir 里第一个） */
  voice: '',
  /** 参考音频放哪（默认用包里自带的那 8 段） */
  voiceDir: BUNDLED_REFS,
  /** GPT-SoVITS 安装目录（runtime + GPT_SoVITS 所在）—— 随包不带引擎，要让使用者自己填 */
  engineRoot: '',
  /** 跑引擎的 python（默认跟 engineRoot 下 runtime/python.exe） */
  pythonPath: '',
  /** T2S 权重：默认用包里自带的 yuno 模型；引擎的 torch.load 直接吃绝对路径 */
  gptWeights: BUNDLED_GPT,
  /** SoVITS 权重：同上 */
  sovitsWeights: BUNDLED_SOVITS,
  /** 引擎端口（和 fairy 的 9800 错开） */
  port: 9801,
  /** zh / zhen / en / ja */
  lang: 'zh',
  /** 插件加载后自动拉起引擎（否则等第一次合成时才拉）。
      默认关：没配引擎的机器不该每次启动都去撞一次。填好路径后在设置页打开。 */
  autoStart: false,
  /** DSH 退出时别停引擎。默认关 —— 开了要靠 PS 启动器脱离进程树，装不装得成因人而异 */
  keepAlive: false,
  /** 空闲多少分钟自动停引擎（0 = 不停，省得每次等加载） */
  idleStopMinutes: 0,
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */
function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

let cfg = { ...DEFAULTS, ...readJson(CONFIG_PATH, {}) }

function saveCfg(patch) {
  cfg = { ...cfg, ...(patch || {}) }
  writeJson(CONFIG_PATH, cfg)
  return cfg
}

function publicConfig() {
  return { ...cfg }
}

/* ------------------------------------------------------------------ *
 * 引擎进程
 * ------------------------------------------------------------------ */
let engineChild = null
let startingPromise = null
let lastUsedAt = 0
let lastError = ''
let idleTimer = null

function log(line) {
  const text = `[${new Date().toLocaleTimeString()}] ${line}\n`
  try {
    if (existsSync(ENGINE_LOG) && statSync(ENGINE_LOG).size > MAX_LOG_BYTES) {
      writeFileSync(ENGINE_LOG, '', 'utf8')
    }
    appendFileSync(ENGINE_LOG, text, 'utf8')
  } catch { /* 日志写不进去不影响功能 */ }
  console.log('[yuno-tts] ' + line)
}

function engineBase() {
  return `http://127.0.0.1:${cfg.port}`
}

async function health(timeout = 1200) {
  try {
    const res = await fetch(engineBase() + '/health', { signal: AbortSignal.timeout(timeout) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function wait(ms) {
  return new Promise((r) => { const t = setTimeout(r, ms); t.unref?.() })
}

async function waitReady(deadlineMs = 240_000) {
  const started = Date.now()
  let seenLoading = false
  while (Date.now() - started < deadlineMs) {
    const h = await health()
    if (h && h.ready) return h
    if (h && h.loading) seenLoading = true
    if (h && h.error) throw new Error('引擎加载失败：' + h.error)
    if (!h && seenLoading && !engineChild) {
      /* 端口没人了、我们也没拉过子进程 → 原来那个引擎退出了 */
      throw new Error('引擎进程退出了（看 engine.log）')
    }
    await wait(1000)
  }
  throw new Error('引擎 240 秒还没就绪（看 engine.log）')
}

/** 引擎的 python：没填就跟 engineRoot 下的 runtime/python.exe 走。 */
function enginePython() {
  if (cfg.pythonPath) return cfg.pythonPath
  if (cfg.engineRoot) return join(cfg.engineRoot, 'runtime', 'python.exe')
  return ''
}

/** 权重路径：绝对路径原样用；相对路径按 engineRoot 解析 —— 引擎自己会 chdir 到 root，
    所以「相对 root」才是它眼里的相对路径，不能按 DSH 的当前目录判存在。 */
function resolveWeight(p) {
  if (!p) return ''
  if (isAbsolute(p)) return p
  return cfg.engineRoot ? join(cfg.engineRoot, p) : p
}

/** 启动前的自检：缺什么就直说缺什么，别让人对着 engine.log 猜。 */
function ensureConfigForEngine() {
  if (!cfg.engineRoot) throw new Error('还没填 GPT-SoVITS 的安装目录（设置 → 语音 → 引擎目录）')
  if (!existsSync(cfg.engineRoot)) throw new Error('引擎目录不存在：' + cfg.engineRoot)
  const py = enginePython()
  if (!py) throw new Error('还没填 python 路径（设置 → 语音）')
  if (!existsSync(py)) throw new Error('找不到 python：' + py + '（设置 → 语音 → python 路径）')
  if (!existsSync(BUNDLED_SERVER)) throw new Error('包里缺引擎脚本：' + BUNDLED_SERVER)
  for (const [label, p] of [['T2S 权重', resolveWeight(cfg.gptWeights)], ['SoVITS 权重', resolveWeight(cfg.sovitsWeights)]]) {
    if (!p) throw new Error('还没填' + label + '路径')
    if (!existsSync(p)) throw new Error(label + '不存在：' + p)
  }
  return py
}

function spawnEngine() {
  if (engineChild) return
  const python = ensureConfigForEngine()
  const script = BUNDLED_SERVER
  mkdirSync(STATE_DIR, { recursive: true })
  mkdirSync(ENGINE_CACHE, { recursive: true })

  const args = [
    '-u', script,
    '--port', String(cfg.port),
    '--root', cfg.engineRoot,
    '--voice-dir', cfg.voiceDir || '',
    '--prompts', BUNDLED_PROMPTS,
    '--gpt-weights', resolveWeight(cfg.gptWeights),
    '--sovits-weights', resolveWeight(cfg.sovitsWeights),
    '--cache-dir', ENGINE_CACHE,
  ]
  if (cfg.voice && existsSync(cfg.voice)) args.push('--voice', cfg.voice)

  log(`启动引擎：${python} ${args.join(' ')}`)
  /* 用 wscript 拉起引擎，让它彻底脱离 DSH 的进程树。
     Electron 在 Windows 上会把子进程收进 Job Object，DSH 一退出整个 job 就被杀，
     detached / unref 都逃不掉；只有换个进程树、由 WMI 起才真正常驻。
     启动器随包发（scripts/），路径不会跟着安装位置变。 */
  const launcher = BUNDLED_LAUNCHER
  if (existsSync(launcher) && cfg.keepAlive) {
    try {
      const p = spawn('wscript.exe', ['//B', launcher], {
        windowsHide: true,
        stdio: 'ignore',
        detached: true,
      })
      p.unref()
      log('引擎交给启动器（' + launcher + '）拉起，不在 DSH 进程树里')
      return
    } catch (err) {
      log('启动器失败，退回直接 spawn：' + (err?.message || err))
    }
  }

  /* 引擎的 stdout/stderr 直接写文件、不走管道：
     这样 DSH 退出、管道断开时 Python 不会因为 BrokenPipe 跟着挂掉 */
  let outFd = 'ignore'
  let errFd = 'ignore'
  try {
    outFd = openSync(join(STATE_DIR, 'engine.out.log'), 'a')
    errFd = openSync(join(STATE_DIR, 'engine.err.log'), 'a')
  } catch { /* 打不开就丢弃日志 */ }
  const child = spawn(python, args, {
    cwd: cfg.engineRoot,
    windowsHide: true,
    stdio: ['ignore', outFd, errFd],
    detached: !!cfg.keepAlive,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', TQDM_DISABLE: '1' },
  })
  engineChild = child
  if (cfg.keepAlive) {
    try { child.unref() } catch { /* 忽略 */ }
  }
  child.on('exit', (code) => {
    log(`引擎退出 code=${code}`)
    if (engineChild === child) engineChild = null
  })
  child.on('error', (err) => {
    log('引擎启动出错：' + (err?.message || err))
    if (engineChild === child) engineChild = null
  })
}

async function ensureEngine() {
  const h = await health()
  if (h && h.ready) {
    lastUsedAt = Date.now()
    return h
  }
  if (startingPromise) return startingPromise
  startingPromise = (async () => {
    if (!h) spawnEngine()
    const ready = await waitReady()
    lastError = ''
    lastUsedAt = Date.now()
    log('引擎就绪')
    return ready
  })().catch((err) => {
    lastError = String(err?.message || err)
    log('引擎没起来：' + lastError)
    throw err
  }).finally(() => {
    startingPromise = null
  })
  return startingPromise
}

async function stopEngine() {
  const h = await health(800)
  if (h && h.ready) {
    try {
      await fetch(engineBase() + '/shutdown', { method: 'POST', signal: AbortSignal.timeout(3000) })
    } catch { /* 忽略 */ }
    await wait(800)
  }
  if (engineChild) {
    try { engineChild.kill() } catch { /* 忽略 */ }
    engineChild = null
  }
  log('引擎已停止')
}

function armIdleTimer() {
  if (!cfg.idleStopMinutes) return
  if (idleTimer) clearTimeout(idleTimer)
  const ms = cfg.idleStopMinutes * 60_000
  idleTimer = setTimeout(() => {
    if (Date.now() - lastUsedAt < ms) return armIdleTimer()
    stopEngine().catch(() => {})
  }, ms + 1000)
  idleTimer.unref?.()
}

/* ------------------------------------------------------------------ *
 * 文本清理 + 缓存
 * ------------------------------------------------------------------ */
function cleanText(raw) {
  return String(raw ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/[*_~#>|]+/g, ' ')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function clipText(text) {
  const max = Math.max(20, Math.min(2000, Number(cfg.maxChars) || 180))
  const chars = [...text]
  if (chars.length <= max) return text
  /* 尽量在标点处断开，听起来不突兀 */
  const head = chars.slice(0, max).join('')
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('，'), head.lastIndexOf('；'))
  const out = cut > max * 0.6 ? head.slice(0, cut + 1) : head
  return out.replace(/[，、；：]$/, '') + '。'
}

function audioKey(text, voice, lang) {
  return createHash('sha1').update(`${text}\u0000${voice}\u0000${lang}`).digest('hex')
}

function pruneAudio() {
  try {
    const files = readdirSync(AUDIO_DIR).filter((f) => f.endsWith('.wav'))
    if (files.length <= MAX_AUDIO_FILES) return
    const stats = files.map((f) => {
      const full = join(AUDIO_DIR, f)
      return { full, at: statSync(full).mtimeMs }
    }).sort((a, b) => a.at - b.at)
    for (const item of stats.slice(0, stats.length - MAX_AUDIO_FILES)) {
      try { unlinkSync(item.full) } catch { /* 忽略 */ }
    }
  } catch { /* 忽略 */ }
}

/* ------------------------------------------------------------------ *
 * HTTP 工具
 * ------------------------------------------------------------------ */
function sendJson(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  try {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-length', String(body.length))
    res.end(body)
  } catch { /* 忽略 */ }
}

function sameOriginOk(req) {
  const host = req.headers?.host
  if (!host) return true
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
  const pick = String(req.headers?.origin || req.headers?.referer || '')
  if (!pick) return true
  try {
    const u = new URL(pick)
    return String(u.host || '').toLowerCase() === String(host).toLowerCase()
  } catch {
    return false
  }
}

function sendFile(req, res, file) {
  if (!existsSync(file)) return sendJson(res, 404, { ok: false, error: 'not found' })
  let size = 0
  try { size = statSync(file).size } catch { return sendJson(res, 500, { ok: false, error: 'stat failed' }) }
  const range = String(req.headers?.range || '')
  res.setHeader('content-type', 'audio/wav')
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('cache-control', 'public, max-age=86400')
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
        res.end()
        return
      }
      res.statusCode = 206
      res.setHeader('content-range', `bytes ${start}-${end}/${size}`)
      res.setHeader('content-length', String(end - start + 1))
      const stream = createReadStream(file, { start, end })
      stream.on('error', () => { try { res.end() } catch { /* 忽略 */ } })
      stream.pipe(res)
      return
    }
  }
  res.statusCode = 200
  res.setHeader('content-length', String(size))
  const stream = createReadStream(file)
  stream.on('error', () => { try { res.end() } catch { /* 忽略 */ } })
  stream.pipe(res)
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
      try { resolvePromise(JSON.parse(raw)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/* ------------------------------------------------------------------ *
 * 业务
 * ------------------------------------------------------------------ */
async function synthesize(rawText, voiceOverride, rawSay) {
  const text = clipText(cleanText(rawText))
  if (!text) throw new Error('没有可朗读的文字')
  const voice = String(voiceOverride || cfg.voice || '').trim()

  /* 只念日语稿（〔ゆの：…〕）。没有稿子就报错，前端会静默，不翻译、不拿中文顶 */
  const say = clipText(cleanText(String(rawSay || '').trim()))
  if (!say) throw new Error('这条没有日语稿')
  const lang = 'ja'
  const spoken = say

  const key = audioKey(spoken, voice, lang)
  const file = join(AUDIO_DIR, key + '.wav')
  mkdirSync(AUDIO_DIR, { recursive: true })

  if (existsSync(file)) {
    lastUsedAt = Date.now()
    armIdleTimer()
    return {
      ok: true, url: `/yuno-tts/audio/${key}.wav`, cached: true,
      text, spoken, lang, voice: voice || '(默认音色)',
    }
  }

  await ensureEngine()
  const res = await fetch(engineBase() + '/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: spoken, voice: voice || undefined, out: file, lang }),
    signal: AbortSignal.timeout(600_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) throw new Error(data.error || `引擎返回 ${res.status}`)
  pruneAudio()
  lastUsedAt = Date.now()
  armIdleTimer()
  return {
    ok: true,
    url: `/yuno-tts/audio/${key}.wav`,
    cached: false,
    text,
    spoken,
    lang,
    seconds: data.seconds,
    audioSeconds: data.audioSeconds,
    voice: data.voice,
  }
}

async function handle(req, res, url) {
  const path = url.pathname.replace(/^\/yuno-tts/, '') || '/'

  if (path === '/status' && req.method === 'GET') {
    const h = await health(2000)
    return sendJson(res, 200, {
      ok: true,
      config: publicConfig(),
      engine: h
        ? { up: true, ready: !!h.ready, loading: !!h.loading, error: h.error || '', device: h.device, rtf: h.rtf, loadSeconds: h.loadSeconds, voice: h.voice, voiceDir: h.voiceDir, voices: h.voices || [] }
        : { up: false, ready: false, loading: !!startingPromise, error: lastError, voices: [] },
      defaults: DEFAULTS,
    })
  }

  if (path === '/config' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, config: publicConfig(), defaults: DEFAULTS })
  }

  if (path === '/config' && req.method === 'POST') {
    const body = await readBody(req)
    const patch = {}
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
    if (typeof body.autoRead === 'boolean') patch.autoRead = body.autoRead
    if (body.maxChars !== undefined) patch.maxChars = Math.max(20, Math.min(2000, Number(body.maxChars) || 180))
    if (typeof body.voice === 'string') patch.voice = body.voice.trim()
    if (typeof body.voiceDir === 'string') patch.voiceDir = body.voiceDir.trim()
    if (typeof body.lang === 'string') patch.lang = body.lang.trim() || 'zh'
    if (typeof body.gptWeights === 'string' && body.gptWeights.trim()) patch.gptWeights = body.gptWeights.trim()
    if (typeof body.sovitsWeights === 'string' && body.sovitsWeights.trim()) patch.sovitsWeights = body.sovitsWeights.trim()
    if (typeof body.engineRoot === 'string' && body.engineRoot.trim()) patch.engineRoot = body.engineRoot.trim()
    if (typeof body.pythonPath === 'string') patch.pythonPath = body.pythonPath.trim()
    if (body.port !== undefined) patch.port = Math.max(1024, Math.min(65535, Number(body.port) || 9801))
    if (typeof body.autoStart === 'boolean') patch.autoStart = body.autoStart
    if (typeof body.keepAlive === 'boolean') patch.keepAlive = body.keepAlive
    if (body.idleStopMinutes !== undefined) patch.idleStopMinutes = Math.max(0, Number(body.idleStopMinutes) || 0)

    const before = { ...cfg }
    saveCfg(patch)
    armIdleTimer()

    /* 音色 / 语言变了 → 旧缓存里的声音就不对了，清掉 */
    const voiceTouched = ['voice', 'voiceDir', 'lang'].some((k) => k in patch && patch[k] !== before[k])
    if (voiceTouched) {
      try {
        for (const f of readdirSync(AUDIO_DIR)) {
          if (f.endsWith('.wav')) { try { unlinkSync(join(AUDIO_DIR, f)) } catch { /* 忽略 */ } }
        }
      } catch { /* 忽略 */ }
    }
    /* 改的是引擎启动参数 → 下次合成时用新参数重新拉起来 */
    const engineTouched = ['voiceDir', 'engineRoot', 'pythonPath', 'port', 'lang', 'voice', 'gptWeights', 'sovitsWeights'].some((k) => k in patch && patch[k] !== before[k])
    if (engineTouched) stopEngine().catch(() => {})

    return sendJson(res, 200, { ok: true, config: publicConfig(), restartEngine: engineTouched })
  }

  if (path === '/boot' && req.method === 'GET') {
    let enabled = false
    try { enabled = existsSync(BOOT_VBS) } catch { /* 忽略 */ }
    return sendJson(res, 200, {
      ok: true,
      enabled,
      path: BOOT_VBS,
      source: BOOT_SRC,
      sourceExists: existsSync(BOOT_SRC),
    })
  }

  if (path === '/boot' && req.method === 'POST') {
    const body = await readBody(req)
    const enable = body.enable !== false
    try {
      if (enable) {
        if (!existsSync(BOOT_SRC)) throw new Error('找不到自启脚本源文件：' + BOOT_SRC)
        mkdirSync(STARTUP_DIR, { recursive: true })
        copyFileSync(BOOT_SRC, BOOT_VBS)
      } else if (existsSync(BOOT_VBS)) {
        unlinkSync(BOOT_VBS)
      }
      const enabled = existsSync(BOOT_VBS)
      log('开机自启 ' + (enabled ? '已开启' : '已关闭') + '：' + BOOT_VBS)
      return sendJson(res, 200, { ok: true, enabled, path: BOOT_VBS })
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String(err?.message || err) })
    }
  }

  if (path === '/voices' && req.method === 'GET') {
    const h = await health(1500)
    if (h && Array.isArray(h.voices) && h.voices.length) {
      /* gsv 引擎回的是文件名数组，前端要 {name,file,path} */
      const list = h.voices.map((v) => {
        if (typeof v === 'string') {
          const full = join(cfg.voiceDir || '', v)
          let bytes = 0
          try { bytes = statSync(full).size } catch { /* 忽略 */ }
          return { name: v.replace(/\.[^.]+$/, ''), file: v, path: full, bytes }
        }
        return v
      })
      return sendJson(res, 200, { ok: true, voiceDir: h.voiceDir || cfg.voiceDir, voice: h.voice, voices: list })
    }
    /* 引擎没起也能列目录 */
    const voices = []
    try {
      for (const f of readdirSync(cfg.voiceDir)) {
        if (!/\.(wav|mp3|flac|m4a|ogg)$/i.test(f)) continue
        const full = join(cfg.voiceDir, f)
        try {
          voices.push({ name: f.replace(/\.[^.]+$/, ''), file: f, path: full, bytes: statSync(full).size })
        } catch { /* 忽略 */ }
      }
    } catch { /* 目录不存在 */ }
    return sendJson(res, 200, { ok: true, voiceDir: cfg.voiceDir, voice: cfg.voice, voices })
  }

  if (path === '/trace' && req.method === 'POST') {
    const body = await readBody(req, 128 * 1024)
    try {
      appendFileSync(join(STATE_DIR, 'client-trace.log'), JSON.stringify(body) + '\n')
    } catch { /* 忽略 */ }
    return sendJson(res, 200, { ok: true })
  }

  if (path === '/speak' && req.method === 'POST') {
    const body = await readBody(req, 256 * 1024)
    const result = await synthesize(body.text, body.voice, body.say)
    return sendJson(res, 200, result)
  }

  if (path === '/engine' && req.method === 'POST') {
    const body = await readBody(req)
    const action = String(body.action || 'start')
    if (action === 'stop') {
      await stopEngine()
      return sendJson(res, 200, { ok: true, engine: { up: false } })
    }
    if (action === 'start' || action === 'restart') {
      if (action === 'restart') await stopEngine()
      const h = await ensureEngine()
      return sendJson(res, 200, { ok: true, engine: { up: true, ready: !!h.ready, device: h.device, voices: h.voices || [] } })
    }
    return sendJson(res, 400, { ok: false, error: 'action 只能是 start / stop / restart' })
  }

  if (path.startsWith('/audio/') && req.method === 'GET') {
    const key = path.slice('/audio/'.length)
    if (!/^[a-f0-9]{40}\.wav$/.test(key)) return sendJson(res, 404, { ok: false, error: 'not found' })
    return sendFile(req, res, join(AUDIO_DIR, key))
  }

  return sendJson(res, 404, { ok: false, error: 'not found' })
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */
export function apply(ctx) {
  mkdirSync(AUDIO_DIR, { recursive: true })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/yuno-tts',
    handler: async (req, res) => {
      if (!sameOriginOk(req)) return sendJson(res, 403, { ok: false, error: '只接受本机同源请求' })
      try {
        await handle(req, res, new URL(req.url || '/', 'http://127.0.0.1'))
      } catch (err) {
        log('请求出错：' + (err?.message || err))
        try { sendJson(res, 500, { ok: false, error: String(err?.message || err) }) } catch { /* 忽略 */ }
      }
    },
  }), 'yuno-tts: /yuno-tts 路由')

  /* 自动拉起：延迟一会儿，别跟宿主启动抢资源 */
  if (cfg.autoStart) {
    const t = setTimeout(() => {
      health(1500).then((h) => {
        if (h && h.ready) { log('已有引擎在跑，直接复用'); return }
        if (h && h.loading) { log('有引擎正在加载，等它'); return }
        ensureEngine().catch(() => { /* 失败信息已经写进 log */ })
      })
    }, 15_000)
    t.unref?.()
    ctx.effect(() => () => { try { clearTimeout(t) } catch { /* 忽略 */ } }, 'yuno-tts: 自动启动定时器')
  }

  ctx.effect(() => () => { if (!cfg.keepAlive) stopEngine().catch(() => {}) }, 'yuno-tts: 收引擎')
  log(`已挂载（状态目录 ${STATE_DIR}）`)
}


