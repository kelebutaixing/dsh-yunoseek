// 判断 HarmonyOS Sans SC 是单字重还是可变字重：同段文字不同 font-weight 的宽度/像素是否变化。
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const { chromium } = await import(pathToFileURL('D:/gzq1/dsh-bili-coin/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.mjs').href)
const root = fileURLToPath(new URL('..', import.meta.url))
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
const page = await browser.newPage({ viewport: { width: 900, height: 400 }, deviceScaleFactor: 2 })
await page.setContent(`<!doctype html><html><body style="margin:0;background:#111;color:#fff;padding:14px;font-family:'HarmonyOS Sans SC'">
<div id="a" style="font-size:28px;font-weight:300">千石由乃 HarmonyOS 400</div>
<div id="b" style="font-size:28px;font-weight:400">千石由乃 HarmonyOS 400</div>
<div id="c" style="font-size:28px;font-weight:700">千石由乃 HarmonyOS 400</div>
<div id="d" style="font-size:28px;font-weight:400;font-variation-settings:'wght' 300">千石由乃 HarmonyOS 400</div>
<div id="e" style="font-size:28px;font-weight:400;font-variation-settings:'wght' 700">千石由乃 HarmonyOS 400</div>
</body></html>`)
await page.waitForTimeout(300)
const res = await page.evaluate(() => {
  const w = (id) => document.getElementById(id).getBoundingClientRect().width
  const supports = typeof CSS !== 'undefined' && CSS.supports && CSS.supports('font-variation-settings', '"wght" 500')
  return { w300: w('a'), w400: w('b'), w700: w('c'), var300: w('d'), var700: w('e'), supportsVar: supports }
})
console.log(JSON.stringify(res, null, 2))
await page.screenshot({ path: join(root, '.tmp-ui', 'font-weight.png') })
await browser.close()