/**
 * 截 clean profile（只装 dsh-yunoseek）的完整首次体验：
 *   主界面 → 设置列表 → 语音分区 → 桌宠分区 → 新会话的预设 chip
 * 用法：node src/shot-clean.mjs <token>
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'file:///D:/gzq1/dsh-bili-coin/node_modules/playwright-core/index.mjs'

const token = process.argv[2]
const OUT = 'D:/gzq1/.tmp-clean'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 120)))

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log('  ' + name + '.png')
}
const clickText = async (text, nth = 0) => {
  const loc = page.locator(`text="${text}"`).nth(nth)
  if (await loc.count()) {
    await loc.click({ timeout: 4000 })
    return true
  }
  return false
}

await page.goto(`http://127.0.0.1:18080/?token=${token}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(6000)

/* 1. 关掉首次启动的预览版说明 */
if (await clickText('继续')) {
  await page.waitForTimeout(1200)
  console.log('  关掉预览版弹窗')
}
await page.waitForTimeout(1500)
await shot('01-home')

/* 2. 找设置入口：先试左下角账号，再试「更多」 */
let opened = false
if (await clickText('更多')) {
  await page.waitForTimeout(1200)
  await shot('02-more-menu')
  opened = await clickText('设置')
  await page.waitForTimeout(1500)
}
if (!opened) {
  const account = page.locator('text="可乐不太行"').first()
  if (await account.count()) {
    await account.click({ timeout: 4000 }).catch(() => {})
    await page.waitForTimeout(1200)
    await shot('02-account-menu')
    opened = await clickText('设置')
    await page.waitForTimeout(1500)
  }
}
if (opened) await shot('03-settings')

/* 3. 设置里点「语音」「桌宠」 */
for (const [label, name] of [['语音', '04-settings-tts'], ['桌宠', '05-settings-pet']]) {
  if (await clickText(label)) {
    await page.waitForTimeout(1800)
    await shot(name)
    await clickText('通用设置') // 回到上一层
    await page.waitForTimeout(800)
  } else {
    console.log(`  没找到「${label}」入口`)
  }
}

/* 4. 新会话 → 预设 chip */
await page.keyboard.press('Escape')
await page.waitForTimeout(800)
if (await clickText('新会话')) {
  await page.waitForTimeout(2500)
  await shot('06-new-session')
}

const seen = await page.evaluate(() => ({
  buttons: [...document.querySelectorAll('button')].map((b) => b.textContent?.trim()).filter((x) => x && x.length < 12).slice(0, 25),
}))
console.log('  可见按钮：', seen.buttons.join(' | '))

await browser.close()