/**
 * dsh-yuno-tts — 浏览器半端
 * ============================================================================
 * 做两件事：
 *   1. 「朗读」按钮：挂在每条助手回复下面（conversation.chat.assistant-actions）
 *      组件挂载 = 这条回复渲染完成 → 顺便触发自动朗读；
 *   2. 设置页：开关 / 截断字数 / 音色 / 引擎启停 / 试听。
 *
 * client bundle 不是 ESM，是自注册脚本（window.__ModuleLoader__.load）。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-yuno-tts',
  factory: (require) => {
    /* 版本标记：改完 client 重启 DSH，到「设置 → 语音」看这一行，确认真加载了新代码 */
    const BUILD = '2026-11-10T21:22'
    try { console.log('%c[yuno-tts] build ' + BUILD + ' (state-rewrite)', 'color:#e0549a') } catch { /* 忽略 */ }
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    /* 远程配对页面（局域网/隧道）上 /yuno-tts 不在 remote-web-ui 的改写前缀里，
       得自己挂到 /remote 前面才过得了门。桌面壳、file:、回环一律不动。 */
    const REMOTE_PAGE = (() => {
      const p = location.protocol
      const h = location.hostname
      if (p !== 'http:' && p !== 'https:') return false
      return !(h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1')
    })()
    const API = REMOTE_PAGE ? '/remote/yuno-tts' : '/yuno-tts'
    const asset = (u) => (REMOTE_PAGE && typeof u === 'string' && u.startsWith('/yuno-tts'))
      ? '/remote' + u
      : u
    const SEEN_KEY = 'yuno.tts.seen.v1'

    /* ------------------------------------------------------------------ *
     * 小工具
     * ------------------------------------------------------------------ */
    const readStored = (key, fallback) => {
      try {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : fallback
      } catch {
        return fallback
      }
    }
    const writeStored = (key, value) => {
      try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* 忽略 */ }
    }

    const asJson = async (res) => {
      if (res.ok) return res.json()
      let detail = ''
      try {
        const body = await res.json()
        detail = body && body.error ? '：' + body.error : ''
      } catch { /* 忽略 */ }
      throw new Error('HTTP ' + res.status + detail)
    }

    const jget = (path) => fetch(API + path, { credentials: 'same-origin' }).then(asJson)
    const jpost = (path, body) => fetch(API + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(asJson)

    /* ------------------------------------------------------------------ *
     * 播放状态（全插件一份）
     * ------------------------------------------------------------------ */
    const state = {
      enabled: true,
      autoRead: true,
      loaded: false,
      busy: false,
      speaking: false,
      error: '',
      current: '',
    }
    const subs = new Set()
    const patch = (next) => {
      Object.assign(state, next)
      subs.forEach((fn) => { try { fn() } catch { /* 忽略 */ } })
    }
    const useVoiceState = () => {
      const [, bump] = useState(0)
      useEffect(() => {
        /* 每次都要给一个新值：直接调 setState() 不传参等于 setState(undefined)，
           第二次就和上一次相等，React 会当成没变化跳过重渲染——按钮会卡在第一帧。 */
        const tick = () => bump((n) => n + 1)
        subs.add(tick)
        return () => { subs.delete(tick) }
      }, [])
      return state
    }

    let audioEl = null
    let playSeq = 0
    let audioCtx = null
    let sources = []
    let queueEnd = 0
    /* 状态只有一个真源：还有几句在合成（synthInFlight）、有没有音频真的在响。
       按钮和设置页都从 refreshVoiceState() 推导，不靠每条流程分支自己去清。 */
    let synthInFlight = 0
    let synthSince = 0

    /* 临时追踪：把状态变化写到 ~/.dsh/yuno-tts/client-trace.log。定位完了（2026-11-10 21:22 修好），改成 false，下次重启生效 */
    const TRACE = false
    function trace(ev, extra) {
      if (!TRACE) return
      try {
        fetch(API + '/trace', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            t: new Date().toISOString(), ev,
            busy: state.busy, speaking: state.speaking,
            synth: synthInFlight, src: sources.length, el: !!audioEl,
            ...(extra || {}),
          }),
        }).catch(() => {})
      } catch { /* 忽略 */ }
    }

    function ensureCtx() {
      if (!audioCtx) {
        const Ctor = window.AudioContext || window.webkitAudioContext
        audioCtx = Ctor ? new Ctor() : null
      }
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
      return audioCtx
    }

    function stopAudio() {
      for (const s of sources) { try { s.stop() } catch { /* 忽略 */ } }
      sources = []
      queueEnd = 0
    }

    /* 正在念的那条消息：给它左边的头像挂一圈光效（样式在 dsh-yuno-avatar 里） */
    let speakMarkEl = null
    function clearSpeakMark() {
      if (speakMarkEl) {
        try { speakMarkEl.classList.remove('yuno-av-voice') } catch { /* 忽略 */ }
      }
      speakMarkEl = null
    }
    function markSpeaking(origin) {
      clearSpeakMark()
      if (!origin || typeof origin.closest !== 'function') return
      let target = null
      try {
        /* 朗读按钮挂在 [data-turn-tail] 行里，和答案行不是同一个节点；
         * 先拿 turn 号，再在同 turn 的所有行里找最后一个带头像的。
         * 没有 turn 号时退回「从按钮往上找」。 */
        const turnEl = origin.closest('[data-chat-turn]')
        const turn = turnEl ? turnEl.getAttribute('data-chat-turn') : null
        const scope = origin.closest('[data-conversation-scroll]') || origin.ownerDocument || document
        if (turn !== null) {
          const rows = scope.querySelectorAll('[data-chat-turn]')
          for (const row of rows) {
            if (row.getAttribute('data-chat-turn') !== turn) continue
            if (row.classList && row.classList.contains('yuno-av-on')) target = row
            const inner = row.querySelectorAll ? row.querySelectorAll('.yuno-av-on') : []
            if (inner.length) target = inner[inner.length - 1]
          }
        }
        if (!target) {
          let node = origin.parentElement
          while (node && node !== scope.body && node !== scope.documentElement) {
            if (node.classList && node.classList.contains('yuno-av-on')) { target = node; break }
            const inner = node.querySelectorAll ? node.querySelectorAll('.yuno-av-on') : []
            if (inner.length) { target = inner[inner.length - 1]; break }
            /* 到 turn 边界就停：别越过这条消息去点亮别处的头像 */
            if (node.hasAttribute && node.hasAttribute('data-chat-turn')) break
            node = node.parentElement
          }
        }
      } catch { /* 忽略 */ }
      if (target) {
        target.classList.add('yuno-av-voice')
        speakMarkEl = target
      }
    }

    /* 状态推导：有音频在响就是「在念了」，没有但有请求在飞就是「正在合成」，
       两样都没有就是闲着。任何时候都可以调，重复结果不会重复渲染。 */
    function refreshVoiceState() {
      const speaking = sources.length > 0 || !!audioEl
      const busy = !speaking && synthInFlight > 0
      if (state.speaking !== speaking || state.busy !== busy) {
        patch({ busy, speaking })
        trace('state', { to: { busy, speaking } })
      }
    }

    function stopSpeech() {
      playSeq += 1
      synthInFlight = 0
      stopAudio()
      if (audioEl) {
        try { audioEl.pause() } catch { /* 忽略 */ }
        audioEl = null
      }
      clearSpeakMark()
      patch({ busy: false, speaking: false })
      trace('stop')
    }

    /** 排队播一段 wav：解码后按时间轴接在上一段后面，句间不留 gap */
    async function queueClip(url, token) {
      const ctx = ensureCtx()
      if (!ctx) return false
      let buf
      try {
        const res = await fetch(asset(url), { credentials: 'same-origin' })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const ab = await res.arrayBuffer()
        /* decodeAudioData 偶尔会一直不返回（Chrome 的已知坑），卡住就把合成计数吊死，
           所以给它一个上限，超时退回 <audio> 播。 */
        let decodeTimer = null
        try {
          buf = await Promise.race([
            ctx.decodeAudioData(ab),
            new Promise((_, reject) => { decodeTimer = setTimeout(() => reject(new Error('decode timeout')), 8000) }),
          ])
        } finally {
          clearTimeout(decodeTimer)
        }
      } catch { return false }
      if (token !== playSeq) return true
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      const now = ctx.currentTime
      const start = Math.max(now + 0.02, queueEnd)
      src.start(start)
      queueEnd = start + buf.duration
      sources.push(src)
      /* 以「音频真的播完」为准：sources 里没有东西了，状态就跟着回去 */
      src.onended = () => {
        const i = sources.indexOf(src)
        if (i >= 0) sources.splice(i, 1)
        if (sources.length === 0) queueEnd = 0
        if (sources.length === 0 && token === playSeq) clearSpeakMark()
        trace('src.end', { left: sources.length, token, playSeq })
        refreshVoiceState()
      }
      return true
    }

    function playClip(url, token) {
      /* 没有 Web Audio 时的兜底 */
      return new Promise((resolve) => {
        let el
        try {
          el = new Audio(asset(url))
          el.preload = 'auto'
          audioEl = el
        } catch {
          return resolve()
        }
        const done = () => {
          if (audioEl === el) audioEl = null
          refreshVoiceState()
          resolve()
        }
        el.onended = done
        el.onerror = () => {
          if (token === playSeq) patch({ error: '音频读取失败' })
          done()
        }
        const started = el.play()
        if (started && typeof started.catch === 'function') {
          started.catch((err) => {
            if (token === playSeq) patch({ error: '浏览器拦了自动播放（点一下朗读按钮试试）：' + (err?.message || err) })
            done()
          })
        }
      })
    }

    /** 把一段话切成「合成单位」：按标点切，太碎的并起来 */
    function splitChunks(text) {
      const pieces = String(text || '')
        .split(/(?<=[。！？!?；;，,、\n])/)
        .map((s) => s.trim())
        .filter(Boolean)
      const out = []
      for (const p of pieces) {
        const last = out[out.length - 1]
        if (last && (last.length + p.length) <= 28) out[out.length - 1] = last + p
        else out.push(p)
      }
      return out.length ? out : [text]
    }

    /** 回复里自带的日语稿：〔ゆの：こんにちは。〕 —— 语音只念这一段 */
    function extractSay(raw) {
      const text = String(raw || '')
      const m = /〔ゆの[：:]\s*([^〕]{1,600})〕/.exec(text)
      if (!m) return null
      const say = m[1].trim()
      if (!say) return null
      return { say, rest: text.replace(m[0], ' ').replace(/\s+/g, ' ').trim() }
    }

    async function requestSpeak(text, token, say) {
      const res = await fetch(API + '/speak', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, say }),
        signal: AbortSignal.timeout(120_000),
      })
      const data = await asJson(res)
      if (token !== playSeq) return null
      return data
    }

    async function speakText(raw, options = {}) {
      const text = String(raw || '').trim()
      if (!text) return
      if (!options.force && !state.enabled) return
      stopSpeech()
      const token = ++playSeq
      const hit = extractSay(text)
      /* 只念日语稿：没带稿就不出声，绝不拿翻译或中文音色顶上去 */
      if (!hit) return
      const spoken = hit.say
      patch({ error: '', current: spoken.slice(0, 40) })
      trace('speak.start', { force: !!options.force, len: spoken.length })

      /* 日语稿按句合成、按句排队播：第一句 1~2 秒就出声 */
      const chunks = splitChunks(spoken)
      let usedWebAudio = true
      try {
        for (let i = 0; i < chunks.length; i++) {
          if (token !== playSeq) return
          synthInFlight += 1
          if (synthInFlight === 1) synthSince = Date.now()
          refreshVoiceState()
          let data = null
          try {
            data = await requestSpeak(chunks[i], token, chunks[i])
          } catch (err) {
            if (token === playSeq) patch({ error: String(err?.message || err) })
            trace('speak.err', { msg: String(err?.message || err) })
            return
          } finally {
            synthInFlight = Math.max(0, synthInFlight - 1)
            if (synthInFlight === 0) synthSince = 0
            refreshVoiceState()
          }
          if (!data || token !== playSeq) return
          if (i === 0) markSpeaking(options.origin)
          if (usedWebAudio) {
            const ok = await queueClip(data.url, token)
            if (!ok) {
              /* 解码失败就退回 <audio> 单段播放 */
              usedWebAudio = false
              await playClip(data.url, token)
            }
          } else {
            await playClip(data.url, token)
          }
          refreshVoiceState()
        }
        /* 等最后一段播完再收尾 */
        const ctx = audioCtx
        if (ctx && queueEnd > 0) {
          const waitMs = Math.max(0, (queueEnd - ctx.currentTime) * 1000) + 150
          await new Promise((r) => setTimeout(r, waitMs))
        }
      } finally {
        /* 走到这里就说明这一轮结束了（正常、报错、被停都算），状态必须回原样 */
        trace('speak.end', { token, playSeq })
        if (token === playSeq) {
          clearSpeakMark()
          patch({ busy: false, speaking: false })
        }
      }
    }

    /* ------------------------------------------------------------------ *
     * 从聊天 DOM 里抠出「这一轮助手说的话」
     * ------------------------------------------------------------------ */
    function stripChrome(node) {
      const drop = 'pre, code, button, svg, [data-turn-tail], [data-turn-process], [data-turn-usage-details], [data-message-attachments]'
      try { node.querySelectorAll(drop).forEach((item) => item.remove()) } catch { /* 忽略 */ }
      return (node.innerText || node.textContent || '').trim()
    }

    function readMessageText(el) {
      if (!el || typeof el.closest !== 'function') return ''
      const own = el.closest('[data-chat-turn]')
      const turnId = own ? own.getAttribute('data-chat-turn') : null
      const scope =
        el.closest('[data-slot="conversation.chat.flow"]') ||
        el.closest('[data-conversation-scroll]') ||
        document.body
      let answer = null
      let step = null
      let other = null
      const items = scope.querySelectorAll('[data-chat-turn]')
      for (const item of items) {
        if (turnId !== null && item.getAttribute('data-chat-turn') !== turnId) continue
        const kind = item.getAttribute('data-chat-flow-kind')
        if (item.hasAttribute('data-turn-process-answer')) answer = item
        if (kind === 'assistant-step') step = item
        else if (kind !== 'user' && kind !== 'turn-tail' && kind !== 'turn-process' && kind !== 'boundary' && !item.querySelector('[data-turn-tail]')) other = item
      }
      const target = answer || step || other
      if (target) {
        const clone = target.cloneNode(true)
        /* 日语稿被 CSS 藏起来了（innerText 读不到），单独抠出来接在正文后面 */
        let ghosts = []
        try {
          ghosts = [...clone.querySelectorAll('.yuno-say')]
            .map((n) => String(n.textContent || '').trim())
            .filter(Boolean)
        } catch { /* 忽略 */ }
        const text = stripChrome(clone)
        const merged = ghosts.length ? (text + '\n' + ghosts.join('\n')).trim() : text
        if (merged.length > 2) return merged
      }
      const local = el.parentElement
      return local ? stripChrome(local.cloneNode(true)) : ''
    }

    /* ------------------------------------------------------------------ *
     * 自动朗读
     * ------------------------------------------------------------------ */
    const seen = new Set(readStored(SEEN_KEY, []))
    const saveSeen = () => {
      try { writeStored(SEEN_KEY, [...seen].slice(-600)) } catch { /* 忽略 */ }
    }
    const armAt = Date.now() + 2600
    let lastMountAt = 0

    function autoRead(el, messageId) {
      if (!el) return
      const now = Date.now()
      const gap = now - lastMountAt
      lastMountAt = now
      if (now < armAt) return          // 刚打开页面：历史消息不念
      if (gap < 900) { trace('auto.skip', { why: 'gap', gap }); return }
      if (!state.enabled || !state.autoRead) { trace('auto.skip', { why: 'disabled' }); return }
      /* 正在念或者正在合成时不要开新的一轮：宿主重建按钮会反复触发挂载，
         不挡的话每一轮都在上一轮播完前被停掉，看起来就是永远「正在合成」。 */
      if (state.busy || state.speaking) { trace('auto.skip', { why: 'busy' }); return }
      const text = readMessageText(el)
      if (text.length < 2) { trace('auto.skip', { why: 'empty' }); return }
      /* 去重不只认 messageId：宿主不给 id 时，同一段文字重挂载也会被认出来 */
      const key = String(messageId || ('t:' + text.slice(0, 80)))
      if (seen.has(key)) { trace('auto.skip', { why: 'seen', key: key.slice(0, 30) }); return }
      seen.add(key)
      saveSeen()
      trace('auto.read', { key: key.slice(0, 30), len: text.length })
      speakText(text, { origin: el })
    }

    /* 配置：启动时拿一次，设置页改完再同步 */
    async function pullConfig() {
      try {
        const data = await jget('/config')
        if (data && data.config) {
          patch({ enabled: data.config.enabled !== false, autoRead: data.config.autoRead !== false, loaded: true })
          return data.config
        }
      } catch { /* host 还没挂上就算了 */ }
      return null
    }

    /* ------------------------------------------------------------------ *
     * 朗读按钮（每条助手回复一个）
     * ------------------------------------------------------------------ */
    function VoiceButton(props) {
      const ref = useRef(null)
      const snap = useVoiceState()
      const messageId = props && props.messageId
      const mode = snap.busy ? 'busy' : snap.speaking ? 'play' : 'idle'

      useEffect(() => {
        const timer = setTimeout(() => autoRead(ref.current, messageId), 1200)
        return () => clearTimeout(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const onClick = useCallback(() => {
        if (snap.busy || snap.speaking) {
          stopSpeech()
          return
        }
        speakText(readMessageText(ref.current), { force: true, origin: ref.current })
      }, [snap.busy, snap.speaking])

      return h('button', {
        ref,
        type: 'button',
        className: 'ytts-btn',
        'data-state': mode,
        title: mode === 'busy' ? '正在合成…' : mode === 'play' ? '在念了（点一下停）' : '让由乃念出来',
        'aria-label': '朗读这条回复',
        onClick,
      },
      h('svg', {
        viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('path', { d: 'M4 9.5v5a1 1 0 0 0 1 1h2.6l3.6 3.1a1 1 0 0 0 1.7-.8V6.2a1 1 0 0 0-1.7-.8L7.6 8.5H5a1 1 0 0 0-1 1Z' }),
      h('path', { d: 'M16 8.6a4.6 4.6 0 0 1 0 6.8' }),
      h('path', { d: 'M18.8 6a8 8 0 0 1 0 12' })),
      )
    }

    /* ------------------------------------------------------------------ *
     * 设置页
     * ------------------------------------------------------------------ */
    function Panel() {
      const snap = useVoiceState()
      const [cfg, setCfg] = useState(null)
      const [status, setStatus] = useState(null)
      const [voices, setVoices] = useState([])
      const [note, setNote] = useState('')
      const [pending, setPending] = useState('')
      const [boot, setBoot] = useState(null)

      const refresh = useCallback(async (wantVoices) => {
        try {
          const data = await jget('/status')
          setStatus(data && data.engine ? data.engine : null)
          if (data && data.config) setCfg(data.config)
        } catch (err) {
          setNote('读状态失败：' + (err?.message || err))
        }
        if (wantVoices) {
          try {
            const data = await jget('/voices')
            setVoices((data && data.voices) || [])
          } catch { /* 忽略 */ }
        }
        try {
          const b = await jget('/boot')
          if (b) setBoot(b)
        } catch { /* 忽略 */ }
      }, [])

      useEffect(() => {
        refresh(true)
        const timer = setInterval(() => refresh(false), 8000)
        return () => clearInterval(timer)
      }, [refresh])

      const save = useCallback(async (patchCfg) => {
        try {
          const data = await jpost('/config', patchCfg)
          if (data && data.config) {
            setCfg(data.config)
            patch({ enabled: data.config.enabled !== false, autoRead: data.config.autoRead !== false })
          }
          setNote('已保存')
          setTimeout(() => setNote(''), 1800)
        } catch (err) {
          setNote('保存失败：' + (err?.message || err))
        }
      }, [])

      const toggleBoot = useCallback(async (enable) => {
        try {
          const data = await jpost('/boot', { enable })
          if (data && data.ok === false) throw new Error(data.error || 'host 拒绝了')
          setBoot((prev) => ({ ...(prev || {}), enabled: !!(data && data.enabled), path: (data && data.path) || (prev && prev.path) }))
          setNote(enable ? '已加进 Windows 启动文件夹' : '已从启动文件夹移除')
          setTimeout(() => setNote(''), 1800)
        } catch (err) {
          setNote('设置开机自启失败：' + (err?.message || err))
        }
      }, [])

      const engineAction = useCallback(async (action) => {
        setPending(action)
        setNote(action === 'stop' ? '正在停引擎…' : '正在拉引擎（第一次要几十秒）…')
        try {
          await jpost('/engine', { action })
          setNote('引擎' + (action === 'stop' ? '已停止' : '就绪'))
          refresh(true)
        } catch (err) {
          setNote('引擎操作失败：' + (err?.message || err))
        } finally {
          setPending('')
        }
      }, [refresh])

      const test = useCallback(() => {
        speakText('嗯，在。这样听得清吗。有事情就说，我接着。\n〔ゆの：うん、いるよ。これで聞こえる？ なんかあったら言って、続けるから。〕', { force: true })
      }, [])

      const engine = status || null
      const engineText = !engine
        ? (snap.busy ? '正在合成…' : '读取状态…')
        : engine.ready
          ? `就绪 · ${engine.device || '?'}${engine.rtf ? ' · RTF ' + engine.rtf : ''}`
          : engine.loading
            ? '加载中…'
            : engine.error ? '出错：' + engine.error : '未就绪'

      const Row = (key, label, node, hint) => h('div', { className: 'ytts-row', key },
        h('div', { className: 'ytts-row-label' }, label, hint ? h('span', { className: 'ytts-hint' }, hint) : null),
        h('div', { className: 'ytts-row-value' }, node),
      )

      const Switch = (key, checked, onChange, disabled) => h('button', {
        key,
        type: 'button',
        className: 'ytts-switch',
        'data-on': checked ? 'on' : 'off',
        disabled: !!disabled,
        onClick: () => onChange(!checked),
      }, h('span', { className: 'ytts-switch-dot' }), checked ? '开' : '关')

      return h('div', { className: 'ytts-panel' },
        h('div', { className: 'ytts-head' },
          h('div', null,
            h('div', { className: 'ytts-title' }, '由乃的嗓子'),
            h('div', { className: 'ytts-sub' }, '本地 GPT-SoVITS · 声音留在本机，不往云上传 · build ' + BUILD),
          ),
          h('button', { type: 'button', className: 'ytts-ghost', onClick: () => refresh(true) }, '刷新'),
        ),

        h('div', { className: 'ytts-status' },
          h('span', { className: 'ytts-dot', 'data-on': engine && engine.ready ? 'on' : engine && engine.loading ? 'load' : 'off' }),
          h('span', null, '引擎：' + engineText),
          engine && engine.voice ? h('span', { className: 'ytts-dim' }, '音色 ' + String(engine.voice).split(/[\\/]/).pop()) : null,
        ),

        h('div', { className: 'ytts-card' },
          Row('enabled', '语音输出', Switch('enabled', !!(cfg && cfg.enabled), (v) => save({ enabled: v })), '总开关'),
          Row('auto', '自动朗读', Switch('auto', !!(cfg && cfg.autoRead), (v) => save({ autoRead: v })), '新回复自动念开头一段'),
          Row('chars', '一次念多少字',
            h('div', { className: 'ytts-inline' },
              h('input', {
                className: 'ytts-input', type: 'number', min: 20, max: 2000, step: 20,
                value: cfg ? cfg.maxChars : 180,
                onChange: (e) => setCfg(cfg ? { ...cfg, maxChars: Number(e.target.value) } : cfg),
                onBlur: (e) => save({ maxChars: Number(e.target.value) || 180 }),
              }),
              h('span', { className: 'ytts-dim' }, '字'),
            ),
            '超长的截断，说完不拖太久',
          ),
          Row('voice', '音色',
            h('select', {
              className: 'ytts-input ytts-select',
              value: cfg ? cfg.voice || '' : '',
              onChange: (e) => save({ voice: e.target.value }),
            },
            h('option', { value: '' }, voices.length ? '（默认：目录第一个）' : '（目录里还没有 wav）'),
            voices.map((v) => h('option', { key: v.path, value: v.path },
              v.name + (v.seconds ? ' · ' + v.seconds + 's' : '')),
            )),
            cfg ? '从 ' + (cfg.voiceDir || '(没设目录)') + ' 里找' : '',
          ),
          Row('dir', '音色目录',
            h('input', {
              className: 'ytts-input', type: 'text',
              value: cfg ? cfg.voiceDir || '' : '',
              placeholder: 'D:\\gzq1\\yuno',
              onChange: (e) => setCfg(cfg ? { ...cfg, voiceDir: e.target.value } : cfg),
              onBlur: (e) => save({ voiceDir: e.target.value }).then(() => refresh(true)),
            }),
          ),
        ),

        h('div', { className: 'ytts-card' },
          Row('autostart', '打开界面就预热引擎', Switch('autostart', !!(cfg && cfg.autoStart), (v) => save({ autoStart: v })), '占几 GB 显存，换即时响应'),
          Row('keepalive', '退出 DSH 时保留引擎',
            Switch('keepalive', !(cfg && cfg.keepAlive === false), (v) => save({ keepAlive: v })),
            cfg && cfg.keepAlive === false
              ? '关掉 DSH 会顺手停引擎，下次开软件要重新加载'
              : '关掉 DSH 不碰引擎，下次开软件直接接着用',
          ),
          Row('boot', '开机预热引擎',
            Switch('boot', !!(boot && boot.enabled), (v) => toggleBoot(v)),
            boot && boot.enabled
              ? '登录 Windows 就用隐藏窗口拉起引擎（约 2.6 GB 显存，30 秒左右就绪）'
              : '开着的话，开机登录后自动拉起引擎，第一次试听不用等',
          ),
          Row('engine', '引擎进程',
            h('div', { className: 'ytts-inline' },
              h('button', {
                type: 'button', className: 'ytts-primary', disabled: !!pending,
                onClick: () => engineAction('start'),
              }, pending === 'start' ? '启动中…' : '启动'),
              h('button', {
                type: 'button', className: 'ytts-ghost', disabled: !!pending,
                onClick: () => engineAction('stop'),
              }, '停止'),
              h('button', { type: 'button', className: 'ytts-ghost', onClick: test }, '试听'),
            ),
          ),
          Row('paths', '安装位置',
            h('div', { className: 'ytts-paths' },
              h('div', { className: 'ytts-dim' }, 'GPT-SoVITS：' + (cfg ? cfg.engineRoot : '')),
              h('div', { className: 'ytts-dim' }, 'Python：' + (cfg ? cfg.pythonPath : '')),
            ),
          ),
        ),

        note ? h('div', { className: 'ytts-note' }, note) : null,
        snap.error ? h('div', { className: 'ytts-note ytts-note--bad' }, snap.error) : null,
        snap.speaking || snap.busy
          ? h('div', { className: 'ytts-live' },
            h('span', null, snap.busy ? '正在合成…' : '在念了'),
            h('button', { type: 'button', className: 'ytts-ghost', onClick: stopSpeech }, '停'),
          )
          : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * CSS
     * ------------------------------------------------------------------ */
    const CSS = `
.yuno-say{display:none!important}
.ytts-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;
  border-radius:7px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);
  cursor:pointer;transition:color .15s,background .15s,border-color .15s}
.ytts-btn svg{width:15px;height:15px}
.ytts-btn:hover{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);
  border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent)}
.ytts-btn[data-state="busy"]{color:var(--dsw-alias-state-warn-primary);animation:ytts-blink 1.1s steps(2) infinite}
.ytts-btn[data-state="play"]{color:var(--dsw-alias-brand-primary);text-shadow:0 0 10px color-mix(in srgb,var(--dsw-alias-brand-primary) 60%,transparent)}
@keyframes ytts-blink{50%{opacity:.35}}
.ytts-panel{display:flex;flex-direction:column;gap:14px;padding:4px 2px 24px;font-size:13px;color:var(--dsw-alias-label-primary)}
.ytts-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.ytts-title{font-size:16px;font-weight:600;letter-spacing:.02em}
.ytts-sub{color:var(--dsw-alias-label-secondary);margin-top:3px;font-size:12px}
.ytts-status{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 12px;border-radius:9px;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:12px}
.ytts-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.ytts-dot[data-on="on"]{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 8px var(--dsw-alias-state-success-primary)}
.ytts-dot[data-on="load"]{background:var(--dsw-alias-state-warn-primary);animation:ytts-blink 1s steps(2) infinite}
.ytts-card{display:flex;flex-direction:column;border-radius:11px;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1);overflow:hidden}
.ytts-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:11px 14px;
  border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent)}
.ytts-row:last-child{border-bottom:none}
.ytts-row-label{display:flex;flex-direction:column;gap:2px;min-width:120px}
.ytts-hint{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.8}
.ytts-row-value{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.ytts-inline{display:flex;align-items:center;gap:8px}
.ytts-dim{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ytts-input{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);
  border-radius:7px;padding:5px 9px;font-size:12px;outline:none;min-width:72px}
.ytts-input:focus{border-color:var(--dsw-alias-brand-primary)}
input.ytts-input[type="number"]{width:86px}
input.ytts-input[type="text"]{min-width:230px;width:230px}
.ytts-select{min-width:170px}
.ytts-switch{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px}
.ytts-switch[data-on="on"]{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.ytts-switch-dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.ytts-primary{background:var(--dsw-alias-brand-primary);color:#fff;border:none;border-radius:7px;
  padding:5px 13px;font-size:12px;cursor:pointer}
.ytts-primary:disabled{opacity:.5;cursor:default}
.ytts-ghost{background:transparent;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);
  border-radius:7px;padding:4px 11px;font-size:12px;cursor:pointer}
.ytts-ghost:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.ytts-paths{display:flex;flex-direction:column;gap:2px;align-items:flex-end}
.ytts-note{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ytts-note--bad{color:var(--dsw-alias-state-error-primary)}
.ytts-live{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--dsw-alias-brand-primary)}
`

    function ensureCss() {
      if (typeof document === 'undefined') return null
      let tag = document.getElementById('yuno-tts-css')
      if (!tag) {
        tag = document.createElement('style')
        tag.id = 'yuno-tts-css'
        tag.textContent = CSS
        document.head.appendChild(tag)
      }
      return tag
    }

    /* ------------------------------------------------------------------ *
     * 装配
     * ------------------------------------------------------------------ */
    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        const styleTag = ensureCss()

        const mount = (key, spec, component) => {
          if (!slots || typeof slots.inject !== 'function') return
          try {
            slots.inject(key, () => {
              try {
                slots.register({ name: key, ...spec }, component)
              } catch (err) {
                console.error('[yuno-tts] register ' + key, err)
              }
            })
          } catch (err) {
            console.error('[yuno-tts] inject ' + key, err)
          }
        }

        mount('conversation.chat.assistant-actions', { id: 'yuno-tts-voice', order: 30, label: '朗读' }, VoiceButton)
        mount('settings.section', { id: 'yuno-tts', order: 35, label: '语音' }, Panel)

        pullConfig()

        /* 兜底：一句正常 2~5 秒就出来，45 秒还没落地就当它卡死了，把状态收回来。
           触发一次会记一条 trace，方便回头查是哪句挂的。 */
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => {
            const timer = setInterval(() => {
              if (synthInFlight > 0 && synthSince && Date.now() - synthSince > 45_000) {
                trace('watchdog', { stuck: synthInFlight })
                synthInFlight = 0
                synthSince = 0
                refreshVoiceState()
              }
            }, 1000)
            return () => { try { clearInterval(timer) } catch { /* 忽略 */ } }
          }, 'yuno-tts: 合成兜底')
        }

        /* 日语稿（〔ゆの：…〕）在页面上藏起来：只留给朗读用 */
        const GHOST_RE = /〔ゆの[：:][^〕]{1,600}〕/
        const splitGhost = (el) => {
          /* 正文和日语稿挤在同一段里：把日语稿拆成独立 span 再藏，别把正文一起藏了 */
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
          const nodes = []
          while (walker.nextNode()) nodes.push(walker.currentNode)
          for (const node of nodes) {
            const t = String(node.nodeValue || '')
            const m = GHOST_RE.exec(t)
            if (!m) continue
            const parent = node.parentNode
            if (!parent) continue
            const before = t.slice(0, m.index)
            const after = t.slice(m.index + m[0].length)
            const span = document.createElement('span')
            span.className = 'yuno-say'
            span.textContent = m[0]
            if (before) parent.insertBefore(document.createTextNode(before), node)
            parent.insertBefore(span, node)
            if (after) parent.insertBefore(document.createTextNode(after), node)
            parent.removeChild(node)
          }
        }
        const markGhost = (root) => {
          if (!root || root.nodeType !== 1) return
          const scan = []
          if (/^(P|LI|DIV|SPAN|H[1-6]|TD|BLOCKQUOTE)$/.test(root.tagName || '')) scan.push(root)
          if (root.querySelectorAll) scan.push(...root.querySelectorAll('p,li,div,span,h1,h2,h3,h4,h5,h6'))
          for (const el of scan) {
            if (el.childElementCount > 0) continue       /* 只处理叶子块 */
            const t = String(el.textContent || '')
            if (!t.includes('〔ゆの') && !t.includes('〔yuno')) continue
            if (/^\s*〔ゆの[：:][\s\S]*〕\s*$/.test(t)) {
              el.classList.add('yuno-say')                /* 整段只有日语稿：直接藏 */
            } else {
              splitGhost(el)                              /* 混着正文：拆开再藏 */
            }
          }
        }
        if (typeof MutationObserver === 'function') {
          const ob = new MutationObserver((muts) => {
            for (const m of muts) {
              /* 流式输出时文本是往已有节点里追加的（text 节点），不是新增元素，所以两种都要看 */
              const candidates = []
              if (m.type === 'characterData') {
                if (m.target && m.target.parentElement) candidates.push(m.target.parentElement)
              } else {
                for (const n of m.addedNodes) {
                  candidates.push(n.nodeType === 1 ? n : (n.parentElement || null))
                }
              }
              for (const el of candidates) {
                if (!el) continue
                if (!(el.textContent || '').includes('〔ゆの')) continue
                markGhost(el)
              }
            }
          })
          try {
            ob.observe(document.body, { childList: true, subtree: true, characterData: true })
            markGhost(document.body)
          } catch { /* 忽略 */ }
          if (typeof ctx.effect === 'function') {
            ctx.effect(() => () => { try { ob.disconnect() } catch { /* 忽略 */ } }, 'yuno-tts: 日语稿隐藏')
          }
        }

        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => {
            stopSpeech()
            try { styleTag && styleTag.remove() } catch { /* 忽略 */ }
          }, 'yuno-tts: 收尾')
        }
      },
    }
  },
})






