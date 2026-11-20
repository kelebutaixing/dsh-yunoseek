/**
 * dsh-yuno-ai — host 半边
 * ============================================================================
 * 把原本分开的三个包合成一个插件的宿主侧：
 *   - 桌宠（host/pet.js）：/yuno-pet 路由，把 assets/yuno 下的 Live2D 模型发出去；
 *   - 语音（host/tts.js）：/yuno-tts 路由，管本机 GPT-SoVITS 引擎；
 *   - 自检（本文件）：/yuno-kit 路由，一眼看清模型、权重、引擎配没配齐。
 *
 * 主题和头像只在浏览器里干活（client.js），宿主侧没它们的事。
 *
 * 一个子模块挂不上（比如没装 koffi、引擎路径没填）不该拖垮另一个，
 * 所以各自 try/catch，出错只写日志。
 * ============================================================================
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as pet from './host/pet.js'
import * as tts from './host/tts.js'

export const name = 'dsh-yuno-ai'
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE)
const ASSET_ROOT = join(PKG_ROOT, 'assets', 'yuno')

const PARTS = [
  ['pet', pet],
  ['tts', tts],
]

/** 自检用：模型的每套衣服是否完整（moc3 + model3.json + 贴图目录）。 */
function scanOutfits() {
  const out = []
  try {
    for (const name of readdirSync(ASSET_ROOT)) {
      const dir = join(ASSET_ROOT, name)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      const model3 = join(dir, `adv_live2d_yuno_015_${name}.model3.json`)
      out.push({
        id: name,
        model3: existsSync(model3),
        textures: existsSync(join(dir, 'textures')),
      })
    }
  } catch {
    /* 目录不在就返回空表 */
  }
  return out
}

function sameOriginOk(req) {
  const origin = req.headers?.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers?.host
  } catch {
    return false
  }
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** 自检面板：路径、模型、权重、引擎，一目了然。 */
function selfCheck() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
  const cfgFile = join(home, 'yuno-tts', 'config.json')
  let cfg = null
  try {
    cfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
  } catch {
    cfg = null
  }
  const py = cfg?.pythonPath || (cfg?.engineRoot ? join(cfg.engineRoot, 'runtime', 'python.exe') : '')
  const weights = {
    gpt: join(PKG_ROOT, 'models', 'yuno_gpt_e8.ckpt'),
    sovits: join(PKG_ROOT, 'models', 'yuno_sovits_e8.pth'),
  }
  return {
    ok: true,
    root: PKG_ROOT,
    outfits: scanOutfits(),
    assets: {
      models: Object.fromEntries(Object.entries(weights).map(([k, p]) => [k, existsSync(p)])),
      refs: existsSync(join(PKG_ROOT, 'refs')),
      server: existsSync(join(PKG_ROOT, 'server', 'yuno_tts_server_gsv.py')),
    },
    tts: {
      configFile: cfgFile,
      configured: Boolean(cfg?.engineRoot),
      engineRoot: cfg?.engineRoot || '',
      python: py,
      pythonExists: Boolean(py) && existsSync(py),
      port: cfg?.port ?? null,
      voiceDir: cfg?.voiceDir || '',
    },
  }
}

export function apply(ctx) {
  for (const [key, mod] of PARTS) {
    if (!mod || typeof mod.apply !== 'function') {
      console.warn('[yuno-kit] ' + key + ' 没有 apply，跳过')
      continue
    }
    try {
      mod.apply(ctx)
    } catch (err) {
      /* 一个部件趴了，另一个还得能用 */
      console.error('[yuno-kit] ' + key + ' 挂载失败：' + (err?.message || err))
      if (err?.stack) console.error(err.stack)
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/yuno-kit',
        handler: async (req, res) => {
          if (!sameOriginOk(req)) return sendJson(res, 403, { ok: false, error: '只接受本机同源请求' })
          try {
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            if (url.pathname === '/yuno-kit' || url.pathname === '/yuno-kit/health') return sendJson(res, 200, selfCheck())
            return sendJson(res, 404, { ok: false, error: 'not found' })
          } catch (err) {
            try {
              sendJson(res, 500, { ok: false, error: String(err?.message || err) })
            } catch {
              /* 忽略 */
            }
          }
        },
      }),
    'yuno-kit: /yuno-kit 自检路由',
  )

  const outfits = scanOutfits()
  console.log(
    `[yuno-kit] 已挂载：桌宠 ${outfits.length} 套（${outfits.map((o) => o.id).join(', ') || '无'}）+ 语音；自检 /yuno-kit`,
  )
}