/**
 * 邮件正文的处理
 *
 * 邮件 HTML 来自外部发件人，必须先过一遍白名单清洗再插入 DOM。
 * 远程图片默认不加载：即便宿主的 CSP 允许，也会把打开动作暴露给发件人。
 * 需要显示时由本地后端代理取回，转成 data URL。
 *
 * 拦截的做法不是删掉 src —— 浏览器会给没有 src 的 <img> 画「碎图 + alt 文字」，
 * 布局立刻散掉；这里换成 1×1 透明 GIF 顶位，再用样式画占位框。
 */
import DOMPurify from 'dompurify'
import { fetchRemoteImage } from './rpc'

/** 1×1 透明 GIF（本地 data URL，不产生任何请求） */
const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
/** 占位框默认尺寸（px） */
const PLACEHOLDER_WIDTH = 46
const PLACEHOLDER_HEIGHT = 26
/** 声明尺寸不超过这个值的图按跟踪像素处理，直接隐藏 */
const TRACKING_MAX_SIZE = 2
/** 同时向代理请求的图片数 */
const IMAGE_CONCURRENCY = 4
/** style 里的远程地址 */
const CSS_URL_PATTERN = /url\(\s*(['"]?)((?:https?:)?\/\/[^'")]+)\1\s*\)/gi

let hooked = false

function installHook() {
  if (hooked) return
  hooked = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noreferrer noopener')
    }
    // 表单控件在邮件里没有意义，且会误导点击
    if (node.tagName === 'INPUT' || node.tagName === 'BUTTON' || node.tagName === 'TEXTAREA') {
      node.setAttribute('disabled', 'disabled')
    }
  })
}

/** 清洗、作用域处理后的正文 */
export interface MailBody {
  /** 已过白名单的正文 HTML */
  html: string
  /** 邮件自带（已收敛作用域）的 CSS，由调用方以 textContent 注入正文容器 */
  css: string
}

/**
 * 清洗邮件正文
 *
 * `<style>` 先整段抽出来再清洗：DOMPurify 默认把 style 连同内容一起丢弃
 * （它属于 FORBID_CONTENTS），而大量邮件把排版写在这里，丢掉就退化成无样式文本。
 * 抽出来自己收敛作用域、再以 textContent 注入，既保留排版又不可能注入标记。
 * @param dark 深色模式下把写死的颜色声明摘掉，否则深色文字落在深色底上看不见
 */
export function prepareMailBody(html: string, dark = false): MailBody {
  if (!html) return { html: '', css: '' }
  const { rest, css } = extractStyles(html)
  installHook()
  const clean = DOMPurify.sanitize(rest, {
    WHOLE_DOCUMENT: false,
    FORBID_TAGS: ['form', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'frame', 'frameset', 'style'],
    FORBID_ATTR: ['srcset', 'ping', 'onbegin', 'onend'],
    ALLOW_DATA_ATTR: true,
    ADD_ATTR: ['target'],
  })
  return { html: clean, css: scopeCss(css, dark) }
}

/** 抽出所有 `<style>` 块（不完整的标签留给清洗器丢弃） */
function extractStyles(html: string): { rest: string; css: string } {
  const blocks: string[] = []
  const rest = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_all, body: string) => {
    blocks.push(body)
    return ''
  })
  return { rest, css: blocks.join('\n') }
}

/**
 * 把邮件 CSS 的选择器全部收进正文容器
 *
 * 不清洗的话，一封写着 `body{background:#000}` 或 `a{color:red}` 的推广邮件会把
 * 整个应用改掉——`<style>` 的作用域是整篇文档，不认外层的 `.mail-html`。
 * 这里做三件事：去掉 `@import`（远程样式表等于跟踪信标）、给每条选择器加
 * `.mail-html` 前缀（`@media` / `@supports` 递归处理）、把 `position:fixed/sticky`
 * 落回文档流（否则能盖住界面）。
 */
