#!/usr/bin/env node
/**
 * DavMail 本地网关联调脚本
 *
 * 用途：不经过 DBX 宿主 UI，直接以子进程方式拉起 Rust Sidecar（DBX Plugin Protocol v1，
 * JSON-RPC over stdin/stdout），让插件后端去连本机 DavMail 网关，验证
 * 「插件 → IMAP/SMTP(127.0.0.1) → DavMail → Microsoft 365(EWS)」整条链路。
 *
 * 前置：
 *   1. DavMail 已启动且监听 IMAP/SMTP（测试配置里关掉了本地 TLS：
 *      davmail.ssl.nosecureimap=true / davmail.ssl.nosecuresmtp=true）
 *   2. Device Code 模式已在该 DavMail 实例上完成一次登录
 *   3. 本仓库已构建后端：cd backend && cargo build --release
 *
 * 用法：
 *   node scripts/davmail-check.mjs --email you@contoso.com
 *   node scripts/davmail-check.mjs --email you@contoso.com --host 127.0.0.1 --imap-port 1143 --smtp-port 1025
 *   node scripts/davmail-check.mjs --email you@contoso.com --bin backend/target/release/backend.exe --keep-data
 *
 * 参数：
 *   --email      必填，邮箱地址（同时作为 IMAP 用户名）
 *   --host       DavMail 地址，默认 127.0.0.1
 *   --imap-port  IMAP 端口，默认 1143
 *   --smtp-port  SMTP 端口，默认 1025
 *   --password   Device Code 模式下由 DavMail 自己走 OAuth，随便填，默认 device-code
 *   --bin        后端可执行文件路径，默认自动在 backend/target 下找（release 优先）
 *   --keep-data  保留临时数据目录（默认结束时删除）
 *
 * 退出码：0 全部通过；1 有断言失败；2 找不到后端；3 超时。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 解析 `--key value` 形式的命令行参数 */
function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      result[key] = next
      index += 1
    } else {
      result[key] = true
    }
  }
  return result
}

const args = parseArgs(process.argv.slice(2))
if (!args.email) {
  console.error('缺少 --email。示例：node scripts/davmail-check.mjs --email you@contoso.com')
  process.exit(2)
}

const config = {
  email: String(args.email),
  host: String(args['host'] ?? '127.0.0.1'),
  imapPort: Number(args['imap-port'] ?? 1143),
  smtpPort: Number(args['smtp-port'] ?? 1025),
  password: String(args.password ?? 'device-code'),
  keepData: Boolean(args['keep-data']),
}

/** 按平台挑选后端可执行文件名 */
function findBinary() {
  if (args.bin) return resolve(String(args.bin))
  const name = process.platform === 'win32' ? 'backend.exe' : 'backend'
  const candidates = [join(root, 'backend/target/release', name), join(root, 'backend/target/debug', name)]
  const found = candidates.find((path) => existsSync(path))
  if (!found) {
    console.error('找不到后端可执行文件，请先执行：cd backend && cargo build --release')
    process.exit(2)
  }
  return found
}

const binary = findBinary()
const dataDir = mkdtempSync(join(tmpdir(), 'dbx-mail-davmail-'))
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))

const failures = []
function check(name, condition, detail = '') {
  const suffix = detail === '' ? '' : `（${detail}）`
  if (condition) {
    console.log(`  ✓ ${name}${suffix}`)
  } else {
    failures.push(name)
    console.log(`  ✗ ${name}${suffix}`)
  }
}

/* ---------------- 启动 sidecar ---------------- */

const child = spawn(binary, [], {
  env: { ...process.env, DBX_PLUGIN_DATA_DIR: dataDir, RUST_BACKTRACE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = ''
const pending = new Map()
let nextId = 1

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf('\n')
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) settle(line)
    newline = buffer.indexOf('\n')
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => process.stderr.write(`[backend] ${chunk}`))

function settle(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    failures.push(`后端输出非 JSON：${line.slice(0, 120)}`)
    return
  }
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  if (message.error) entry.reject(new Error(message.error.message))
  else entry.resolve(message.result)
}

