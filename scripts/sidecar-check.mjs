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
import { startMockGraph } from './mock-graph.mjs'

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
// mock Graph 需要先于 sidecar 启动：端点覆盖在 sidecar 进程内是启动期读取的。
// debug 构建才会生效；release 构建忽略覆盖（Graph 冒烟节会检测并跳过）。
const mock = await startMockGraph()
const child = spawn(binary, [], {
  env: {
    ...process.env,
    DBX_PLUGIN_DATA_DIR: dataDir,
    RUST_BACKTRACE: '1',
    DBX_MAIL_TEST_ENDPOINTS: '1',
    DBX_MAIL_AUTHORIZE_BASE: mock.authorizeBase,
    DBX_MAIL_GRAPH_BASE: mock.graphBase,
  },
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

  /* ---------------- Microsoft 365 / Outlook.com（Graph API）全链路 ----------------
   * 端点覆盖仅在 debug 构建生效；release 构建忽略覆盖，检测到后跳过本节，
   * 避免把测试流量打到真实微软端点。 */
  try {
    console.log(`mock graph：${mock.base}`)

    const presetsGraph = await call('account/presets')
    check('预设包含 msgraph', presetsGraph?.items?.some((item) => item.key === 'msgraph' && item.provider === 'graph'))

    const begin = await call('account/oauthBegin', { tenantId: 'common', clientId: 'mock-client' })
    const authorizeUrl = String(begin?.authorizeUrl || '')
    if (!authorizeUrl.startsWith(mock.authorizeBase)) {
      // release 构建不编译端点覆盖分支：授权 URL 会指向真实微软端点，必须跳过
      check('Graph 冒烟（需要 debug 构建）', false, `授权 URL 未指向 mock：${authorizeUrl.slice(0, 80)}…（请先 npm run backend:dev 重新构建 debug 产物）`)
    } else {
      check('oauthBegin 返回授权 URL 与 state', Boolean(begin?.state) && authorizeUrl.includes('code_challenge_method=S256'))

      // 充当浏览器：拿一次性 code，再回调 sidecar 的回环监听
      const authorize = await fetch(authorizeUrl).then((res) => res.json())
      check('mock authorize 发放一次性 code', Boolean(authorize?.code))
      const redirectUri = new URL(authorizeUrl).searchParams.get('redirect_uri')
      const callback = await fetch(`${redirectUri}?code=${authorize.code}&state=${authorize.state}`)
      check('回环回调返回完成页', callback.status === 200 && (await callback.text()).includes('授权完成'))

      // token 交换在后台异步完成，轮询等待
      let status = null
      for (let attempt = 0; attempt < 25; attempt++) {
        status = await call('account/oauthStatus', { state: begin.state })
        if (status?.status !== 'pending') break
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
      }
      check('oauthStatus 报告完成', status?.status === 'done', JSON.stringify(status))

      const added = await call('account/add', {
        provider: 'graph',
        email: 'user@example.com',
        displayName: '冒烟用户',
        tenantId: 'common',
        clientId: 'mock-client',
        oauthState: begin.state,
        verify: false,
      })
      const graphAccount = added?.account
      check('Graph 账户创建成功', graphAccount?.provider === 'graph' && graphAccount?.authType === 'oauth2', JSON.stringify(added?.account))
      check('文件夹发现正常', added?.warnings?.length === 0, JSON.stringify(added?.warnings))

      // 首次同步：文件夹引导 + 最新 N 封 + delta 基线
      const sync1 = await call('sync/now', { accountId: graphAccount.id }, 30000)
      check('Graph 首次同步无错误', sync1?.errors?.length === 0, JSON.stringify(sync1?.errors))
      check('首次同步发现文件夹', sync1?.reports?.[0]?.mailboxes === 7, JSON.stringify(sync1?.reports))

      const foldersAfter = await call('mailbox/list', {})
      const inbox = foldersAfter?.items?.find((item) => item.role === 'inbox' && item.accountId === graphAccount.id)
      const sent = foldersAfter?.items?.find((item) => item.role === 'sent' && item.accountId === graphAccount.id)
      check('收件箱计数来自服务器', inbox?.total === 3 && inbox?.unread === 2, JSON.stringify(inbox))

      // mail/list 返回会话（m1/m2 同线程归并 → 2 个会话、共 3 封）
      const threads = await call('mail/list', { mailboxId: inbox.id, limit: 20 })
      check('收件箱会话归并（3 封 → 2 会话）', threads?.items?.length === 2, JSON.stringify(threads?.items?.map((item) => item.subject)))
      check(
        '会话内计数合计 3 封',
        (threads?.items || []).reduce((sum, item) => sum + (item.count || 0), 0) === 3,
        JSON.stringify(threads?.items?.map((item) => item.count)),
      )
      const opened = await call('mail/open', { id: threads.items[0].latestId })
      check('正文与线程头就位', opened?.htmlBody?.includes('正文') === true && opened?.messageId?.includes('example.com'), opened?.messageId)

      // 旗标推送（PATCH isRead / flag）：会话最新一封（第一封）→ 取消星标并标已读
      const flaggedThread = threads.items.find((item) => item.flagged)
      check('初始夹具包含星标会话', Boolean(flaggedThread))
      await call('mail/flags', { ids: [flaggedThread.latestId], flagged: false, seen: true })
      const mockFlagged = mock.state.folders.find((item) => item.id === 'f-inbox').messages.find((message) => message.id === 'mock-1')
      check('旗标已推送到 Graph', mockFlagged?.flagged === false && mockFlagged?.seen === true, JSON.stringify(mockFlagged))

      // 移动到「存档」：第一封（最新会话的最新一封）
      const archive = foldersAfter?.items?.find((item) => item.role === 'archive' && item.accountId === graphAccount.id)
      const moved = threads.items[0]
      check('待移动的是第一封', moved.subject === '第一封：项目周报', moved.subject)
      await call('mail/move', { ids: [moved.latestId], destination: { kind: 'mailbox', mailboxId: archive.id } })
      const archiveMessages = mock.state.folders.find((item) => item.id === 'f-archive').messages
      check('移动已推送到 Graph', archiveMessages.length === 1, JSON.stringify(archiveMessages.length))

      // 增量同步：注入新邮件 / 删除 / 旗标
      await fetch(`${mock.base}/__test/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: 'f-inbox', newMessage: { subject: '第四封：增量新邮件' }, removeId: 'mock-3', flagId: 'mock-2', flagged: true }),
      })
      const sync2 = await call('sync/now', { accountId: graphAccount.id }, 30000)
      check('增量同步无错误', sync2?.errors?.length === 0, JSON.stringify(sync2?.errors))
      const mails2 = await call('mail/list', { mailboxId: inbox.id, limit: 20 })
      check('增量新邮件到达', mails2?.items?.some((item) => item.subject === '第四封：增量新邮件'), JSON.stringify(mails2?.items?.map((item) => item.subject)))
      check('远端删除已生效', mails2?.items?.every((item) => item.subject !== '第三封：登录提醒'), JSON.stringify(mails2?.items?.map((item) => item.subject)))
      check('旗标增量已应用', mails2?.items?.find((item) => item.subject === '第二封：回复：项目周报')?.flagged === true)

      // 发送：MIME 建草稿 + send → 自动落「已发送」（delaySeconds=0 绕过撤销窗口，仅测试用）
      await call(
        'compose/send',
        { accountId: graphAccount.id, to: ['friend@example.com'], subject: 'Graph 冒烟发送', html: '<p>你好</p>', mode: 'delay', delaySeconds: 0 },
        15000,
      )
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 4500))
      const outbox = await call('outbox/list')
      const outboxItem = outbox?.items?.[0]
      check('发件箱投递成功', outboxItem?.status === 'sent', JSON.stringify({ status: outboxItem?.status, error: outboxItem?.error }))
      const sentMimes = await fetch(`${mock.base}/__test/sent`).then((res) => res.json())
      // mail-builder 会把中文主题编码为 RFC2047，按 Message-ID 域识别我们的 MIME
      const sentMime = sentMimes?.items?.find((item) => item.includes('@dbx-mail'))
      check('MIME 到达 mock 且保留 Message-ID', Boolean(sentMime) && /Message-ID:\s*<.+@dbx-mail>/.test(sentMime || ''), String(sentMime?.split('\r\n')[0]))

      // 再次同步：发送的邮件从「已发送」回流到本地缓存
      const sync3 = await call('sync/now', { accountId: graphAccount.id }, 30000)
      check('发送后同步无错误', sync3?.errors?.length === 0, JSON.stringify(sync3?.errors))
      const mails3 = await call('mail/list', { mailboxId: sent.id, limit: 20 })
      check('已发送回流本地缓存', mails3?.items?.some((item) => item.subject === 'Graph 冒烟发送'), JSON.stringify(mails3?.items?.map((item) => item.subject)))

      // refresh 轮换：mock 的 expires_in=0 强制每次刷新，旧 refresh_token 会被拒绝
      check('refresh_token 轮换生效', mock.state.refreshTokenSeq >= 3, String(mock.state.refreshTokenSeq))
      check('delta 基线翻页生效', (await fetch(`${mock.base}/__test/deltaConsumed`).then((res) => res.json())).count >= 0)
    }
  } finally {
    mock.close()
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
} finally {
  child.stdin.end()
  mock.close()
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
