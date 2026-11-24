/**
 * 生成可切换三套皮肤的静态预览。
 *
 * 关键：预览直接使用 theme.client.js 里那份 CSS 原文，套在一份按真实壳层
 * 类名搭的 DOM 上（sidebarCol / topStrip / panelRow / viewTabs / tab /
 * composerSeat / card / message-bubble…）。所以预览看到的就是 CSS 的实际
 * 效果，而不是另画一张示意图。
 *
 * 用法：node scripts/preview.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, '.tmp-ui')
mkdirSync(outDir, { recursive: true })

/** 从主题源里抠出 CSS 模板字符串的原文。 */
function extractCss() {
  const src = readFileSync(join(root, 'src', 'parts', 'theme.client.js'), 'utf8')
  const start = src.indexOf('const CSS = `')
  if (start === -1) throw new Error('找不到 const CSS = `')
  const bodyStart = start + 'const CSS = `'.length
  const end = src.indexOf('`;', bodyStart)
  if (end === -1) throw new Error('CSS 模板字符串没有收尾')
  let css = src.slice(bodyStart, end)
  // 主题里唯一一处插值是 logo 的 base64 data URL：换成真实文件路径。
  css = css.replace(/\$\{LOGO_SRC\}/g, pathToFileURL(join(root, 'icon.png')).href)
  return css
}

const css = extractCss().replace(
  '__YUNO_FONT_B64__',
  readFileSync(join(root, 'assets', 'fonts', 'AlimamaShuHeiTi-Bold.woff2')).toString('base64'),
)
const logo = pathToFileURL(join(root, 'icon.png')).href
const character = pathToFileURL(join(root, 'assets', 'yuno', 'character.png')).href

/* 壳层基样式：只放布局和尺寸，颜色一律交给主题 CSS。
   类名照 asar 里的 module.css 名写（前面加个假 hash 让子串匹配生效）。 */