function scopeCss(css: string, dark: boolean): string {
  if (!css.trim()) return ''
  let cleaned = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/position\s*:\s*(fixed|sticky)/gi, 'position: static')
  if (dark) {
    // 与 adaptForDark 同一策略：摘掉写死的颜色，交给主题变量
    cleaned = cleaned.replace(/(?<![\w-])(color|background|background-color|border-color)\s*:[^;}]*;?/gi, '')
  }
  return scopeBlock(cleaned)
}

/** 逐块扫描 CSS：顶层规则加前缀，可嵌套的 at-rule 递归 */
function scopeBlock(css: string): string {
  let output = ''
  let cursor = 0
  while (cursor < css.length) {
    const open = css.indexOf('{', cursor)
    if (open < 0) {
      output += css.slice(cursor)
      break
    }
    const prelude = css.slice(cursor, open).trim()
    const close = matchBrace(css, open)
    if (close < 0) break
    const body = css.slice(open + 1, close)
    if (prelude.startsWith('@')) {
      const nested = /^@(media|supports|layer|container|scope)\b/i.test(prelude)
      output += `${prelude}{${nested ? scopeBlock(body) : body}}`
    } else {
      const selector = scopeSelector(prelude)
      // 原本写给 html / body 的规则会落到容器本身，这里要摘掉拿来做页面骨架的属性
      const root = selector.split(',').every((part) => part.trim() === '.mail-html')
      output += `${selector}{${root ? stripRootLayout(body) : body}}`
    }
    cursor = close + 1
  }
  return output
}

/**
 * 摘掉容器上的骨架属性
 *
 * 营销邮件常写 `body{height:100%;overflow:hidden}`：这套规则对整页成立，落到正文容器上就变成
 * 「固定高度 + 裁掉溢出」，700px 宽的正文会被左右切掉且滚不到。字号、颜色、行高这些照旧保留。
 */
function stripRootLayout(body: string): string {
  return body.replace(
    /(?<![\w-])(height|min-height|max-height|overflow|overflow-x|overflow-y|position|display)\s*:[^;}]*;?/gi,
    '',
  )
}

