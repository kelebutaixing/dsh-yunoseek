/**
 * 真 Chrome 里跑 client.js：验证 DOM 层真的动起来了。
 *   - 主题注入了样式节点、改了 token
 *   - 头像给助手消息打了标记、伪元素样式生效
 *   - 桌宠会尝试初始化（缺 /yuno-pet 路由时应该自己降级，不拖垮别人）
 *   - 四个部件之一抛错不影响其他
 *
 * 用法：node src/test-client-chrome.mjs
 */
import { readFileSync } from 'node:fs'
import { chromium } from 'file:///D:/gzq1/dsh-bili-coin/node_modules/playwright-core/index.mjs'

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('   [pageerror]', e.message))

await page.setContent(`<!DOCTYPE html><html><head></head><body>
  <aside data-slot="sidebar"><a id="brand">DSH</a></aside>
  <main id="conversation">
    <div data-chat-turn="1" data-chat-flow-kind="assistant-step" id="a1"><p>你好</p></div>
    <div data-chat-turn="2" data-chat-flow-kind="assistant-step" id="a2"><p>在</p></div>
    <div data-chat-turn="3" id="u1"><p>用户消息</p></div>
  </main>
</body></html>`)

const report = await page.evaluate(async (code) => {
  const out = { steps: [], slots: [], errors: [] }

  /* React 替身：只保证 console.error / createElement 不炸 */
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    cloneElement: (el) => el,
    isValidElement: () => true,
    Fragment: Symbol.for('f'),
    StrictMode: Symbol.for('s'),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useReducer: (r, v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useInsertionEffect: () => {},
    useMemo: (f) => (typeof f === 'function' ? f() : undefined),
    useCallback: (f) => f,
    useRef: (v) => ({ current: v }),
    useContext: (c) => c?._currentValue,
    createContext: (v) => ({ Provider: v, Consumer: v, _currentValue: v }),
    memo: (c) => c,
    forwardRef: (c) => c,
    useSyncExternalStore: (_s, g) => (typeof g === 'function' ? g() : undefined),
    useId: () => 'r1',
    Children: { map: (c, f) => (Array.isArray(c) ? c.map(f) : []), toArray: (c) => (Array.isArray(c) ? c : [c]), forEach: (c, f) => (Array.isArray(c) ? c.forEach(f) : f(c, 0)), count: (c) => (Array.isArray(c) ? c.length : c == null ? 0 : 1) },
  }

  let spec = null
  window.__ModuleLoader__ = { load: (m) => { spec = m } }
  const origError = console.error
  console.error = (...a) => { out.errors.push(a.map(String).join(' ')) }

  try {
    /* 必须用间接 eval：DSH 是在全局作用域里执行 bundle 的，
       桌宠的 Cubism Core 用 var 声明，换成 new Function 就变成函数局部变量，
       pixi 那边就找不到运行时报错（这个坑踩过一次）。 */
    ;(0, eval)(code)
    out.steps.push('client.js 执行完成')
  } catch (e) {
    out.errors.push('顶层抛错：' + e.message)
    console.error = origError
    return out
  }
  if (!spec) { out.errors.push('没有注册模块'); console.error = origError; return out }
  out.steps.push('注册 id=' + spec.id)

  const requireShim = (name) => {
    if (name === 'react') return React
    if (name === 'react-dom' || name === 'react-dom/client') return { createPortal: (c) => c }
    throw new Error('no module ' + name)
  }

  const ctx = {
    slots: {
      inject(name, fn) { out.slots.push(name); try { fn() } catch (e) { out.errors.push('slot ' + name + ': ' + e.message) } },
      register() { return { dispose() {} } },
    },
    theme: { register: () => ({ dispose() {} }), overrideTokens: () => ({ dispose() {} }) },
    locale: { register: () => ({ dispose() {} }) },
    effect(fn) { try { fn() } catch (e) { out.errors.push('effect: ' + e.message) } },
    get(k) { return this[k] },
    logger: { info() {}, warn() {}, error() {} },
    on() {}, emit() {}, emitAsync() {}, plugin() {},
  }

  let plugin = null
  try {
    plugin = spec.factory(requireShim)
    out.steps.push('factory 返回 inject=' + JSON.stringify(plugin.inject))
  } catch (e) {
    out.errors.push('factory 抛错：' + e.message)
    console.error = origError
    return out
  }

  try {
    plugin.apply(ctx)
    out.steps.push('apply 完成')
  } catch (e) {
    out.errors.push('apply 抛错：' + e.message)
  }

  await new Promise((r) => setTimeout(r, 400))

  /* 拿实际结果 */
  const a1 = document.getElementById('a1')
  const u1 = document.getElementById('u1')
  const styleTags = [...document.querySelectorAll('style')]
  out.dom = {
    styleCount: styleTags.length,
    styleIds: styleTags.map((s) => s.id || '(anon)').slice(0, 12),
    a1HasAvatarClass: a1.classList.contains('yuno-av-on'),
    u1HasAvatarClass: u1.classList.contains('yuno-av-on'),
    avatarBeforeContent: getComputedStyle(a1, '::before').content,
    avatarBeforeWidth: getComputedStyle(a1, '::before').width,
    tokenBv: getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-brand-primary').trim(),
    canvasCount: document.querySelectorAll('canvas').length,
    bodyChildren: document.body.children.length,
  }
  console.error = origError
  return out
}, src)

console.log(JSON.stringify(report, null, 2))
await browser.close()

const d = report.dom || {}
const checks = [
  ['注册 id 是包名', (report.steps || []).some((s) => s.includes('dsh-yunoseek'))],
  ['apply 完成', (report.steps || []).includes('apply 完成')],
  ['注入了样式节点', (d.styleCount || 0) > 0],
  ['助手消息有头像标记', d.a1HasAvatarClass === true],
  ['用户消息没有头像', d.u1HasAvatarClass === false],
  ['头像伪元素有内容', d.avatarBeforeContent && d.avatarBeforeContent !== 'none'],
  ['挂上了 10 个以上槽位', (report.slots || []).length >= 10],
]
let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failed++
}
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项没过（errors: ${(report.errors || []).slice(0, 3).join(' | ')}）`)
process.exit(failed === 0 ? 0 : 1)