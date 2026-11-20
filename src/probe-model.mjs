/**
 * 点开 clean 实例的「请选择模型」下拉，看它到底能不能选到模型。
 * 用法：node src/probe-model.mjs <token>
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
const cont = page.locator('text="继续"').first()
if (await cont.count()) { await cont.click().catch(() => {}); await page.waitForTimeout(1200) }

const trigger = page.locator('text="请选择模型"').first()
console.log('找到触发按钮：', await trigger.count())
if (await trigger.count()) {
  await trigger.click({ timeout: 5000 }).catch((e) => console.log('点击失败：' + e.message.slice(0, 80)))
  await page.waitForTimeout(2000)
  await page.screenshot({ path: 'D:/gzq1/.tmp-clean/07-model-dropdown.png' })
  const items = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('[role="menuitem"], [role="option"], li, button')) {
      const t = (el.textContent || '').trim()
      if (t && t.length < 60 && /deepseek|glm|kimi|qwen|minimax|claude|gpt|模型|flash|pro|max/i.test(t)) out.push(t)
    }
    return [...new Set(out)].slice(0, 30)
  })
  console.log('下拉里能看到的：', JSON.stringify(items, null, 2))
}
await browser.close()