/** 找到与 `open` 处 `{` 配对的 `}` */
function matchBrace(css: string, open: number): number {
  let depth = 0
  for (let index = open; index < css.length; index += 1) {
    const char = css[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** 给选择器列表逐项加 `.mail-html` 前缀（`html` / `body` / `:root` 直接替换掉） */
function scopeSelector(prelude: string): string {
  return splitSelectorList(prelude)
    .map((selector) => {
      const trimmed = selector.trim()
      if (!trimmed) return ''
      if (trimmed.startsWith('.mail-html')) return trimmed
      const stripped = trimmed.replace(/^(?:(?:html|body|:root)\s*(?:>\s*|\s+)?)+/i, '').trim()
      // 只有 html/body/:root 的选择器落到容器本身，不要退化成 `.mail-html *`
      if (!stripped) return '.mail-html'
      return `.mail-html ${stripped}`
    })
    .filter(Boolean)
    .join(', ')
}

/** 按顶层逗号切分选择器，`:is(a, b)` 这类括号里的逗号不切 */
function splitSelectorList(prelude: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < prelude.length; index += 1) {
    const char = prelude[index]
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(prelude.slice(start, index))
      start = index + 1
    }
  }
  parts.push(prelude.slice(start))
  return parts
}

/* ---------------- 远程图片策略 ---------------- */

function isRemote(url: string): boolean {
  return /^(https?:)?\/\//i.test(url.trim())
}

/**
 * 处理正文里的远程图片与 CSS 背景图
 * @param root 已插入 DOM 的容器
 * @param allow 是否已允许加载
 * @returns 仍被拦截的可见图片数量
 */
export async function applyImagePolicy(root: HTMLElement, allow: boolean): Promise<number> {
  const cache = new Map<string, string | null>()
  let blocked = 0

  const pending: Array<{ image: HTMLImageElement; url: string }> = []
  for (const image of Array.from(root.querySelectorAll('img'))) {
    const known = image.dataset.remote ?? ''
    const src = image.getAttribute('src') ?? ''
    const url = known || (isRemote(src) ? src : '')
    if (!url) {
      // 后端没转换成功的 cid: 内嵌图，同样画占位框，别留碎图
      if (src.startsWith('cid:') && !image.dataset.missing) {
        image.dataset.missing = '1'
        markMissing(image)
        blocked += 1
      }
      continue
    }
    if (!allow) {
      if (blockImage(image, url)) blocked += 1
      continue
    }
    pending.push({ image, url })
  }

  // CSS 背景图 / 老式 background 属性：同样先拦后取
  const backgrounded = Array.from(root.querySelectorAll<HTMLElement>('[style*="url("], [background]'))
  const backgroundJobs: Array<{ element: HTMLElement; urls: string[] }> = []
  for (const element of backgrounded) {
    const urls = backgroundUrls(element)
    if (!urls.length) continue
    if (!allow) {
      stripRemoteBackgrounds(element, urls)
      continue
    }
    backgroundJobs.push({ element, urls })
  }

  await mapLimit(pending, IMAGE_CONCURRENCY, async (job) => {
    const loaded = await hydrateImage(job.image, job.url, cache)
    if (!loaded) blocked += 1
  })
  await mapLimit(backgroundJobs, IMAGE_CONCURRENCY, async (job) => {
    await hydrateBackgrounds(job.element, job.urls, cache)
  })

  return blocked
}

/** 拦截一张图：透明像素顶位 + 按原始声明尺寸画占位框 */
function blockImage(image: HTMLImageElement, url: string): boolean {
  image.dataset.remote = url
  image.alt = ''
  image.removeAttribute('srcset')
  image.removeAttribute('sizes')
  image.setAttribute('src', TRANSPARENT_PIXEL)
  image.classList.remove('image-missing')
  image.classList.add('remote-blocked')

  const width = dimension(image.getAttribute('width'))
  const height = dimension(image.getAttribute('height'))
  const tracking =
    (width > 0 && width <= TRACKING_MAX_SIZE) || (height > 0 && height <= TRACKING_MAX_SIZE)
  if (tracking) {
    // 1×1 跟踪像素：留下就是个莫名其妙的框，直接隐掉
    image.dataset.tracking = '1'
    image.style.display = 'none'
    return false
  }
  delete image.dataset.tracking
  image.style.removeProperty('display')

  if (width && height) {
    image.style.width = `${width}px`
    image.style.height = `${height}px`
    image.dataset.sized = '1'
  } else if (width) {
    image.style.width = `${width}px`
    image.style.height = `${PLACEHOLDER_HEIGHT}px`
    image.dataset.sized = '1'
  } else if (height) {
    image.style.width = `${PLACEHOLDER_WIDTH}px`
    image.style.height = `${height}px`
    image.dataset.sized = '1'
  } else if (image.style.width || image.style.height) {
    // 邮件用 style="width:100%" 这类尺寸，交给 aspect-ratio 推高度
    image.style.aspectRatio = '16 / 9'
    image.dataset.ratio = '1'
  } else {
    image.style.width = `${PLACEHOLDER_WIDTH}px`
    image.style.height = `${PLACEHOLDER_HEIGHT}px`
    image.dataset.sized = '1'
  }
  return true
}

/** 取不回来（内嵌图丢失、代理拒绝）时的占位 */
function markMissing(image: HTMLImageElement): void {
  image.alt = ''
  image.setAttribute('src', TRANSPARENT_PIXEL)
  image.classList.add('image-missing')
  if (!image.style.width && !image.style.height) {
    image.style.width = `${PLACEHOLDER_WIDTH}px`
    image.style.height = `${PLACEHOLDER_HEIGHT}px`
    image.dataset.sized = '1'
  }
}

async function hydrateImage(
  image: HTMLImageElement,
  url: string,
  cache: Map<string, string | null>,
): Promise<boolean> {
  const dataUrl = await loadRemote(url, cache)
  if (!dataUrl) {
    image.classList.add('image-missing')
    image.classList.remove('remote-blocked')
    return false
  }
  // 占位时塞进去的尺寸要撤掉，否则真图被压扁
  if (image.dataset.sized) {
    image.style.removeProperty('width')
    image.style.removeProperty('height')
    delete image.dataset.sized
  }
  if (image.dataset.ratio) {
    image.style.removeProperty('aspect-ratio')
    delete image.dataset.ratio
  }
  // 跟踪像素就算放开图片也没必要占位，继续保持隐藏
  if (image.dataset.tracking !== '1') image.style.removeProperty('display')
  image.src = dataUrl
  image.dataset.remote = url
  image.classList.remove('remote-blocked', 'image-missing')
  return true
}

function backgroundUrls(element: HTMLElement): string[] {
  const urls: string[] = []
  const css = element.getAttribute('style') ?? ''
  for (const match of css.matchAll(CSS_URL_PATTERN)) {
    if (isRemote(match[2])) urls.push(match[2])
  }
  const attribute = element.getAttribute('background') ?? ''
  if (isRemote(attribute)) urls.push(attribute)
  return urls
}

function stripRemoteBackgrounds(element: HTMLElement, urls: string[]): void {
  element.dataset.bgRemote = JSON.stringify(urls)
  const css = element.getAttribute('style') ?? ''
  const kept = css
    .split(';')
    .filter((declaration) => !/url\(\s*['"]?(?:https?:)?\/\//i.test(declaration))
    .join(';')
  if (kept.replace(/[\s;]/g, '')) element.setAttribute('style', kept)
  else element.removeAttribute('style')
  element.removeAttribute('background')
}

async function hydrateBackgrounds(
  element: HTMLElement,
  urls: string[],
  cache: Map<string, string | null>,
): Promise<void> {
  const loaded: string[] = []
  for (const url of urls) {
    const dataUrl = await loadRemote(url, cache)
    if (dataUrl) loaded.push(`url("${dataUrl}")`)
  }
  delete element.dataset.bgRemote
  if (loaded.length) element.style.backgroundImage = loaded.join(', ')
}

async function loadRemote(url: string, cache: Map<string, string | null>): Promise<string | null> {
  if (cache.has(url)) return cache.get(url) ?? null
  let dataUrl: string | null = null
  try {
    const result = await fetchRemoteImage(url)
    dataUrl = result?.dataUrl || null
  } catch {
    dataUrl = null
  }
  cache.set(url, dataUrl)
  return dataUrl
}

/** 并发的上限控制，避免一屏图同时打到本地代理 */
async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const size = Math.min(Math.max(1, limit), items.length)
  const runners = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      await worker(items[index])
    }
  })
  await Promise.all(runners)
}

