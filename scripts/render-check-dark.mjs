/**
 * 深色模式检查：走真实 UI 切主题（设置 → 深色），验证邮件正文字色跟随主题
 */
import { chromium, executablePath } from './browser.mjs'
import { fileURLToPath } from 'node:url'

const exe = executablePath
const out = fileURLToPath(new URL('../screenshots/', import.meta.url))
const browser = await chromium.launch({ executablePath: exe })
const page = await browser.newPage({ viewport: { width: 1180, height: 1000 } })
await page.goto('http://127.0.0.1:4173/index.html?demo=1&rich=1', { waitUntil: 'networkidle' })
await page.getByText('Validate catalog workflow run').first().click()
await page.waitForTimeout(500)

await page.getByRole('button', { name: '设置' }).click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: '深色', exact: true }).click()
await page.waitForTimeout(400)
await page.keyboard.press('Escape')
await page.waitForTimeout(700)

await page.screenshot({ path: `${out}/rich-dark.png` })
const colors = await page.evaluate(() => {
  const mail = document.querySelector('.mail-html')
  const heading = document.querySelector('.mail-html h1')
  const card = document.querySelector('.mail-html .card')
  return {
    theme: document.documentElement.getAttribute('data-theme'),
    mailBg: mail ? getComputedStyle(mail).backgroundColor : 'none',
    mailColor: mail ? getComputedStyle(mail).color : 'none',
    h1: heading ? getComputedStyle(heading).color : 'none',
    cardBorder: card ? getComputedStyle(card).borderTopColor : 'none',
    hasMailCss: Boolean(document.querySelector('.mail-html style[data-mail-css]')),
  }
})
console.log(JSON.stringify(colors, null, 1))
await browser.close()
