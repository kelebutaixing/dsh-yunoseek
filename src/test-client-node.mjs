/**
 * 在 Node 的 vm 沙箱里把 client.js 跑一遍（模拟浏览器 __ModuleLoader__）：
 *   1. 顶层代码（含桌宠的 Cubism Core + IIFE）能执行完；
 *   2. 只注册一个模块，id 必须等于包名；
 *   3. factory 能返回 { inject, apply }，inject 是四份的并集；
 *   4. 四个部件的 factory 都不抛（各自 init 成功）。
 *
 * 用法：node src/test-client-node.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const PROFILE = 'C:/Users/可乐不太行/.dsh/profiles/desktop'
const req = createRequire(PROFILE + '/package.json')
const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const registry = new Map()
const logs = []
const styleNodes = []

const fakeEl = () => ({
  style: {},
  dataset: {},
  classList: { add() {}, remove() {}, contains: () => false },
  setAttribute() {},
  getAttribute: () => null,
  appendChild() {},
  append() {},
  remove() {},
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  getContext: () => null,
  textContent: '',
})

const sandbox = {
  console: {
    log: (...a) => logs.push(a.join(' ')),
    warn: (...a) => logs.push('warn: ' + a.join(' ')),
    error: (...a) => logs.push('error: ' + a.join(' ')),
    info: (...a) => logs.push(a.join(' ')),
    debug: () => {},
  },
  setTimeout, clearTimeout, setInterval, clearInterval, performance,
  location: { protocol: 'http:', hostname: '127.0.0.1', href: 'http://127.0.0.1/', origin: 'http://127.0.0.1', search: '' },
  navigator: { userAgent: 'node-vm', language: 'zh-CN', languages: ['zh-CN'] },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: {
    createElement: (tag) => {
      const el = fakeEl()
      el.tagName = String(tag).toUpperCase()
      if (String(tag).toLowerCase() === 'style') styleNodes.push(el)
      return el
    },
    createElementNS: () => fakeEl(),
    head: { append() {}, appendChild() {}, insertBefore() {} },
    body: { append() {}, appendChild() {}, insertBefore() {}, classList: { add() {}, remove() {} } },
    documentElement: { dataset: {}, style: {}, classList: { add() {}, remove() {} } },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  },
  fetch: () => Promise.reject(new Error('no fetch in vm')),
  MutationObserver: class { observe() {} disconnect() {} },
  IntersectionObserver: class { observe() {} disconnect() {} },
  ResizeObserver: class { observe() {} disconnect() {} },
  AudioContext: class { createBufferSource() { return {} } createGain() { return {} } decodeAudioData() {} },
  HTMLMediaElement: class {},
  requestAnimationFrame: (fn) => setTimeout(fn, 16),
  cancelAnimationFrame: (id) => clearTimeout(id),
  URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, Blob, Response, Headers,
}
sandbox.window = sandbox
sandbox.self = sandbox
sandbox.globalThis = sandbox
sandbox.window.__ModuleLoader__ = { load: (mod) => registry.set(mod.id, mod) }
sandbox.window.addEventListener = () => {}

let failed = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}

const context = vm.createContext(sandbox)
try {
  vm.runInContext(code, context, { filename: 'dsh-yunoseek/client.js' })
  check(true, '顶层代码执行')
} catch (e) {
  check(false, '顶层代码执行', e && (e.stack || e.message))
  process.exit(1)
}

check(registry.size === 1, '只注册一个模块', [...registry.keys()].join(','))
check(registry.has('dsh-yunoseek'), '模块 id = 包名')

/* 幂等：HMR / 重新组合会把 bundle 再执行一次，顶层不能有会撞「重复声明」的 const/let */
try {
  vm.runInContext(code, context, { filename: 'dsh-yunoseek/client.js#2' })
  check(true, '重复执行不抛（幂等）')
} catch (e) {
  check(false, '重复执行不抛（幂等）', e && e.message)
}