function call(method, params = {}, timeoutMs = 120_000) {
  const id = nextId++
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectPromise(new Error(`${method} 超时（${timeoutMs}ms）`))
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

const started = Date.now()
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`

/** 结束 sidecar 子进程，并等它真正退出（避免 Windows 上删数据目录时 EBUSY） */
function stopChild(timeoutMs = 5000) {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolvePromise()
    }, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolvePromise()
    })
    child.kill()
  })
}

async function main() {
  console.log(`后端：${binary}`)
  console.log(`数据目录：${dataDir}`)
  console.log(`网关：${config.host}:${config.imapPort}（IMAP）/ ${config.host}:${config.smtpPort}（SMTP）`)
  console.log(`账户：${config.email}\n`)

  /* 1. 握手：确认后端与清单一致 */
  console.log('[1] 后端握手')
  const init = await call('plugin/initialize', { host: { protocolVersions: [1], name: 'davmail-check' } }, 20_000)
  check('协议版本为 1', init?.protocolVersion === 1, String(init?.protocolVersion))
  check('插件标识与清单一致', init?.plugin?.id === manifest.id, String(init?.plugin?.id))

  /* 2. 连接检测：IMAP 登录 + SMTP 认证，这一步就是 DavMail 真正打 EWS 的地方 */
  console.log('\n[2] 连接检测（account/test）')
  const accountParams = {
    email: config.email,
    username: config.email,
    imapHost: config.host,
    imapPort: config.imapPort,
    imapSecurity: 'none',
    smtpHost: config.host,
    smtpPort: config.smtpPort,
    smtpSecurity: 'none',
    password: config.password,
  }
  let testLines = []
  try {
    const result = await call('account/test', accountParams, 180_000)
    testLines = Array.isArray(result?.lines) ? result.lines : []
    check('IMAP 与 SMTP 均可用', result?.ok === true, `${elapsed()}`)
    for (const line of testLines) console.log(`      · ${line}`)
  } catch (error) {
    check('IMAP 与 SMTP 均可用', false, error.message)
    console.log('      提示：Device Code 未完成登录时，这里会一直等到超时')
  }

  /* 3. 写入账户（跳过二次检测，刚才已经测过） */
  console.log('\n[3] 添加账户')
  let accountId = 0
  try {
    const added = await call('account/add', { ...accountParams, verify: false }, 60_000)
    accountId = Number(added?.account?.id ?? added?.id ?? 0)
    check('账户已写入', accountId > 0, `id=${accountId}`)
  } catch (error) {
    check('账户已写入', false, error.message)
  }

  /* 4. 发现文件夹 */
  console.log('\n[4] 文件夹发现（account/discover）')
  let inbox = null
  let folderCount = 0
  if (accountId > 0) {
    try {
      const discovered = await call('account/discover', { id: accountId }, 180_000)
      const items = Array.isArray(discovered?.items) ? discovered.items : []
      folderCount = items.length
      inbox = items.find((item) => item.role === 'inbox') ?? items[0] ?? null
      check('返回文件夹列表', folderCount > 0, `${folderCount} 个，${elapsed()}`)
      if (inbox) console.log(`      · INBOX：id=${inbox.id} name=${inbox.name}`)
    } catch (error) {
      check('返回文件夹列表', false, error.message)
    }
  }

  /* 5. 同步收件箱并读取首封邮件，证明正文确实走通了 MIME 解析 */
  console.log('\n[5] 收件箱同步（mailbox/sync + mail/list）')
  if (inbox) {
    try {
      const sync = await call('mailbox/sync', { mailboxId: inbox.id, accountId }, 300_000)
      check('同步返回结果', Boolean(sync), `${elapsed()}`)
    } catch (error) {
      check('同步返回结果', false, error.message)
    }
    try {
      const list = await call('mail/list', { mailboxId: inbox.id, kind: 'all', limit: 5 }, 60_000)
      const threads = Array.isArray(list?.items) ? list.items : []
      check('能取到会话列表', threads.length > 0, `${threads.length} 条`)
      const first = threads[0]
      if (first) {
        console.log(`      · 最新：${String(first.subject ?? '').slice(0, 48)}`)
        const detail = await call('mail/open', { id: first.id, network: false }, 90_000)
        check('能打开正文', Boolean(detail?.detail ?? detail?.subject), String(detail?.detail?.subject ?? detail?.subject ?? '').slice(0, 40))
      }
    } catch (error) {
      check('能取到会话列表', false, error.message)
    }
  } else {
    console.log('      跳过：没有可用的文件夹')
  }
}

try {
  await main()
} catch (error) {
  failures.push(`未捕获异常：${error.message}`)
} finally {
  // 先等子进程真正退出再删数据目录：Windows 上 SQLite 句柄释放有延迟，直接删会 EBUSY
  await stopChild()
  if (!config.keepData) {
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      console.log(`（临时目录未能删除，可手动清理：${dataDir}）`)
    }
  }
  console.log(config.keepData ? `\n数据目录（已保留）：${dataDir}` : '\n临时数据目录已清理')
  console.log(`耗时 ${elapsed()}`)
  if (failures.length) {
    console.log(`\n结果：${failures.length} 项失败`)
    for (const name of failures) console.log(`  - ${name}`)
    process.exit(1)
  }
  console.log('\n结果：全部通过')
}
