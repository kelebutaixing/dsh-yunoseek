/**
 * 在 clean 实例里检查主题的构件到底有没有渲染出来。
 * 用法：node src/inspect-clean.mjs <token>
 */
import { chromium } from 'file:///D:/gzq1/dsh-bili-coin/node_modules/playwright-core/index.mjs'

const token = process.argv[2]
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(`http://127.0.0.1:18080/?token=${token}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(6000)
const btn = page.locator('text="继续"').first()
if (await btn.count()) { await btn.click().catch(() => {}); await page.waitForTimeout(1500) }

const report = await page.evaluate(() => {
  const all = [...document.querySelectorAll('*')]
  const yunoish = all.filter((el) => {
    const c = (el.className && typeof el.className === 'string') ? el.className : ''
    const d = [...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => a.name + '=' + a.value).join(' ')
    return /yuno|shimmer|mixer|live-?bar|overlay/i.test(c) || /yuno/i.test(d)
  })
  return {
    total: all.length,
    yunoCount: yunoish.length,
    sample: yunoish.slice(0, 25).map((el) => {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        tag: el.tagName.toLowerCase(),
        cls: String(el.className).slice(0, 60),
        box: `${Math.round(r.width)}x${Math.round(r.height)}`,
        visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
        bg: cs.backgroundColor,
      }
    }),
    themeVars: ['--dsw-alias-brand-primary', '--dsw-specific-bubble', '--dsw-alias-bg-base'].map((v) => v + '=' + getComputedStyle(document.documentElement).getPropertyValue(v).trim()),
    htmlClass: document.documentElement.className,
    htmlData: [...document.documentElement.attributes].filter((a) => a.name.startsWith('data-')).map((a) => a.name + '=' + a.value).join(' '),
  }
})
console.log(JSON.stringify(report, null, 2))
await browser.close()