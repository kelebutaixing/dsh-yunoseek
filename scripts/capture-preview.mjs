import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const { chromium } = await import(pathToFileURL('D:/gzq1/dsh-bili-coin/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.mjs').href)
const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(root, '.tmp-ui')
mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
await page.goto(pathToFileURL(join(outDir, 'preview.html')).href)
await page.waitForTimeout(400)
const file = join(outDir, 'preview.png')
await page.screenshot({ path: file, fullPage: false })
console.log('->', file)
await browser.close()