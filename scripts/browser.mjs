/**
 * 解析 playwright-core 与 Chromium 可执行文件。
 *
 * 这些验收脚本曾经把本机绝对路径写死在源码里（`file:///C:/Users/<user>/…`），
 * 换台机器就跑不起来，也会把用户名带进公开仓库。现在统一在这里解析：
 *
 *   PLAYWRIGHT_CORE   playwright-core 的 index.mjs 绝对路径（优先级最高）
 *   CHROMIUM_PATH     Chromium / Chrome 可执行文件绝对路径（优先级最高）
 *
 * 都没设时依次尝试：本地 `node_modules` 里的 playwright-core → 常见全局安装位置；
 * 浏览器则扫各平台的 ms-playwright 缓存目录。
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function loadPlaywright() {
  const explicit = process.env.PLAYWRIGHT_CORE
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`PLAYWRIGHT_CORE 指向的文件不存在：${explicit}`)
    return import(pathToFileURL(explicit).href)
  }
  try {
    return await import('playwright-core')
  } catch {}
  try {
    return await import('playwright')
  } catch {}
  throw new Error(
    [
      '找不到 playwright-core。二选一：',
      '  npm i -D playwright-core',
      '  PLAYWRIGHT_CORE=/绝对路径/playwright-core/index.mjs node scripts/<脚本>.mjs',
    ].join('\n'),
  )
}

const BROWSER_RELATIVE = [
  join('chrome-win', 'chrome.exe'),
  join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  join('chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  join('chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  join('chrome-linux', 'chrome'),
]

function browserRoots() {
  const roots = []
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH)
  if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'ms-playwright'))
  roots.push(join(homedir(), 'AppData', 'Local', 'ms-playwright'))
  roots.push(join(homedir(), 'Library', 'Caches', 'ms-playwright'))
  roots.push(join(homedir(), '.cache', 'ms-playwright'))
  return [...new Set(roots)]
}

export function chromiumExecutable() {
  const explicit = process.env.CHROMIUM_PATH
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`CHROMIUM_PATH 指向的文件不存在：${explicit}`)
    return explicit
  }
  for (const root of browserRoots()) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root).filter((name) => name.startsWith('chromium'))) {
      for (const relative of BROWSER_RELATIVE) {
        const candidate = join(root, entry, relative)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  throw new Error(
    [
      '找不到 Chromium。二选一：',
      '  npx playwright install chromium',
      '  CHROMIUM_PATH=/绝对路径/chrome node scripts/<脚本>.mjs',
    ].join('\n'),
  )
}

const playwright = await loadPlaywright()
export const chromium = playwright.chromium
export const executablePath = chromiumExecutable()
