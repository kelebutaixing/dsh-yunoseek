// 验证 hero 大标题那套写法：::before + attr() + 透明描边 + background-clip:text。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const { chromium } = await import(pathToFileURL('D:/gzq1/dsh-bili-coin/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.mjs').href)
const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, '.tmp-ui')
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
const page = await browser.newPage({ viewport: { width: 720, height: 300 }, deviceScaleFactor: 3 })
await page.setContent(`<!doctype html><html><body style="margin:0;background:#140c22;display:grid;place-items:center;height:100vh;font-family:'Microsoft YaHei'">
<style>
.hero{position:relative;font-size:44px;line-height:1.2;font-weight:800;letter-spacing:.01em;
  background-image:linear-gradient(100deg,#ff9ec8,#ff3d7f 46%,#8f6bff 88%);
  -webkit-background-clip:text;background-clip:text;
  color:transparent;-webkit-text-fill-color:transparent}
.hero::before{content:attr(data-yuno-text);position:absolute;left:0;top:0;
  background-image:linear-gradient(100deg,#ff9ec8,#ff3d7f 46%,#8f6bff 88%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  -webkit-text-stroke:1.4px transparent;pointer-events:none;white-space:nowrap}
</style>
<div class="hero" data-yuno-text="千问豆乃包">千问豆乃包</div>
</body></html>`)
await page.waitForTimeout(300)
await page.screenshot({ path: join(out, 'hero-stroke.png') })
await browser.close()
console.log('->', join(out, 'hero-stroke.png'))