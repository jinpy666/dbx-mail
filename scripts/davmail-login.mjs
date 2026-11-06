#!/usr/bin/env node
/**
 * DavMail 本地网关「一键登录」+ 联调脚本
 *
 * 解决的问题：Microsoft 365 的 Device Code 只有 15 分钟有效期，而 DavMail 只在
 * 「有客户端来登录」时才签发设备码。所以必须由本脚本在同一时刻完成三件事：
 *   1) 确保 DavMail 在 127.0.0.1 上监听（没起就自己拉起来）
 *   2) 用一条真实 IMAP 连接触发登录，从 DavMail 日志里抓出设备码并打印/打开浏览器
 *   3) 盯住这条连接，登录成功后自动跑 scripts/davmail-check.mjs 做六项联调断言
 *
 * 前置：Node 18+、Java 11+、DavMail 发行包已解压到 --davmail-dir（默认 .tools/davmail）。
 *       发行包下载：https://sourceforge.net/projects/davmail/files/davmail/
 *       （7.1.0-4498.zip，sha256 c007d3ac57e00d680c977c1b2d027d70ca7713dd734f69423ccd4bcb11c0cf54）
 *
 * 用法：
 *   node scripts/davmail-login.mjs --email you@contoso.com
 *   node scripts/davmail-login.mjs --email you@contoso.com --check          # 登录后自动联调
 *   node scripts/davmail-login.mjs --email you@contoso.com --no-open        # 不自动开浏览器
 *   node scripts/davmail-login.mjs --email you@contoso.com --keep-gateway   # 保留网关不退出
 *   node scripts/davmail-login.mjs --stop                                   # 停掉占用端口的网关
 *
 * 参数：
 *   --email        必填（除 --stop），登录用的邮箱，同时作为 IMAP 用户名
 *   --davmail-dir  DavMail 解压目录，默认 .tools/davmail
 *   --imap-port    IMAP 端口，默认 1143
 *   --smtp-port    SMTP 端口，默认 1025
 *   --timeout      等待登录完成的秒数，默认 900（设备码自身 15 分钟失效）
 *   --check        登录成功后串跑 scripts/davmail-check.mjs
 *   --keep-gateway 结束时不停掉本次拉起的 DavMail
 *   --no-open      不自动打开默认浏览器
 *   --stop         只停网关，不做登录
 *
 * 退出码：0 成功；2 参数/环境问题；4 设备码过期；5 等待超时；6 登录被拒。
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ---------------- 输出着色（非 TTY / NO_COLOR 时自动关闭） ---------------- */
const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR
const paint = (code) => (text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : String(text))
const bold = paint('1')
const dim = paint('2')
const green = paint('32')
const yellow = paint('33')
const red = paint('31')
const cyan = paint('36')

/** 解析 `--key value` 与 `--flag` */
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
const options = {
  email: args.email ? String(args.email) : '',
  davmailDir: resolve(root, String(args['davmail-dir'] ?? '.tools/davmail')),
  imapPort: Number(args['imap-port'] ?? 1143),
  smtpPort: Number(args['smtp-port'] ?? 1025),
  timeoutMs: Number(args.timeout ?? 900) * 1000,
  runCheck: Boolean(args.check),
  keepGateway: Boolean(args['keep-gateway']),
  openBrowser: !args['no-open'],
  stopOnly: Boolean(args.stop),
}

const jarPath = join(options.davmailDir, 'davmail.jar')
const homeDir = join(options.davmailDir, 'home')
const configPath = join(homeDir, '.config', 'davmail', 'davmail.properties')
const logPath = join(options.davmailDir, 'davmail.log')

