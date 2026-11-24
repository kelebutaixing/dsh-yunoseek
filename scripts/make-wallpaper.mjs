// 把原图（由乃房间）降采样成 480x270 像素底图，保留原画构图/光影/姿势。
// 用 Chrome 的高质量缩放，输出 PNG 供 build 内联。
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const { chromium } = await import(pathToFileURL('D:/gzq1/dsh-bili-coin/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.mjs').href)
const root = fileURLToPath(new URL('..', import.meta.url))
const SRC = process.argv[2] || join(root, 'assets', 'yuno', 'room-src.jpg')
const W = 480, H = 270
// 裁掉趴在桌上的由乃（原图 x<1380），保留右半：显示器+麦克风+右霓虹+空电竞椅。
const CROP = { sx: 1380, sy: 500, sw: 967, sh: 544 }
const dataUrl = 'data:image/jpeg;base64,' + readFileSync(SRC).toString('base64')
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
const page = await browser.newPage()
const b64 = await page.evaluate(async ({ src, W, H, CROP }) => {
  const img = new Image()
  img.src = src
  await img.decode()
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const g = c.getContext('2d')
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.drawImage(img, CROP.sx, CROP.sy, CROP.sw, CROP.sh, 0, 0, W, H)
  return c.toDataURL('image/png').split(',')[1]
}, { src: dataUrl, W, H, CROP })
await browser.close()
const out = join(root, 'assets', 'yuno', 'room-wallpaper.png')
mkdirSync(join(root, 'assets', 'yuno'), { recursive: true })
writeFileSync(out, Buffer.from(b64, 'base64'))
console.log('wrote', out, Buffer.from(b64, 'base64').length, 'bytes')