const spec = registry.get('dsh-yunoseek')
/* 宿主里没有可 require 的 react（客户端 bundle 自带一份），这里给个够用的替身：
   只为验证「apply 能跑完、槽位挂上」，不做真渲染。 */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  cloneElement: (el) => el,
  isValidElement: () => true,
  Fragment: Symbol.for('react.fragment'),
  StrictMode: Symbol.for('react.strict_mode'),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useReducer: (r, init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useInsertionEffect: () => {},
  useMemo: (fn) => (typeof fn === 'function' ? fn() : undefined),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  useContext: (c) => (c && c._currentValue),
  createContext: (v) => ({ Provider: v, Consumer: v, _currentValue: v }),
  memo: (c) => c,
  forwardRef: (c) => c,
  useSyncExternalStore: (_sub, getSnapshot) => (typeof getSnapshot === 'function' ? getSnapshot() : undefined),
  useId: () => 'r1',
  Children: {
    map: (c, fn) => (Array.isArray(c) ? c.map(fn) : c == null ? [] : [fn(c, 0)]),
    toArray: (c) => (Array.isArray(c) ? c : c == null ? [] : [c]),
    forEach: (c, fn) => (Array.isArray(c) ? c.forEach(fn) : c != null && fn(c, 0)),
    count: (c) => (Array.isArray(c) ? c.length : c == null ? 0 : 1),
  },
}
const ReactDOMStub = { createPortal: (c) => c, render: () => {}, createRoot: () => ({ render() {}, unmount() {} }) }

const requireShim = (name) => {
  if (name === 'react') return ReactStub
  if (name === 'react-dom' || name === 'react-dom/client') return ReactDOMStub
  try {
    return req(name)
  } catch (e) {
    throw new Error(`require("${name}") 失败：${e.message}`)
  }
}

let plugin = null
try {
  plugin = spec.factory(requireShim)
  check(true, 'factory 返回')
} catch (e) {
  check(false, 'factory 返回', e && e.message)
  process.exit(1)
}

check(plugin && typeof plugin.apply === 'function', '有 apply')
const inject = plugin?.inject || []
console.log('    inject =', JSON.stringify(inject))
check(inject.includes('slots'), 'inject 含 slots')
check(inject.includes('theme'), 'inject 含 theme（主题那半）')

/* 启动痕迹：每个部件都会往 ctx 上挂东西，数一数谁来了 */
const touched = { slots: [], effects: [], routes: [], listeners: [] }
const ctx = {
  slots: {
    inject(name, fn) {
      touched.slots.push(name)
      try { fn() } catch { /* 部件自己的问题 */ }
    },
    register(spec) { return { dispose() {} } },
  },
  theme: {
    register: () => ({ dispose() {} }),
    overrideTokens: () => ({ dispose() {} }),
    tokens: () => ({ dispose() {} }),
  },
  locale: { register: () => ({ dispose() {} }), extend: () => ({ dispose() {} }) },
  effect(fn, label) {
    touched.effects.push(label || '')
    try { fn() } catch { /* 忽略 */ }
  },
  get(key) { return this[key] },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  on() {}, emit() {}, emitAsync() {},
  plugin() {},
}

try {
  plugin.apply(ctx)
  check(true, 'apply 不抛')
} catch (e) {
  check(false, 'apply 不抛', e && e.message)
}

const slotNames = new Set(touched.slots)
console.log('    slots =', [...slotNames].join(', '))
check(slotNames.size >= 5, '至少挂了 5 个插槽', String(slotNames.size))
check([...slotNames].some((n) => n.includes('composer.dock')), '主题的调音台槽挂上了')
check([...slotNames].some((n) => n.includes('assistant-actions')), '语音的朗读按钮槽挂上了')
check([...slotNames].some((n) => n.includes('settings.section')), '设置页槽挂上了')
check(styleNodes.length >= 1 || touched.effects.length >= 1, '有副作用（样式/清理）')

const bad = logs.filter((l) => l.startsWith('error:') || l.startsWith('warn:'))
check(bad.length === 0, '没有 error/warn', bad.slice(0, 3).join(' | '))

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项没过`)
process.exit(failed === 0 ? 0 : 1)