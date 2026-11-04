/**
 * 撰写器状态
 *
 * 每封正在写的邮件是一个 key（可以同时开多封）。附件先由后端落到暂存目录，
 * 内存里只保留路径，这样关闭窗口再打开草稿也不会丢文件。
 */
import { create } from 'zustand'
import * as api from '../lib/rpc'
import type { Draft, DraftAttachment, MessageDetail } from '../lib/rpc'
import { escapeHtml, emailOf, formatFullTime, splitAddresses } from '../lib/format'
import { sanitizeComposerHtml } from '../lib/html'
import { useMail } from './mail'

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward' | 'draft'

export interface Composer {
  key: string
  mode: ComposeMode
  accountId: number
  to: string
  cc: string
  bcc: string
  subject: string
  html: string
  attachments: DraftAttachment[]
  inReplyTo: string
  references: string[]
  draftId: number
  showCc: boolean
  sending: boolean
  savedAt: number
  touched: boolean
  error: string
}

interface ComposerStore {
  items: Composer[]
  open: (composer: Partial<Composer> & { mode: ComposeMode }) => string
  patch: (key: string, patch: Partial<Composer>) => void
  close: (key: string) => void
  attach: (key: string, files: File[]) => Promise<void>
  detach: (key: string, path: string) => void
  saveDraft: (key: string, silent?: boolean) => Promise<void>
  send: (
    key: string,
    options?: { mode?: 'now' | 'delay' | 'schedule'; delaySeconds?: number; scheduledAt?: number },
  ) => Promise<{ outboxId: number; undoSeconds: number; scheduledAt: number }>
  discard: (key: string) => Promise<void>
}

let counter = 0

export const useComposer = create<ComposerStore>((set, get) => ({
  items: [],

  open: (init) => {
    const key = `c${++counter}`
    const { mode, ...rest } = init
    const accountId = rest.accountId ?? useMail.getState().accounts[0]?.id ?? 0
    const composer: Composer = {
      key,
      accountId,
      to: '',
      cc: '',
      bcc: '',
      subject: '',
      html: '',
      attachments: [],
      inReplyTo: '',
      references: [],
      draftId: 0,
      showCc: false,
      sending: false,
      savedAt: 0,
      touched: false,
      error: '',
      ...rest,
      mode,
    }
    set((state) => ({ items: [...state.items, composer] }))
    return key
  },

  patch: (key, patch) =>
    set((state) => ({
      items: state.items.map((item) => (item.key === key ? { ...item, ...patch, touched: true } : item)),
    })),

  close: (key) => set((state) => ({ items: state.items.filter((item) => item.key !== key) })),

  attach: async (key, files) => {
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) {
        set((state) => ({
          items: state.items.map((item) =>
            item.key === key ? { ...item, error: `${file.name} 超过 25 MB，未添加` } : item,
          ),
        }))
        continue
      }
      const base64 = await readBase64(file)
      const saved = await api.saveUpload(file.name, base64)
      set((state) => ({
        items: state.items.map((item) =>
          item.key === key
            ? { ...item, attachments: [...item.attachments, saved], touched: true, error: '' }
            : item,
        ),
      }))
    }
  },

  detach: (key, path) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.key === key
          ? { ...item, attachments: item.attachments.filter((file) => file.path !== path), touched: true }
          : item,
      ),
    })),

  saveDraft: async (key, silent = false) => {
    const composer = get().items.find((item) => item.key === key)
    if (!composer) return
    if (!composer.accountId) return
    const payload: Draft = {
      id: composer.draftId,
      accountId: composer.accountId,
      toAddrs: splitAddresses(composer.to),
      ccAddrs: splitAddresses(composer.cc),
      bccAddrs: splitAddresses(composer.bcc),
      subject: composer.subject,
      bodyHtml: composer.html,
      attachments: composer.attachments,
      inReplyTo: composer.inReplyTo,
      references: composer.references,
      updatedAt: 0,
      createdAt: 0,
    }
    const result = await api.saveDraft(payload)
    set((state) => ({
      items: state.items.map((item) =>
        item.key === key
          ? { ...item, draftId: result.id, savedAt: result.updatedAt, error: silent ? item.error : '' }
          : item,
      ),
    }))
    if (!silent) void useMail.getState().loadDrafts()
  },

  send: async (key, options) => {
    const composer = get().items.find((item) => item.key === key)
    if (!composer) throw new Error('邮件已关闭')
    set((state) => ({
      items: state.items.map((item) => (item.key === key ? { ...item, sending: true, error: '' } : item)),
    }))
    try {
      const result = await api.sendMail({
        accountId: composer.accountId,
        to: splitAddresses(composer.to),
        cc: splitAddresses(composer.cc),
        bcc: splitAddresses(composer.bcc),
        subject: composer.subject,
        html: composer.html,
        attachments: composer.attachments,
        inReplyTo: composer.inReplyTo,
        references: composer.references,
        draftId: composer.draftId,
        mode: options?.mode ?? 'now',
        delaySeconds: options?.delaySeconds,
        scheduledAt: options?.scheduledAt,
      })
      get().close(key)
      void useMail.getState().loadOutbox()
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set((state) => ({
        items: state.items.map((item) => (item.key === key ? { ...item, sending: false, error: message } : item)),
      }))
      throw error
    }
  },

  discard: async (key) => {
    const composer = get().items.find((item) => item.key === key)
    get().close(key)
    if (composer?.draftId) {
      try {
        await api.deleteDraft(composer.draftId)
      } catch {
        /* 草稿可能已经被发送流程删掉 */
      }
      void useMail.getState().loadDrafts()
    }
  },
}))

