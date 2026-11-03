/**
 * 展示层格式化：时间、体积、地址、姓名缩写与配色
 *
 * 这里不依赖任何后端字段之外的东西，方便在阅读器、列表、撰写器里复用。
 */
import { t } from './i18n'

const PALETTE = ['#3584e4', '#2ec27e', '#9141ac', '#e01b24', '#e5a50a', '#2190a4', '#c061cb', '#e8660c']

const HOUR = 3_600_000
const DAY = 86_400_000

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

export function isSameDay(left: number, right: number): boolean {
  const a = new Date(left)
  const b = new Date(right)
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  )
}

/** 列表时间：刚才 / 12:40 / 昨天 / 10月3日 / 2024/10/3 */
export function formatListTime(ts: number, locale: string, now = Date.now()): string {
  if (!ts) return ''
  const diff = now - ts
  if (diff < 60_000) return t(locale, 'time.justNow')
  if (diff < HOUR) return t(locale, 'time.minutes', { count: Math.floor(diff / 60_000) })
  if (isSameDay(ts, now)) return clockTime(ts)
  if (isSameDay(ts, now - DAY)) return t(locale, 'time.yesterday')
  if (diff < 7 * DAY) return t(locale, 'time.days', { count: Math.floor(diff / DAY) })
  return shortDate(ts, locale)
}

export function clockTime(ts: number): string {
  const date = new Date(ts)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function shortDate(ts: number, locale: string): string {
  const date = new Date(ts)
  if (locale === 'en') {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return sameYear
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

/** 阅读器里的完整时间：2024年10月3日 14:08 */
export function formatFullTime(ts: number, locale: string): string {
  if (!ts) return ''
  const date = new Date(ts)
  if (locale === 'en') {
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${clockTime(ts)}`
}

/** 会话里的按日分组标题：今天 / 昨天 / 10月3日 */
export function formatDayLabel(ts: number, locale: string, now = Date.now()): string {
  if (isSameDay(ts, now)) return t(locale, 'time.today')
  if (isSameDay(ts, now - DAY)) return t(locale, 'time.yesterday')
  return shortDate(ts, locale)
}

export function formatBytes(size: number): string {
  if (!size || size < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = size
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  const digits = index === 0 || value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${units[index]}`
}

/** 姓名缩写：中文取最后一到两个字，其余取首字母 */
export function initials(name: string, email = ''): string {
  const clean = (name || '').trim()
  if (clean) {
    if (/[\u3400-\u9fff]/.test(clean)) return clean.slice(-2)
    const parts = clean.split(/[\s._-]+/).filter(Boolean)
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
    return clean.slice(0, 2).toUpperCase()
  }
  const local = email.split('@')[0] ?? ''
  return (local.slice(0, 2) || '?').toUpperCase()
}

export function avatarColor(seed: string): string {
  const value = (seed || '?').toLowerCase()
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 100_000
  }
  return PALETTE[hash % PALETTE.length]
}

/** 展示用短名：优先显示名，其次地址前缀 */
export function displayName(name: string, email: string): string {
  const clean = (name || '').trim()
  if (clean) return clean
  const local = (email || '').split('@')[0]
  return local || email || ''
}

/** 取名字的第一段，用于「回复 Priya…」这类占位 */
export function firstName(name: string, email: string): string {
  const clean = displayName(name, email)
  return clean.split(/\s+/)[0] || clean
}

/** 把 "A <a@b>, c@d" 拆成地址数组 */
export function splitAddresses(text: string): string[] {
  const value = (text || '').trim()
  if (!value) return []
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '<') depth += 1
    if (char === '>') depth = Math.max(0, depth - 1)
    if ((char === ',' || char === ';') && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/<([^>]+)>/)
      const email = (match ? match[1] : part).trim()
      const name = match ? part.replace(match[0], '').trim().replace(/^"|"$/g, '') : ''
      return name ? `${name} <${email}>` : email
    })
}

export function emailOf(address: string): string {
  const match = (address || '').match(/<([^>]+)>/)
  return (match ? match[1] : address || '').trim()
}

export function nameOf(address: string): string {
  const value = (address || '').trim()
  const match = value.match(/^(.*?)<[^>]+>$/)
  if (!match) return ''
  return match[1].trim().replace(/^"|"$/g, '')
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 纯文本转简单 HTML：段落到 <p>，换行到 <br> */
export function textToHtml(text: string): string {
  return (text || '')
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

export function htmlToText(html: string): string {
  return (html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 会话摘要：压掉空白并截断 */
export function ellipsis(text: string, max = 160): string {
  const clean = (text || '').replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max)}…`
}