/** 探测端口是否已被 DavMail 之类进程占用 */
function portOpen(host, port, timeoutMs = 800) {
  return new Promise((resolvePromise) => {
    const socket = net.connect({ host, port })
    const finish = (open) => {
      socket.removeAllListeners()
      socket.destroy()
      resolvePromise(open)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** 轮询等待端口进入监听状态 */
async function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portOpen(host, port)) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** 写出 DavMail 配置：只监听回环、关本地 TLS、日志落绝对路径便于抓设备码 */
function writeConfig() {
  mkdirSync(dirname(configPath), { recursive: true })
  const lines = [
    '# 由 scripts/davmail-login.mjs 生成，勿手改（改参数请用命令行开关）',
    'davmail.mode=O365EWS',
    'davmail.authentication=O365DeviceCode',
    'davmail.url=https://outlook.office365.com/EWS/Exchange.asmx',
    'davmail.enableGraph=false',
    'davmail.bindAddress=127.0.0.1',
    'davmail.allowRemote=false',
    'davmail.server=false',
    `davmail.imapPort=${options.imapPort}`,
    `davmail.smtpPort=${options.smtpPort}`,
    // 自签证书过不了 rustls 的系统根校验，本地回环内用明文
    'davmail.ssl.nosecureimap=true',
    'davmail.ssl.nosecuresmtp=true',
    'davmail.ssl.nosecurepop=true',
    'davmail.ssl.nosecureldap=true',
    'davmail.ssl.nosecurecaldav=true',
    'davmail.showStartupBanner=false',
    'davmail.disableUpdateCheck=true',
    'davmail.disableGuiNotifications=true',
    'davmail.enableTray=false',
    `davmail.logFilePath=${logPath.replace(/\\/g, '/')}`,
    'davmail.logFileSize=10MB',
    '',
  ]
  writeFileSync(configPath, lines.join('\n'), 'utf8')
}

/** 用默认浏览器打开设备码页面（各平台分别处理） */
function openInBrowser(url) {
  const [command, commandArgs] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(command, commandArgs, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // 打不开浏览器不影响流程，用户可手动复制地址
  }
}

/** 拉起 DavMail（headless，user.home 沙箱到 .tools/davmail/home，不污染真实家目录） */
function startGateway() {
  writeConfig()
  const out = openSync(logPath, 'a')
  const child = spawn(
    'java',
    ['-Duser.home=' + homeDir, '-Djava.awt.headless=true', '-Xmx512m', '-jar', jarPath],
    { cwd: options.davmailDir, stdio: ['ignore', out, out], windowsHide: true },
  )
  child.on('error', (error) => {
    console.error(red(`启动 DavMail 失败：${error.message}`))
    process.exit(2)
  })
  return child
}

/** 只读日志新增部分，从中找出设备码 */
function makeLogWatcher(fromOffset) {
  let offset = fromOffset
  return function readNewCode() {
    if (!existsSync(logPath)) return null
    const size = statSync(logPath).size
    if (size < offset) offset = 0 // 日志被轮转/截断
    if (size === offset) return null
    const fd = openSync(logPath, 'r')
    try {
      const buffer = Buffer.alloc(size - offset)
      readSync(fd, buffer, 0, buffer.length, offset)
      offset = size
      const matched = /enter the code ([A-Z0-9]{6,12})/.exec(buffer.toString('utf8'))
      return matched ? matched[1] : null
    } finally {
      closeSync(fd)
    }
  }
}

/** 读日志尾部若干字节，用于判定登录失败的真实原因（IMAP 只返回 NO） */
function readLogTail(bytes = 4000) {
  if (!existsSync(logPath)) return ''
  const size = statSync(logPath).size
  const start = Math.max(0, size - bytes)
  const fd = openSync(logPath, 'r')
  try {
    const buffer = Buffer.alloc(size - start)
    readSync(fd, buffer, 0, buffer.length, start)
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** 发一条 IMAP LOGIN 并保持连接，登录成功（LIST OK）时 resolve */
function loginOverImap() {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = net.connect({ host: '127.0.0.1', port: options.imapPort })
    socket.setEncoding('utf8')
    let buffer = ''
    let sentList = false
    const timer = setTimeout(() => {
      socket.destroy()
      rejectPromise(Object.assign(new Error('等待登录超时'), { exitCode: 5 }))
    }, options.timeoutMs)

    socket.on('data', (chunk) => {
      buffer += chunk
      if (!sentList && /^a1 /m.test(chunk)) {
        sentList = true
        socket.write('a2 LIST "" "*"\r\n')
      }
      if (/^a2 OK/m.test(buffer)) {
        clearTimeout(timer)
        socket.write('a3 LOGOUT\r\n')
        setTimeout(() => socket.destroy(), 200)
        resolvePromise(buffer)
      }
      if (/^a1 (NO|BAD)/m.test(buffer)) {
        clearTimeout(timer)
        socket.destroy()
        // IMAP 只说 "LOGIN failed"，真正原因在 DavMail 日志里
        const tail = readLogTail()
        const expired = /AADSTS70019|code_expired/.test(tail)
        rejectPromise(
          Object.assign(new Error(expired ? '设备码已过期（AADSTS70019）' : '登录被拒，详见 DavMail 日志'), {
            exitCode: expired ? 4 : 6,
          }),
        )
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      rejectPromise(Object.assign(error, { exitCode: 2 }))
    })
    socket.once('connect', () => {
      socket.write(`a1 LOGIN "${options.email}" "device-code"\r\n`)
    })
  })
}

/** 停掉占用 IMAP 端口的进程（各平台均用 netstat/lsof 兜底） */
async function stopGateway() {
  if (!(await portOpen('127.0.0.1', options.imapPort))) {
    console.log(dim(`端口 ${options.imapPort} 未监听，无需停止`))
    return
  }
  const { execFileSync } = await import('node:child_process')
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
      const line = output.split(/\r?\n/).find((row) => new RegExp(`:${options.imapPort}\\s`).test(row) && /LISTENING/.test(row))
      const pid = line?.trim().split(/\s+/).pop()
      if (pid) execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' })
    } else {
      execFileSync('sh', ['-c', `lsof -ti tcp:${options.imapPort} | xargs -r kill`], { stdio: 'ignore' })
    }
    console.log(green(`已停止监听 ${options.imapPort} 的进程`))
  } catch (error) {
    console.error(red(`停止失败：${error.message}`))
  }
}

/* ---------------- 主流程 ---------------- */

async function main() {
  if (options.stopOnly) return stopGateway()

  if (!options.email) {
    console.error(red('缺少 --email。示例：node scripts/davmail-login.mjs --email you@contoso.com'))
    process.exit(2)
  }
  if (!existsSync(jarPath)) {
    console.error(red(`找不到 ${jarPath}`))
    console.error('请先下载并解压 DavMail：https://sourceforge.net/projects/davmail/files/davmail/')
    console.error(dim('解压后目录结构应为 <davmail-dir>/davmail.jar + <davmail-dir>/lib/*.jar'))
    process.exit(2)
  }

  let gateway = null
  let logOffset = existsSync(logPath) ? statSync(logPath).size : 0
  if (await portOpen('127.0.0.1', options.imapPort)) {
    console.log(dim(`复用已在运行的网关（127.0.0.1:${options.imapPort}）`))
  } else {
    console.log(dim(`启动 DavMail：${jarPath}`))
    gateway = startGateway()
    if (!(await waitForPort('127.0.0.1', options.imapPort, 30_000))) {
      console.error(red('DavMail 30 秒内没有监听端口，请检查 Java 与日志：' + logPath))
      process.exit(2)
    }
    console.log(green(`网关已就绪：IMAP 127.0.0.1:${options.imapPort} / SMTP 127.0.0.1:${options.smtpPort}`))
  }

  const readNewCode = makeLogWatcher(logOffset)
  const loginPromise = loginOverImap()

  console.log(`\n账户：${bold(options.email)}`)
  console.log(dim('等待 DavMail 签发设备码…'))

  let announced = null
  const codePoll = setInterval(() => {
    const code = readNewCode()
    if (!code || code === announced) return
    announced = code
    const url = 'https://login.microsoft.com/device'
    console.log(`\n${yellow('════════ 请完成登录 ════════')}`)
    console.log(`  地址：${cyan(url)}`)
    console.log(`  设备码：${bold(code)}`)
    console.log(`  账号：${options.email}`)
    console.log(dim('  15 分钟内有效；完成后这里会自动继续'))
    console.log(`${yellow('════════════════════════════')}\n`)
    if (options.openBrowser) {
      openInBrowser(url)
      console.log(dim('已尝试打开默认浏览器（--no-open 可关闭）'))
    }
  }, 1000)

  try {
    await loginPromise
    clearInterval(codePoll)
    console.log(green('登录成功：IMAP LIST 返回 OK'))
    if (options.runCheck) {
      console.log(dim('\n开始联调：scripts/davmail-check.mjs\n'))
      const check = spawn(process.execPath, [join(root, 'scripts', 'davmail-check.mjs'), '--email', options.email, '--imap-port', String(options.imapPort), '--smtp-port', String(options.smtpPort)], { stdio: 'inherit' })
      const code = await new Promise((r) => check.on('exit', r))
      if (code !== 0) process.exitCode = 1
    }
  } catch (error) {
    clearInterval(codePoll)
    console.error(red(`\n登录未完成：${error.message}`))
    process.exitCode = error.exitCode ?? 6
  } finally {
    if (gateway && !options.keepGateway) {
      gateway.kill()
      console.log(dim('已停止本次拉起的网关（--keep-gateway 可保留，便于继续联调）'))
    } else if (gateway) {
      console.log(dim(`网关保持运行（PID ${gateway.pid}），停止：node scripts/davmail-login.mjs --stop`))
    }
  }
}

await main()
