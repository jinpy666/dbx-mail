/**
 * 本地打包器（生成 .dbxp）
 *
 * 为什么不用 `dbx-plugin package`：官方 CLI 会用 `\\?\` 前缀路径调用 cargo，
 * 而 Windows 上本项目只能使用 GNU 工具链（无 MSVC Build Tools），MinGW 的 ld
 * 无法处理该前缀（`cannot find \\symbols.o`）。CLI 也没有跳过编译的开关。
 *
 * 这里按 CLI 的产物格式自行打包，布局与校验文件完全一致：
 *   manifest.json（backend.executable 改写为 bin/<target>/backend.exe）
 *   ui/**、assets/**、bin/<target>/backend.exe、LICENSE、THIRD-PARTY-NOTICES.md、licenses/**
 *   checksums.json（除自身外所有文件的 sha256）
 * 旁边再写一份 <id>-<version>-<target>.artifact.json（sha256 + size）。
 *
 * 前置：npm run build（生成 ui/）与 npm run backend（生成 backend/target/release/backend[.exe]）。
 *
 * 用法：
 *   node scripts/package.mjs [--output-dir release] [--target windows-x64]
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

function arg(name, fallback = '') {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const target = arg('target', process.env.DBX_PLUGIN_TARGET || platformTarget())
const outputDir = resolve(root, arg('output-dir', 'release'))

function platformTarget() {
  const key = `${process.platform}-${process.arch}`
  // 目标名必须与宿主 / 商店 / CI 矩阵一致：darwin-*、linux-*、windows-*
  const map = {
    'win32-x64': 'windows-x64',
    'win32-arm64': 'windows-arm64',
    'darwin-x64': 'darwin-x64',
    'darwin-arm64': 'darwin-arm64',
    'linux-x64': 'linux-x64',
    'linux-arm64': 'linux-arm64',
  }
  const value = map[key]
  if (!value) throw new Error(`不支持的目标平台：${key}`)
  return value
}

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const toml = readFileSync(join(root, 'dbx-plugin.toml'), 'utf8')

/** 从 dbx-plugin.toml 的 [package] include 读要打包的条目（够用即可，不引 TOML 解析器） */
function includeEntries() {
  const match = toml.match(/\[package\]([\s\S]*?)(\n\[|$)/)
  if (!match) return ['assets', 'ui', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'licenses']
  const list = match[1].match(/include\s*=\s*\[([\s\S]*?)\]/)
  if (!list) return []
  return Array.from(list[1].matchAll(/"([^"]+)"/g)).map((item) => item[1])
}

const binaryName = target.startsWith('windows') ? 'backend.exe' : 'backend'
const binarySource = join(root, 'backend/target/release', binaryName)

for (const [label, path] of [
  ['后端可执行文件', binarySource],
  ['前端产物 ui/index.html', join(root, 'ui/index.html')],
]) {
  if (!existsSync(path)) {
    console.error(`缺少${label}：${path}\n请先运行 npm run build 与 npm run backend。`)
    process.exit(2)
  }
}

function walk(dir, base = dir) {
  const files = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const info = statSync(full)
    if (info.isDirectory()) files.push(...walk(full, base))
    else if (info.isFile()) files.push(relative(base, full))
  }
  return files
}

/** zip 内路径统一用 / */
const toZipPath = (path) => path.split(sep).join('/')

const files = new Map()

for (const entry of includeEntries()) {
  const full = join(root, entry)
  if (!existsSync(full)) {
    console.error(`[package] include 里的条目不存在：${entry}`)
    process.exit(2)
  }
  if (statSync(full).isDirectory()) {
    for (const rel of walk(full)) files.set(toZipPath(join(entry, rel)), join(full, rel))
  } else {
    files.set(toZipPath(entry), full)
  }
}

const packagedManifest = structuredClone(manifest)
packagedManifest.entrypoints = {
  ...packagedManifest.entrypoints,
  backend: { ...(packagedManifest.entrypoints?.backend ?? {}), executable: `bin/${target}/${binaryName}` },
}
files.set('manifest.json', null)
files.set(`bin/${target}/${binaryName}`, binarySource)

/* ---------------- 生成校验清单 ---------------- */

const buffers = new Map()
for (const [path, source] of files) {
  buffers.set(path, source === null ? Buffer.from(`${JSON.stringify(packagedManifest, null, 2)}\n`, 'utf8') : readFileSync(source))
}

const checksums = {}
for (const path of [...buffers.keys()].sort()) {
  checksums[path] = createHash('sha256').update(buffers.get(path)).digest('hex')
}
buffers.set('checksums.json', Buffer.from(`${JSON.stringify({ algorithm: 'sha256', files: checksums }, null, 2)}\n`, 'utf8'))

/* ---------------- 最小 ZIP 写入（deflate，DOS 属性，和 CLI 产物一致） ---------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

function buildZip(entries) {
  const now = new Date()
  const { time, day } = dosDateTime(now)
  const locals = []
  const centrals = []
  let offset = 0

  for (const [name, data] of entries) {
    const nameBuffer = Buffer.from(name, 'utf8')
    const compressed = deflateRawSync(data, { level: 9 })
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)

    locals.push(local, nameBuffer, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(day, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuffer)

    offset += local.length + nameBuffer.length + compressed.length
  }

  const centralBuffer = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralBuffer, end])
}

const ordered = [...buffers.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
const archive = buildZip(ordered)

mkdirSync(outputDir, { recursive: true })
const baseName = `${manifest.id}-${manifest.version}-${target}`
const archivePath = join(outputDir, `${baseName}.dbxp`)
writeFileSync(archivePath, archive)

const digest = createHash('sha256').update(archive).digest('hex')
const artifactPath = join(outputDir, `${baseName}.artifact.json`)
writeFileSync(
  artifactPath,
  `${JSON.stringify(
    { target, url: `${baseName}.dbxp`, sha256: digest, size: archive.length },
    null,
    2,
  )}\n`,
)

// CLI 的临时构建目录在失败时可能残留，清掉避免下次误判
const leftover = join(outputDir, `.build-rust-${target}`)
if (existsSync(leftover)) rmSync(leftover, { recursive: true, force: true })

console.log(`已打包：${relative(root, archivePath)}`)
console.log(`  条目 ${ordered.length} 个，大小 ${(archive.length / 1024 / 1024).toFixed(2)} MB`)
console.log(`  sha256 ${digest}`)
console.log(`  元数据 ${relative(root, artifactPath)}`)
