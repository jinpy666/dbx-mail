import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  Download,
  Forward,
  ImageOff,
  Info,
  Loader2,
  Mail,
  MailOpen,
  MoreHorizontal,
  Paperclip,
  Reply,
  ReplyAll,
  Star,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import type { Attachment, MessageDetail, MessageSummary } from '../lib/rpc'
import * as api from '../lib/rpc'
import { t } from '../lib/i18n'
import { avatarColor, displayName, formatBytes, formatFullTime, initials } from '../lib/format'
import { applyImagePolicy, adaptForDark, hasRemoteImages, prepareMailBody } from '../lib/html'
import { useMail } from '../stores/mail'
import { openForward, openReply } from '../stores/composer'
import { pickDirectory, useUI } from '../stores/ui'

export function Reader() {
  const mail = useMail()
  const locale = useUI((state) => state.locale)
  const [moreOpen, setMoreOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const thread = mail.thread

  useEffect(() => {
    setMoreOpen(false)
    setDetailsOpen(false)
  }, [thread?.threadId, mail.activeId])

  if (!thread) {
    return (
      <main className="reader-pane">
        <div className="placeholder">
          <div className="placeholder-inner">
            <div className="placeholder-art">
              <MailOpen size={26} />
            </div>
            <div className="placeholder-title">{t(locale, 'reader.emptyTitle')}</div>
            <div className="placeholder-desc">{t(locale, 'reader.emptyDesc')}</div>
          </div>
        </div>
      </main>
    )
  }

  const detail = mail.detail && mail.detail.id === mail.activeId ? mail.detail : null
  const ids = mail.checked.length ? mail.checked : mail.activeId ? [mail.activeId] : [thread.latestId]
  const folderName = folderLabel(thread.mailboxRole, thread.accountId, locale)

  const doExport = async () => {
    setMoreOpen(false)
    const dir = await pickDirectory('', t(locale, 'dir.title'))
    if (!dir) return
    try {
      const paths = await mail.exportEml(ids, dir)
      toast.success(t(locale, 'toast.exported', { count: paths.length }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <main className="reader-pane">
      <div className="reader-head">
        <button
          className="icon-btn reader-back"
          onClick={() => mail.closeThread()}
          title={t(locale, 'action.back')}
        >
          <ArrowLeft size={16} />
        </button>
        <div className="grow">
          <div className="reader-crumb">
            {thread.accountEmail} · {folderName}
            {mail.messages.length > 1 ? ` · ${t(locale, 'reader.messageCount', { count: mail.messages.length })}` : ''}
          </div>
          <div className="reader-subject">{thread.subject || t(locale, 'misc.noSubject')}</div>
        </div>

        <div className="capsule">
          <button
            className="cap-btn"
            title={t(locale, 'action.reply')}
            disabled={!detail}
            onClick={() => detail && openReply(detail)}
          >
            <Reply size={15} />
          </button>
          <button
            className="cap-btn"
            title={t(locale, 'action.replyAll')}
            disabled={!detail}
            onClick={() => detail && openReply(detail, true)}
          >
            <ReplyAll size={15} />
          </button>
          <button
            className="cap-btn"
            title={t(locale, 'action.forward')}
            disabled={!detail}
            onClick={() => detail && openForward(detail)}
          >
            <Forward size={15} />
          </button>
          <span className="cap-sep" />
          <button className="cap-btn" title={t(locale, 'action.archive')} onClick={() => void mail.archive(ids)}>
            <Archive size={15} />
          </button>
          <button className="cap-btn" title={t(locale, 'action.delete')} onClick={() => void mail.trash(ids)}>
            <Trash2 size={15} />
          </button>
        </div>

        <button
          className={`icon-btn ${discussFlagged(mail.messages) ? 'on' : ''}`}
          title={t(locale, 'action.flag')}
          onClick={() => void mail.setMessageFlag(ids, { flagged: !discussFlagged(mail.messages) })}
        >
          <Star size={16} fill={discussFlagged(mail.messages) ? 'currentColor' : 'none'} />
        </button>

        <div style={{ position: 'relative' }}>
          <button className="icon-btn" title={t(locale, 'action.more')} onClick={() => setMoreOpen(!moreOpen)}>
            <MoreHorizontal size={16} />
          </button>
          {moreOpen && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 30 }} onClick={() => setMoreOpen(false)} />
              <div className="menu" style={{ right: 0, top: 40 }}>
                <button
                  onClick={() => {
                    setMoreOpen(false)
                    void mail.setMessageFlag(ids, { seen: false })
                    toast.success(t(locale, 'toast.markedUnread'))
                  }}
                >
                  <Mail size={14} /> {t(locale, 'action.markUnread')}
                </button>
                <button
                  onClick={() => {
                    setMoreOpen(false)
                    void mail.setMessageFlag(ids, { seen: true })
                    toast.success(t(locale, 'toast.markedRead'))
                  }}
                >
                  <MailOpen size={14} /> {t(locale, 'action.markRead')}
                </button>
                <div className="sep" />
                <button onClick={doExport}>
                  <Download size={14} /> {t(locale, 'action.export')}
                </button>
                <button
                  onClick={() => {
                    setMoreOpen(false)
                    setDetailsOpen(!detailsOpen)
                  }}
                >
                  <Info size={14} /> {detailsOpen ? t(locale, 'action.hideDetails') : t(locale, 'action.details')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="reader-scroll">
        <div className="reader-inner">
          {mail.messages.map((message) => {
            const active = message.id === mail.activeId || mail.messages.length === 1
            return (
              <article className="msg" key={message.id}>
                <button
                  className="msg-head"
                  onClick={() => {
                    if (!active) void mail.openMessage(message.id)
                  }}
                >
                  <span className="msg-avatar" style={{ background: avatarColor(message.fromAddr) }}>
                    {initials(message.fromName, message.fromAddr)}
                  </span>
                  <span className="msg-meta">
                    <span className="msg-line">
                      <span className="msg-name">
                        {displayName(message.fromName, message.fromAddr) || t(locale, 'misc.unknownSender')}
                      </span>
                      <span className="msg-addr">&lt;{message.fromAddr}&gt;</span>
                      <span className="msg-time">{formatFullTime(message.date, locale)}</span>
                    </span>
                    <span className="msg-to">
                      {t(locale, 'reader.to')}: {message.toAddrs.join(', ') || '—'}
                      {message.ccAddrs.length > 0 ? ` · ${t(locale, 'reader.cc')}: ${message.ccAddrs.join(', ')}` : ''}
                    </span>
                  </span>
                  {!active && <ChevronDown size={15} style={{ color: 'var(--ink-faint)', marginTop: 8 }} />}
                </button>

                {active ? (
                  <div className="msg-body">
                    {detailsOpen && <DetailsBlock message={message} locale={locale} />}
                    {detail && detail.id === message.id ? (
                      <MessageBody detail={detail} />
                    ) : mail.loadingDetail ? (
                      <div style={{ padding: '10px 0', color: 'var(--ink-dim)', fontSize: 13 }}>
                        <Loader2 size={14} className="spin" /> {t(locale, 'reader.loading')}
                      </div>
                    ) : (
                      <div style={{ padding: '8px 0' }}>
                        <div style={{ fontWeight: 700, fontSize: 13.5 }}>{t(locale, 'reader.notCached')}</div>
                        <div className="hint">{mail.detailError || t(locale, 'reader.notCachedDesc')}</div>
                        <button
                          className="btn btn-sm"
                          style={{ marginTop: 10 }}
                          onClick={() => void mail.openMessage(message.id)}
                        >
                          {t(locale, 'action.retry')}
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="msg-body collapsed">
                    <div className="msg-snippet">{message.snippet}</div>
                  </div>
                )}
              </article>
            )
          })}

          {detail && <QuickReply detail={detail} />}
        </div>
      </div>
    </main>
  )
}

function discussFlagged(messages: MessageSummary[]): boolean {
  return messages.some((message) => message.flagged)
}

function folderLabel(role: string, accountId: number, locale: string): string {
  const keys: Record<string, string> = {
    inbox: 'nav.inbox',
    sent: 'nav.sent',
    drafts: 'nav.drafts',
    archive: 'nav.archive',
    junk: 'nav.junk',
    trash: 'nav.trash',
  }
  if (keys[role]) return t(locale, keys[role])
  const mailbox = useMail.getState().mailboxes.find((item) => item.accountId === accountId && item.role === role)
  return mailbox?.name ?? t(locale, 'nav.mailboxes')
}

function DetailsBlock({ message, locale }: { message: MessageSummary; locale: string }) {
  return (
    <div
      style={{
        margin: '4px 0 10px',
        padding: '10px 12px',
        borderRadius: 10,
        background: 'color-mix(in srgb, var(--ink) 4%, transparent)',
        fontSize: 12,
        color: 'var(--ink-dim)',
        display: 'grid',
        gap: 4,
      }}
    >
      <div>
        <b>{t(locale, 'reader.from')}</b> {message.fromName} &lt;{message.fromAddr}&gt;
      </div>
      <div>
        <b>{t(locale, 'reader.to')}</b> {message.toAddrs.join(', ') || '—'}
      </div>
      {message.ccAddrs.length > 0 && (
        <div>
          <b>{t(locale, 'reader.cc')}</b> {message.ccAddrs.join(', ')}
        </div>
      )}
      <div>
        <b>{t(locale, 'app.lastSync')}</b> {formatFullTime(message.date, locale)} · {formatBytes(message.size)}
      </div>
    </div>
  )
}

function MessageBody({ detail }: { detail: MessageDetail }) {
  const locale = useUI((state) => state.locale)
  const appearance = useUI((state) => state.appearance)
  const allowImages = useMail((state) => state.allowImages)
  const toggleImages = useMail((state) => state.toggleImages)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const body = useMemo(
    () => prepareMailBody(detail.htmlBody, appearance === 'dark'),
    [detail.htmlBody, appearance],
  )
  const html = useMemo(
    () => (appearance === 'dark' ? adaptForDark(body.html) : body.html),
    [body, appearance],
  )
  const remote = useMemo(() => hasRemoteImages(detail.htmlBody), [detail.htmlBody])
  const [blocked, setBlocked] = useState(0)

  // 邮件自带的 CSS：以 textContent 写进 <style>，不经过 HTML 解析
  useEffect(() => {
    const element = bodyRef.current
    if (!element) return
    const existing = element.querySelector<HTMLStyleElement>('style[data-mail-css]')
    if (!body.css) {
      existing?.remove()
      return
    }
    const style = existing ?? document.createElement('style')
    if (!existing) {
      style.dataset.mailCss = '1'
      element.prepend(style)
    }
    style.textContent = body.css
  }, [body.css, html])

  useEffect(() => {
    const element = bodyRef.current
    if (!element) return
    if (!html) {
      setBlocked(0)
      return
    }
    let alive = true
    void applyImagePolicy(element, allowImages).then((count) => {
      if (alive) setBlocked(count)
    })
    return () => {
      alive = false
    }
  }, [html, allowImages, detail.id])

  const saveAttachment = async (file: Attachment) => {
    const dir = await pickDirectory('', t(locale, 'dir.title'))
    if (!dir) return
    try {
      const result = await api.saveAttachment({
        messageId: detail.id,
        index: file.index,
        dir,
        filename: file.filename,
      })
      toast.success(t(locale, 'toast.savedTo', { path: result.path }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  const visible = detail.attachments.filter((file) => !file.inline)

  /** 点占位框即放开全部图片；图片本身是链接时不动它，交给链接跳转 */
  const onClickBody = (event: MouseEvent<HTMLDivElement>) => {
    if (allowImages) return
    const target = event.target
    if (!(target instanceof HTMLImageElement)) return
    if (!target.dataset.remote) return
    if (target.closest('a')) return
    event.preventDefault()
    toggleImages()
  }

  return (
    <>
      {(remote || blocked > 0) && !allowImages && (
        <div className="remote-banner">
          <ImageOff size={14} />
          <span style={{ flex: 1 }}>{t(locale, 'reader.remoteBlocked')}</span>
          <button className="btn btn-sm" onClick={toggleImages}>
            {t(locale, 'reader.showImages')}
          </button>
        </div>
      )}

      {html ? (
        <div
          className="mail-html"
          ref={bodyRef}
          onClick={onClickBody}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="mail-text">{detail.textBody}</pre>
      )}

      {visible.length > 0 && (
        <>
          <div
            style={{
              marginTop: 18,
              fontSize: 11.5,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--ink-faint)',
            }}
          >
            {t(locale, 'reader.attachments')} · {visible.length}
          </div>
          <div className="attach-list">
            {visible.map((file) => (
              <button key={file.index} className="attach" onClick={() => void saveAttachment(file)}>
                <span className="attach-icon">
                  <Paperclip size={13} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className="attach-name" style={{ display: 'block' }}>
                    {file.filename || t(locale, 'misc.attachment')}
                  </span>
                  <span className="attach-size">{formatBytes(file.size)}</span>
                </span>
                <Download size={13} style={{ color: 'var(--ink-faint)', flex: 'none' }} />
              </button>
            ))}
          </div>
        </>
      )}
    </>
  )
}

function QuickReply({ detail }: { detail: MessageDetail }) {
  const locale = useUI((state) => state.locale)
  const loadOutbox = useMail((state) => state.loadOutbox)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const send = async () => {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      const quote = detail.htmlBody || ''
      const html = `<p>${escapeText(body).replace(/\n/g, '<br>')}</p><p><br></p><blockquote style="padding-left:12px;border-left:2px solid #d8d8de;color:#6e6e76">${quote}</blockquote>`
      const result = await api.sendMail({
        accountId: detail.accountId,
        to: [detail.fromAddr],
        cc: [],
        bcc: [],
        subject: /^re:/i.test(detail.subject) ? detail.subject : `Re: ${detail.subject}`,
        html,
        attachments: [],
        inReplyTo: detail.messageId,
        references: [...detail.references, detail.messageId].filter(Boolean),
        mode: 'delay',
        delaySeconds: 3,
      })
      setText('')
      void loadOutbox()
      toast.success(t(locale, 'composer.undoSend', { seconds: Math.max(1, result.undoSeconds) }), {
        action: {
          label: t(locale, 'action.undo'),
          onClick: () => void api.cancelOutbox(result.outboxId),
        },
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="reply-box">
      <textarea
        className="reply-input"
        placeholder={t(locale, 'reader.replyHint', { name: detail.fromName || detail.fromAddr })}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void send()
        }}
      />
      <div className="reply-foot">
        <span className="grow" />
        <button className="btn btn-ghost btn-sm" onClick={() => openReply(detail, true)}>
          <ReplyAll size={13} /> {t(locale, 'action.replyAll')}
        </button>
        <button className="btn btn-primary btn-sm" onClick={() => void send()} disabled={!text.trim() || busy}>
          {busy ? <Loader2 size={13} className="spin" /> : <Reply size={13} />}
          {t(locale, 'action.send')}
        </button>
      </div>
    </div>
  )
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
