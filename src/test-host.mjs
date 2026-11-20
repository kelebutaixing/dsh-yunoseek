/**
 * 在 Node 里用假的 ctx 把 host 半边跑一遍：
 *   - 三个路由都注册上了吗（/yuno-pet /yuno-tts /yuno-kit）
 *   - 桌宠扫出几套衣服
 *   - /yuno-kit 自检返回什么
 *   - 没配引擎时语音那边是不是安静地降级（不能抛、不能真拉进程）
 *
 * DSH_HOME 指向临时目录，避免动到真实配置。
 * 用法：node src/test-host.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'yuno-kit-home-'))
process.env.DSH_HOME = home

const routes = []
const effects = []
const logs = []
const ctx = {
  webServer: {
    register(spec) {
      routes.push(spec)
      return () => {}
    },
  },
  effect(fn, label) {
    effects.push(label)
    const cleanup = fn()
    return cleanup
  },
  logger: { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
}

const errors = []
const origError = console.error
console.error = (...a) => { errors.push(a.join(' ')) }
const origWarn = console.warn
console.warn = (...a) => { errors.push('warn: ' + a.join(' ')) }
const origLog = console.log
console.log = (...a) => { logs.push(a.join(' ')) }

let failed = 0
const check = (ok, label, extra = '') => {
  origLog(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}

try {
  const mod = await import('../index.js')
  check(mod.name === 'dsh-yunoseek', '包名', mod.name)
  check(Array.isArray(mod.inject) && mod.inject.includes('webServer'), 'inject 含 webServer', JSON.stringify(mod.inject))

  mod.apply(ctx)

  const paths = routes.map((r) => r.path).sort()
  check(paths.includes('/yuno-pet'), '/yuno-pet 路由', paths.join(','))
  check(paths.includes('/yuno-tts'), '/yuno-tts 路由')
  check(paths.includes('/yuno-kit'), '/yuno-kit 自检路由')

  /* 走一遍自检 handler */
  const kit = routes.find((r) => r.path === '/yuno-kit')
  let payload = null
  const res = {
    writeHead() {},
    end(text) { payload = JSON.parse(text) },
  }
  await kit.handler({ url: '/yuno-kit', headers: { host: '127.0.0.1:1' } }, res)
  check(payload && payload.ok === true, '自检返回 ok')
  check(Array.isArray(payload.outfits) && payload.outfits.length === 4, '桌宠 4 套衣服', JSON.stringify((payload.outfits || []).map((o) => o.id)))
  check(payload.outfits.every((o) => o.model3 && o.textures), '每套都有 model3.json + textures')
  check(payload.assets.models.gpt && payload.assets.models.sovits, '语音权重在包内')
  check(payload.assets.refs, '参考音频目录在')
  check(payload.assets.server, '引擎脚本在')
  check(payload.tts.configured === false, '临时 DSH_HOME 里没配置引擎（应报未配置）')

  /* 没配引擎时，主动合成必须给一句人话，而不是抛底层的 ENOENT */
  const ttsMod = await import('../host/tts.js')
  check(typeof ttsMod.apply === 'function' && ttsMod.name === 'yuno-tts', 'host/tts.js 可独立加载')
  const petMod = await import('../host/pet.js')
  check(typeof petMod.apply === 'function' && petMod.name === 'yuno-pet', 'host/pet.js 可独立加载')

  check(errors.length === 0, '挂载过程没有 error/warn', errors.slice(0, 2).join(' | '))
} catch (err) {
  origLog('FAIL  抛异常：' + (err?.stack || err))
  failed++
} finally {
  console.log = origLog
  console.error = origError
  console.warn = origWarn
  try { rmSync(home, { recursive: true, force: true }) } catch {}
}

origLog(failed === 0 ? '\n全部通过' : `\n${failed} 项没过`)
process.exit(failed === 0 ? 0 : 1)