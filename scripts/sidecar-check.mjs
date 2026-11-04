/**
 * Sidecar 协议冒烟测试
 *
 * 直接以子进程方式启动 Rust 后端，走 DBX Plugin Protocol v1（JSON-RPC over stdin/stdout），
 * 验证握手、数据库迁移、设置读写与文件系统浏览，不依赖 DBX 宿主。
 *
 * 用法：
 *   node scripts/sidecar-check.mjs                 # 自动在 backend/target 下找 debug/release 产物
 *   node scripts/sidecar-check.mjs --bin <path>    # 指定后端可执行文件
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))

function findBinary() {
  const index = args.indexOf('--bin')
  if (index >= 0 && args[index + 1]) return resolve(args[index + 1])
  const candidates = [
    // release 优先：debug 目录里常留着很久以前编译的产物，会拿旧版本号误导判断
    join(root, 'backend/target/release/backend.exe'),
    join(root, 'backend/target/debug/backend.exe'),
    join(root, 'backend/target/release/backend'),
    join(root, 'backend/target/debug/backend'),
  ]
  const found = candidates.find((path) => existsSync(path))
  if (!found) {
    console.error('找不到后端可执行文件，请先运行 npm run backend:dev 或 --bin 指定路径')
    process.exit(2)
  }
  return found
}

const binary = findBinary()
const dataDir = mkdtempSync(join(tmpdir(), 'dbx-mail-check-'))
const child = spawn(binary, [], {
  env: { ...process.env, DBX_PLUGIN_DATA_DIR: dataDir, RUST_BACKTRACE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = ''
const pending = new Map()
let nextId = 1
const failures = []

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf('\n')
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) handle(line)
    newline = buffer.indexOf('\n')
  }
})

child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => process.stderr.write(`[backend] ${chunk}`))

function handle(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    failures.push(`后端输出了非 JSON 内容：${line.slice(0, 120)}`)
    return
  }
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  if (message.error) entry.reject(new Error(message.error.message))
  else entry.resolve(message.result)
}

function call(method, params = {}, timeoutMs = 15000) {
  const id = nextId++
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectPromise(new Error(`${method} 超时`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      reject: (error) => {
        clearTimeout(timer)
        rejectPromise(error)
      },
    })
    child.stdin.write(`${payload}\n`)
  })
}

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures.push(`${name}${detail ? `：${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? `：${detail}` : ''}`)
  }
}

try {
  console.log(`后端：${binary}`)
  console.log(`数据目录：${dataDir}`)

  const init = await call('plugin/initialize', {
    host: { protocolVersions: [1], name: 'sidecar-check' },
  })
  check('握手返回协议版本 1', init?.protocolVersion === 1, JSON.stringify(init))
  check('插件标识与清单一致', init?.plugin?.id === manifest.id, init?.plugin?.id)
  check(
    `插件版本与清单一致（${manifest.version}）`,
    init?.plugin?.version === manifest.version,
    init?.plugin?.version,
  )

  const ping = await call('ping')
  check('ping', ping?.ok === true)

  const boot = await call('app/bootstrap')
  check('bootstrap 返回账户列表', Array.isArray(boot?.accounts))
  check('bootstrap 返回默认设置', boot?.settings?.pageSize === 60, JSON.stringify(boot?.settings))
  check('bootstrap 返回密码保管方式', ['keyring', 'local'].includes(boot?.vault), boot?.vault)

  const presets = await call('account/presets')
  check('账户预设包含 Gmail', presets?.items?.some((item) => item.key === 'gmail'))

  const saved = await call('settings/set', { settings: { ...boot.settings, theme: 'dark', undoDelay: 20 } })
  check('设置写入', saved?.settings?.theme === 'dark' && saved?.settings?.undoDelay === 20)

  const reloaded = await call('settings/get')
  check('设置持久化', reloaded?.settings?.theme === 'dark' && reloaded?.settings?.undoDelay === 20)

  const dirs = await call('fs/dirs', {})
  check('目录浏览返回快捷入口', Array.isArray(dirs?.shortcuts) && dirs.shortcuts.length > 0)

  const defaultDir = await call('fs/defaultDir')
  check('默认导出目录存在', typeof defaultDir?.path === 'string' && defaultDir.path.length > 0)

  const list = await call('mail/list', { role: 'inbox', limit: 20 })
  check('空邮箱列表可查询', Array.isArray(list?.items) && list.items.length === 0)

  const outbox = await call('outbox/list')
  check('发件箱可查询', Array.isArray(outbox?.items))

  const unknown = await call('not/a/method').then(
    () => null,
    (error) => error,
  )
  check('未知方法返回错误', unknown instanceof Error && /未实现/.test(unknown.message), String(unknown))
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
} finally {
  child.stdin.end()
  setTimeout(() => {
    child.kill()
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响结果 */
    }
    if (failures.length > 0) {
      console.error('\n失败项：')
      for (const item of failures) console.error(` - ${item}`)
      process.exit(1)
    }
    console.log('\n全部通过')
    process.exit(0)
  }, 500)
}
