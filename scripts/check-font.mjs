// 确认两套字体都已被 Chrome 认出来（不是 fallback）。
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const { chromium } = await import(pathToFileURL('D:/gzq1/dsh-bili-coin/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.mjs').href)
const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, '.tmp-ui')
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
const page = await browser.newPage({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 2 })
await page.setContent(`<!doctype html><html><body style="margin:0;background:#140c22;color:#fff;padding:16px;font-size:13px">
<div style="color:#ff8fbd;font:11px monospace">阿里妈妈数黑体</div>
<div style="font-family:'阿里妈妈数黑体';font-size:30px;margin:2px 0 14px">千问豆乃包 · 由乃的生存报告 0123</div>
<div style="color:#ff8fbd;font:11px monospace">HarmonyOS Sans SC</div>
<div style="font-family:'HarmonyOS Sans SC';font-size:30px;margin:2px 0 14px">千问豆乃包 · 由乃的生存报告 0123</div>
<div style="color:#ff8fbd;font:11px monospace">fallback</div>
<div style="font-family:sans-serif;font-size:30px">千问豆乃包 · 由乃的生存报告 0123</div>
</body></html>`)
await page.waitForTimeout(300)
const res = await page.evaluate(() => {
  const mk = (fam) => {
    const s = document.createElement('span')
    s.textContent = '千问豆乃包 ABC xyz 0123'
    s.style.cssText = `position:absolute;left:-9999px;font-size:40px;font-family:"${fam}",monospace`
    document.body.appendChild(s)
    const w = s.offsetWidth
    s.remove()
    return w
  }
  const base = mk('NoSuchFontXyz')
  return { alimama: mk('阿里妈妈数黑体'), harmony: mk('HarmonyOS Sans SC'), notExist: base }
})
console.log(JSON.stringify(res, null, 2))
await page.screenshot({ path: join(out, 'fonts-two.png') })
await browser.close()