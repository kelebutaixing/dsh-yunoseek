// D 方案的宽度对比：底层用同一渐变 + 透明描边（靠 background-clip 吃到渐变）。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const { chromium } = await import(pathToFileURL('D:/gzq1/dsh-bili-coin/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.mjs').href)
const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, '.tmp-ui')
mkdirSync(out, { recursive: true })
const GRAD = 'linear-gradient(100deg,#ff9ec8,#ff3d7f 46%,#8f6bff 88%)'
const base = `position:relative;display:inline-block;font-size:32px;font-weight:800;line-height:1.25;margin:0 0 16px`
const stroke = (w) => `${base}`
const html = (w) => `
<div style="${base}">
  <span aria-hidden="true" style="position:absolute;left:0;top:0;background-image:${GRAD};-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-stroke:${w}px transparent">千问豆乃包</span>
  <span style="position:relative;background-image:${GRAD};-webkit-background-clip:text;background-clip:text;color:transparent">千问豆乃包</span>
</div>`
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
const page = await browser.newPage({ viewport: { width: 720, height: 620 }, deviceScaleFactor: 3 })
await page.setContent(`<!doctype html><html><body style="margin:0;background:#1a0e28;padding:14px 18px;font-family:'Microsoft YaHei';color:#fff">
${[0.8, 1.2, 1.6, 2.0, 2.4].map((w) => `<div style="font:11px monospace;color:#ff8fbd">stroke ${w}px</div>${html(w)}`).join('')}
</body></html>`)
await page.waitForTimeout(300)
await page.screenshot({ path: join(out, 'stroke-widths.png') })
await browser.close()
console.log('->', join(out, 'stroke-widths.png'))