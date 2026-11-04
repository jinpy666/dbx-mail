/**
 * 注入回归脚本
 *
 * 目的：确认一封恶意邮件在两条路径上都不会执行脚本——
 *   1) 阅读器：prepareMailBody → DOMPurify → dangerouslySetInnerHTML
 *   2) 回复引用：sanitizeComposerHtml → contentEditable.innerHTML
 * 判定标准是「载荷有没有真的跑起来」：样例里每条载荷都会写 window.__dbxXss，
 * 只要它出现就说明净化被绕过，比单纯数标签可靠。
 *
 * 依赖：先执行 npm run build（脚本 serve 的是 ui/ 构建产物），
 *      以及本机 chromium（playwright-core）。
 * 用法：node scripts/sanitize-check.mjs
 * 退出码：0 全部通过；1 有断言失败。
 */
import { chromium, executablePath } from './browser.mjs'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../ui/', import.meta.url)).replace(/[\\/]+$/, '')
const ROOT_POSIX = ROOT.replace(/\\/g, '/')
const PORT = 4174
const EXE = executablePath
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

const failures = []
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL  ${name}  ${detail === undefined ? '' : JSON.stringify(detail)}`)
  }
}

/* ---------- 静态服务：只读 ui/，不做目录穿越 ---------- */
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent((request.url ?? '/').split('?')[0])
  const relative = normalize(pathname).replace(/^([/\\])+/, '') || 'index.html'
  const file = join(ROOT, relative)
  // Windows 下 join 返回反斜杠路径，两边统一成 / 再比前缀，避免误判成目录穿越
  if (!file.replace(/\\/g, '/').startsWith(`${ROOT_POSIX}/`)) {
    response.writeHead(403).end('forbidden')
    return
  }
  try {
    const body = await readFile(file)
    response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    response.end(body)
  } catch {
    response.writeHead(404).end('not found')
  }
})
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))
console.log(`静态服务已启动：http://127.0.0.1:${PORT}`)

const browser = await chromium.launch({ executablePath: EXE })
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } })
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push(String(error)))
page.on('response', (response) => {
  if (response.status() >= 400) console.log(`  HTTP ${response.status()} ${response.url()}`)
})

await page.goto(`http://127.0.0.1:${PORT}/index.html?demo=1&evil=1`, { waitUntil: 'networkidle' })
const row = page.locator('.thread-row').filter({ hasText: '安全回归' }).first()
await row.waitFor({ state: 'attached', timeout: 20000 })
await row.click({ force: true })
await page.waitForTimeout(1500)

/** 统计一个容器里的危险节点与事件属性 */
const inspect = (selector) =>
  page.evaluate((sel) => {
    const container = document.querySelector(sel)
    if (!container) return { missing: true }
    const elements = Array.from(container.querySelectorAll('*'))
    return {
      missing: false,
      xss: window.__dbxXss ?? null,
      dangerous: container.querySelectorAll('iframe, object, embed, script, form').length,
      handlerAttrs: elements.filter((element) =>
        Array.from(element.attributes).some((attribute) => attribute.name.toLowerCase().startsWith('on')),
      ).length,
      jsHref: elements.filter((element) =>
        (element.getAttribute('href') ?? '').trim().toLowerCase().startsWith('javascript:'),
      ).length,
      remoteImgs: Array.from(container.querySelectorAll('img')).filter((image) =>
        /^(https?:)?\/\//i.test(image.getAttribute('src') ?? ''),
      ).length,
      remoteStyleUrls: elements.filter((element) =>
        /url\(\s*['"]?\s*https?:/i.test(element.getAttribute('style') ?? ''),
      ).length,
      placeholders: (container.textContent ?? '').match(/\[图片/g)?.length ?? 0,
      hasBlockquote: Boolean(container.querySelector('blockquote')),
    }
  }, selector)

console.log('\n[1] 阅读器路径（.mail-html）')
const reader = await inspect('.mail-html')
check('阅读器已渲染', !reader.missing, reader)
if (!reader.missing) {
  check('载荷未执行', reader.xss === null, reader.xss)
  check('无 iframe/object/embed/script/form', reader.dangerous === 0, reader.dangerous)
  check('无 on* 内联事件属性', reader.handlerAttrs === 0, reader.handlerAttrs)
  check('无 javascript: 链接', reader.jsHref === 0, reader.jsHref)
  check('远程图片全部被拦截（src 不指向 http）', reader.remoteImgs === 0, reader.remoteImgs)
  check('无 style 里的远程 url()', reader.remoteStyleUrls === 0, reader.remoteStyleUrls)
}

console.log('\n[2] 回复引用路径（.cmp-body）')
await page.locator('button[title="回复"]').first().click()
await page.waitForSelector('.cmp-body', { timeout: 8000 })
await page.waitForTimeout(800)
const composer = await inspect('.cmp-body')
check('撰写器已打开', !composer.missing, composer)
if (!composer.missing) {
  check('载荷未执行', composer.xss === null, composer.xss)
  check('引用块已生成', composer.hasBlockquote, composer.hasBlockquote)
  check('无 iframe/object/embed/script/form', composer.dangerous === 0, composer.dangerous)
  check('无 on* 内联事件属性', composer.handlerAttrs === 0, composer.handlerAttrs)
  check('无 javascript: 链接', composer.jsHref === 0, composer.jsHref)
  check('远程图片未进入编辑器', composer.remoteImgs === 0, composer.remoteImgs)
  check('远程图片已替换为文字占位', composer.placeholders >= 1, composer.placeholders)
  check('无 style 里的远程 url()', composer.remoteStyleUrls === 0, composer.remoteStyleUrls)
}

console.log('\n[3] 控制台')
check('无脚本错误', consoleErrors.length === 0, consoleErrors.slice(0, 3))

await browser.close()
server.close()

if (failures.length) {
  console.log(`\n结果：${failures.length} 项失败 -> ${failures.join(' / ')}`)
  process.exit(1)
}
console.log('\n结果：全部通过')