const BASE = `
*{box-sizing:border-box}
html,body{height:100%}
/* 壳层自己声明的变量，预览里补上（真壳里由 ui-sidebar 提供） */
:root{--dsh-sidebar-row-padding:8px;--dsh-sidebar-paint-inset:0px;--dsh-workspace-indent:0px;
  /* 真壳里 ui-theme 在 body 上定义这个；预览得自己补，否则主题的 html body 规则取不到值 */
  --dsw-font-family:"Yuno ShuHeiTi","HarmonyOS Sans SC","HarmonyOS Sans",Inter,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
body{margin:0;font-family:var(--dsw-font-family);
  background:var(--dsw-alias-bg-base,#0b0417);color:var(--dsw-alias-label-primary,#f9effc);overflow:hidden}
.x_frame{position:relative;display:grid;grid-template-rows:minmax(0,1fr) auto;height:100vh;overflow:hidden}
.x_frame>.x_sidebarCol{grid-column:1;grid-row:1}
.x_frame>.x_centerCol{grid-column:2;grid-row:1}
.x_frame{grid-template-columns:264px minmax(0,1fr)}
.x_sidebarCol{min-width:0;overflow:hidden;display:flex;flex-direction:column}
.x_centerCol{min-width:0;display:flex;flex-direction:column;overflow:hidden}
.x_mainPanel{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
/* shell.overlay 那一层：z-index 20，压在内容之上——这只是鼠标穿透，不是视觉透明 */
.x_overlayLayer{position:absolute;inset:0;z-index:20;pointer-events:none}
.x_overlayLayer > *{pointer-events:auto}

/* 侧栏内部：照 SidebarRoot.module.css 的尺寸 */
.x_topStrip{flex:none;display:flex;align-items:center;justify-content:flex-end;
  height:52px;margin:-6px -14px 0;padding:0 12px 2px}
.x_logoRow{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:8px;
  height:60px;padding:8px 0 8px 8px;overflow:hidden}
.x_brand{flex:1;display:flex;align-items:center;gap:8px;min-width:0}
.x_brandMark{width:26px;height:26px;flex:none}
.x_brandName{font-weight:650;font-size:17px;letter-spacing:.01em;white-space:nowrap}
.x_iconButton{width:28px;height:28px;display:grid;place-items:center;opacity:.6}
.x_scrollRegion{flex:1;min-height:0;overflow:auto;padding:0 14px}
.x_panelList{display:flex;flex-direction:column;gap:2px;margin-bottom:8px}
.x_panelRow{display:flex;align-items:center;gap:9px;min-height:32px;
  padding:5px 8px;border:0;background:transparent;color:var(--dsw-alias-label-primary);
  font:inherit;line-height:22px;text-align:left;cursor:pointer;border-radius:8px}
.x_panelGlyph{flex:none;display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;opacity:.75}
.x_panelTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.x_newSessionRow{display:flex;padding:0 0 8px}
.x_newSession{flex:1;display:flex;align-items:center;gap:8px;height:34px;padding:0 11px;
  border:0;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer;text-align:left}
.x_regionLabel{font:600 10px/1 ui-monospace,monospace;letter-spacing:.16em;opacity:.45;
  padding:10px 10px 6px}
/* 工作区分组：_groupSection / _projectRow / _sessionRow / _title / _time */
.x_groupSection{position:relative;margin-top:10px}
.x_projectRow{display:flex;align-items:center;gap:7px;height:32px;padding:0 8px;
  cursor:pointer;font-size:13.5px}
.x_slot{flex:none;width:16px;display:inline-flex;align-items:center;justify-content:center;opacity:.6}
.x_title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.x_time{flex:none;font-size:9.5px;line-height:16px;opacity:.62}
.x_sessionRow{display:flex;align-items:center;gap:8px;height:32px;
  padding-inline-end:8px;cursor:pointer;font-size:12.5px;margin-top:1px}
.x_sessionRow:hover{background:rgba(255,255,255,.05)}
.x_footArea{flex:none;padding:10px 14px 12px;font:10px/1.6 ui-monospace,monospace;opacity:.5}

/* 会话区：照 ConversationRoot.module.css */
.x_header{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;
  align-items:center;gap:0 12px;padding:10px 18px 0;flex:none}
.x_titleRow{grid-column:1/-1;display:flex;align-items:center;gap:10px;min-height:30px}
.x_titleCluster{display:flex;align-items:center;gap:8px;min-width:0}
.x_crumbCurrent{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.x_seat{display:inline-flex;align-items:center;gap:5px;padding:2px 8px 3px;border-radius:999px;
  background:rgba(255,255,255,.07);font-size:11px}
.x_headerUtilities{margin-left:auto;display:flex;align-items:center;gap:6px}
.x_tabs{grid-column:1/-1;position:relative;display:flex;flex-wrap:wrap;gap:16px 20px;
  margin-top:10px;padding-left:8px}
.x_viewTabs{display:flex;flex-wrap:wrap;gap:32px;min-height:25px}
.x_tab{position:relative;min-height:35px;margin:-10px -10px 0;padding:10px 10px 9px;
  border:0;background:transparent;font-size:13px;line-height:16px;font-weight:500;
  color:var(--dsw-alias-label-tertiary);cursor:pointer}
.x_tab::after{content:"";position:absolute;right:10px;bottom:-1px;left:10px;height:2px;
  border-radius:2px;background:transparent}
.x_tabActive{color:var(--dsw-alias-state-business-primary)}

/* 消息区 */
.x_scrollBody{flex:1;min-height:0;overflow:auto;padding:18px 24px 8px}
.x_chatView{max-width:780px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
.x_msg{display:flex;gap:10px;align-items:flex-start}
.x_avatar{width:26px;height:26px;border-radius:50%;flex:none;background:linear-gradient(135deg,#ff9ec8,#7c5cff)}
.x_userWrap{display:flex;justify-content:flex-end}
[data-message-bubble]{position:relative;max-width:min(560px,82%);padding:11px 14px;
  font-size:13.5px;line-height:1.68;border-radius:12px;background:rgba(255,255,255,.06)}
.x_reasoning{font-size:12px;opacity:.55;padding:4px 0 0 36px}
.x_toolRow{display:flex;align-items:center;gap:8px;padding:5px 10px;border-radius:8px;
  background:rgba(255,255,255,.04);font-size:12px;opacity:.72;max-width:560px;margin-left:36px}

/* 输入区：照 ConversationRoot.composerSeat + InputBar */
.x_composerSeat{flex:none;padding:6px 24px 10px}
.x_composerStack{max-width:780px;margin:0 auto}
.x_card{position:relative;display:flex;flex-direction:column;gap:12px;width:100%;
  padding:8px 0 8px;border-radius:12px;background-color:rgba(30,16,44,.9);
  box-shadow:0 8px 30px -20px rgba(0,0,0,.8)}
.x_input{padding:6px 14px 0;font-size:14px;line-height:24px;opacity:.55}
.x_row{display:flex;align-items:center;gap:8px;padding:0 10px}
.x_tools{display:flex;align-items:center;gap:6px}
.x_add{width:26px;height:26px;border-radius:50%;border:0;background:rgba(255,255,255,.08);
  color:inherit;display:grid;place-items:center;cursor:pointer;font-size:14px}
.x_select{padding:3px 9px;border-radius:999px;background:rgba(255,255,255,.06);
  font-size:11px;opacity:.8;display:inline-flex;align-items:center;gap:5px}
.x_spacer{flex:1}
.x_primary{width:30px;height:30px;border-radius:50%;border:0;display:grid;place-items:center;
  background:#ff3d7f;color:#fff;cursor:pointer;font-size:13px}
.x_dock{display:flex;align-items:center;justify-content:center;gap:12px;padding-top:4px;
  min-height:22px;font:10px/1 ui-monospace,monospace;opacity:.7}
`

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Yuno theme — live CSS preview</title>
<style>${BASE}</style>
<style>${css}</style>
</head>
<body>
<div class="x_frame">
  <aside class="x_sidebarCol">
    <div class="x_topStrip"><span class="x_iconButton">◧</span></div>
    <div class="x_logoRow">
      <div class="x_brand">
        <img class="x_brandMark" src="${logo}" alt="">
        <span class="x_brandName dsh-yuno-brand-name"><span class="dsh-yuno-brand-name__stroke" aria-hidden="true">千问豆乃包</span><span class="dsh-yuno-brand-name__fill">千问豆乃包</span></span>
      </div>
      <span class="x_iconButton">⌕</span>
    </div>
    <div class="x_scrollRegion">
      <div class="x_newSessionRow">
        <button class="x_newSession"><span>＋</span><span>新会话</span></button>
      </div>
      <div class="x_panelList">
        <button class="x_panelRow"><span class="x_panelGlyph">▤</span><span class="x_panelTitle">插件</span></button>
        <button class="x_panelRow"><span class="x_panelGlyph">▦</span><span class="x_panelTitle">插件市场</span></button>
        <button class="x_panelRow"><span class="x_panelGlyph">◷</span><span class="x_panelTitle">自动化任务</span></button>
        <button class="x_panelRow"><span class="x_panelGlyph">◫</span><span class="x_panelTitle">上下文洞察</span></button>
        <button class="x_panelRow"><span class="x_panelGlyph">⋯</span><span class="x_panelTitle">更多</span></button>
      </div>
      <div class="x_regionLabel">工作区</div>
      <div class="x_groupSection">
        <div class="x_projectRow"><span class="x_slot">▾</span><span class="x_title">work</span></div>
        <div class="x_sessionRow"><span class="x_title">安装 dsh-deep-whale …</span><span class="x_time">4 分钟</span></div>
        <div class="x_sessionRow"><span class="x_title">自动备份文档并统计字…</span><span class="x_time">22 小时</span></div>
        <div class="x_sessionRow"><span class="x_title">列出文件并了解项目用途</span><span class="x_time">1 天</span></div>
      </div>
      <div class="x_groupSection">
        <div class="x_projectRow"><span class="x_slot">▾</span><span class="x_title">默认工作区</span></div>
        <div class="x_sessionRow selected"><span class="x_title">AI 编程助手功能简介</span><span class="x_time">1 天</span></div>
        <div class="x_sessionRow"><span class="x_title">Yuno 主题与界面改版</span><span class="x_time">1 分钟</span></div>
        <div class="x_sessionRow"><span class="x_title">改进 yuno 主题 UI 设计</span><span class="x_time">1 小时</span></div>
      </div>
      <div class="x_groupSection">
        <div class="x_projectRow"><span class="x_slot">▸</span><span class="x_title">闲聊区</span></div>
      </div>
    </div>
    <div class="x_footArea">可乐不太行</div>
  </aside>

  <section class="x_centerCol">
    <div class="x_mainPanel">
      <header class="x_header">
        <div class="x_titleRow">
          <div class="x_titleCluster">
            <span class="x_crumbCurrent">Yuno 主题与界面改版</span>
            <span class="x_seat">yuno</span>
            <span class="x_seat">2 个子智能体</span>
          </div>
          <div class="x_headerUtilities">
            <span class="x_seat">◯</span><span class="x_seat">↻</span>
          </div>
        </div>
        <div class="x_tabs">
          <div class="x_viewTabs">
            <button class="x_tab x_tabActive">对话</button>
            <button class="x_tab">轨迹</button>
            <button class="x_tab">上下文</button>
            <button class="x_tab">编队</button>
            <button class="x_tab">⋯</button>
          </div>
        </div>
      </header>

      <div class="x_scrollBody">
        <div class="x_chatView">
          <div class="x_msg">
            <span class="x_avatar"></span>
            <div data-message-bubble>三套皮肤都按真实壳层类名重画了。侧栏、tab、输入面板、消息卡全动过，不是只换颜色。</div>
          </div>
          <div class="x_reasoning">思考：先把 asar 里的 module.css 挖出来，再用真类名写选择器……</div>
          <div class="x_toolRow">⏺ yuno执行命令 npm run build</div>
          <div class="x_userWrap">
            <div data-message-bubble>这个看起来才对。再给我留一套更狠的。</div>
          </div>
        </div>
      </div>

      <div class="x_composerSeat">
        <div class="x_composerStack">
          <div class="x_card">
            <div class="x_input">写点什么，或者把下一段音源丢进来……</div>
            <div class="x_row">
              <div class="x_tools">
                <button class="x_add">＋</button>
                <span class="x_select">完全权限 ⌄</span>
              </div>
              <div class="x_spacer"></div>
              <span class="x_select">DeepSeek V4.1 Flash 1017</span>
              <button class="x_primary">↑</button>
            </div>
          </div>
          <div class="x_dock"><span>02:44 +LIVE 千石由乃 DJ&amp;Mp.</span><span>16% /// COMMENTS · 14.7M</span></div>
        </div>
      </div>
    </div>
  </section>

  <!-- 字体设置卡片（真壳里挂在 设置 → 通用，这里单独摆一份看样式） -->
  <div style="position:fixed;left:300px;top:120px;width:520px;padding:18px;border-radius:14px;background:#170d24;border:1px solid rgba(255,110,180,.28);box-shadow:0 26px 64px -30px #000">
    <div class="dsh-yuno-fontcard">
      <div class="dsh-yuno-fontcard__title">由乃 · 字体</div>
      <div class="dsh-yuno-fontcard__desc">换全局字体和字重，存在本机，重启后也在。</div>
      <label>字体</label>
      <select>
        <option>HarmonyOS Sans SC</option>
        <option>Microsoft YaHei</option>
        <option>SimSun</option>
        <option>JetBrains Mono</option>
      </select>
      <label>或直接填字体名</label>
      <input type="text" value="HarmonyOS Sans SC">
      <label>字重</label>
      <div class="dsh-yuno-fontcard__seg">
        <button type="button" style="font-weight:300">300</button>
        <button type="button" aria-pressed="true" style="font-weight:400">400</button>
        <button type="button" style="font-weight:500">500</button>
        <button type="button" style="font-weight:600">600</button>
        <button type="button" style="font-weight:700">700</button>
      </div>
      <div class="dsh-yuno-fontcard__preview">千石由乃 · DJ&amp;Mp. — 调音台还亮着，所以我还活着。 0123</div>
      <div class="dsh-yuno-fontcard__row">
        <div class="dsh-yuno-fontcard__note">若 DSH 设置里自己填了字体，那个会盖过这里。</div>
        <button type="button" class="dsh-yuno-fontcard__reset">恢复默认</button>
      </div>
    </div>
  </div>

  <!-- shell.overlay：氛围层，真实壳层里就挂在这个 z-index 20 的层里 -->
  <div class="x_overlayLayer">
    <div class="dsh-yuno-ambient" aria-hidden="true" style="pointer-events:none">
      <div class="dsh-yuno-ambient__glow dsh-yuno-ambient__glow--a"></div>
      <div class="dsh-yuno-ambient__glow dsh-yuno-ambient__glow--b"></div>
      <div class="dsh-yuno-ambient__vignette"></div>
    </div>
  </div>
</div>
</body></html>`

writeFileSync(join(outDir, 'preview.html'), html)
console.log(join(outDir, 'preview.html'), `css ${css.length} B`)