/** 把 width="120" / "120px" 读成数字；百分比与缺省一律当未知 */
function dimension(value: string | null): number {
  if (!value || value.includes('%')) return 0
  const size = Number.parseFloat(value)
  return Number.isFinite(size) && size > 0 ? Math.round(size) : 0
}

/** 正文里是否存在远程资源（未加载前调用） */
export function hasRemoteImages(html: string): boolean {
  if (!html) return false
  return (
    /<img[^>]+src\s*=\s*["']?\s*(?:https?:)?\/\//i.test(html) ||
    /url\(\s*['"]?\s*(?:https?:)?\/\//i.test(html) ||
    /<[^>]+\sbackground\s*=\s*["']?\s*(?:https?:)?\/\//i.test(html)
  )
}

/**
 * 深色模式适配
 *
 * 邮件正文常把文字写成 #1f1f23 之类的固定深色，直接放在深色背景上会看不见。
 * 这里只摘掉颜色类声明，保留字号、间距、边框等排版信息。
 */
export function adaptForDark(html: string): string {
  if (!html) return ''
  const template = document.createElement('template')
  template.innerHTML = html
  const styled = Array.from(template.content.querySelectorAll<HTMLElement>('[style]'))
  for (const element of styled) {
    element.style.removeProperty('color')
    element.style.removeProperty('background-color')
    element.style.removeProperty('background')
    if (!element.getAttribute('style')?.trim()) element.removeAttribute('style')
  }
  for (const font of Array.from(template.content.querySelectorAll('font[color]'))) {
    font.removeAttribute('color')
  }
  return template.innerHTML
}