/* ---------------- 构造入口 ---------------- */

function signatureHtml(accountId: number): string {
  const account = useMail.getState().accounts.find((item) => item.id === accountId)
  if (!account?.signature) return ''
  const lines = account.signature.split('\n').map((line) => escapeHtml(line)).join('<br>')
  // data-signature 供撰写器把光标定位到签名之前
  return `<p><br></p><p data-signature="1" style="color:#6e6e76">--<br>${lines}</p>`
}

export function openNewMessage(accountId?: number): string {
  const target = accountId ?? useMail.getState().accounts[0]?.id ?? 0
  return useComposer.getState().open({
    mode: 'new',
    accountId: target,
    html: signatureHtml(target),
  })
}

function quoteBlock(detail: MessageDetail, locale: string): string {
  // 原邮件正文来自外部发件人，进编辑器前必须过白名单：引用块最终由
  // Composer 赋给 contentEditable 的 innerHTML，未经净化的 <img onerror> 会直接执行
  const quoted = sanitizeComposerHtml(
    detail.htmlBody || `<p>${escapeHtml(detail.textBody).replace(/\n/g, '<br>')}</p>`,
  )
  const attribution =
    locale === 'en'
      ? `On ${formatFullTime(detail.date, 'en')}, ${escapeHtml(detail.fromName || detail.fromAddr)} wrote:`
      : `在 ${formatFullTime(detail.date, 'zh-CN')}，${escapeHtml(detail.fromName || detail.fromAddr)} 写道：`
  return `<p><br></p><p style="color:#6e6e76">${attribution}</p><blockquote style="margin:0 0 0 0;padding-left:12px;border-left:2px solid #d8d8de;color:#6e6e76">${quoted}</blockquote>`
}

function withPrefix(subject: string, prefix: string): string {
  const clean = (subject || '').trim()
  if (!clean) return prefix
  return new RegExp(`^${prefix}`, 'i').test(clean) ? clean : `${prefix}${clean}`
}

export function openReply(detail: MessageDetail, all = false): string {
  const state = useMail.getState()
  const locale = state.settings.locale
  const own = detail.accountEmail.toLowerCase()
  const to = [detail.fromAddr]
  const cc: string[] = []
  if (all) {
    for (const address of [...detail.toAddrs, ...detail.ccAddrs]) {
      const email = emailOf(address).toLowerCase()
      if (!email || email === own || email === detail.fromAddr.toLowerCase()) continue
      if (to.some((item) => item.toLowerCase() === email)) continue
      cc.push(address)
    }
  }
  const accountId = detail.accountId
  const references = [...detail.references, detail.messageId].filter(Boolean)
  return useComposer.getState().open({
    mode: all ? 'replyAll' : 'reply',
    accountId,
    to: to.join(', '),
    cc: cc.join(', '),
    showCc: cc.length > 0,
    subject: withPrefix(detail.subject, 'Re: '),
    html: quoteBlock(detail, locale) + signatureHtml(accountId),
    inReplyTo: detail.messageId,
    references,
  })
}

export function openForward(detail: MessageDetail): string {
  const state = useMail.getState()
  const locale = state.settings.locale
  const accountId = state.accounts[0]?.id ?? detail.accountId
  const header =
    locale === 'en'
      ? `<p>---------- Forwarded message ----------<br>From: ${escapeHtml(detail.fromName || detail.fromAddr)} &lt;${escapeHtml(detail.fromAddr)}&gt;<br>Date: ${formatFullTime(detail.date, 'en')}<br>Subject: ${escapeHtml(detail.subject)}<br>To: ${escapeHtml(detail.toAddrs.join(', '))}</p>`
      : `<p>---------- 转发的邮件 ----------<br>发件人：${escapeHtml(detail.fromName || detail.fromAddr)} &lt;${escapeHtml(detail.fromAddr)}&gt;<br>时间：${formatFullTime(detail.date, 'zh-CN')}<br>主题：${escapeHtml(detail.subject)}<br>收件人：${escapeHtml(detail.toAddrs.join(', '))}</p>`
  const body = detail.htmlBody || `<p>${escapeHtml(detail.textBody).replace(/\n/g, '<br>')}</p>`
  const attachments: DraftAttachment[] = []
  return useComposer.getState().open({
    mode: 'forward',
    accountId,
    subject: withPrefix(detail.subject, 'Fwd: '),
    html: `${header}${body}${signatureHtml(accountId)}`,
    attachments,
  })
}

export function openDraft(draft: Draft): string {
  return useComposer.getState().open({
    mode: 'draft',
    accountId: draft.accountId,
    to: draft.toAddrs.join(', '),
    cc: draft.ccAddrs.join(', '),
    bcc: draft.bccAddrs.join(', '),
    showCc: draft.ccAddrs.length > 0 || draft.bccAddrs.length > 0,
    subject: draft.subject,
    // 草稿可能来自旧版本或外部导入，同样按不可信内容处理
    html: sanitizeComposerHtml(draft.bodyHtml),
    attachments: draft.attachments ?? [],
    inReplyTo: draft.inReplyTo,
    references: draft.references ?? [],
    draftId: draft.id,
    savedAt: draft.updatedAt,
  })
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`))
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(file)
  })
}
