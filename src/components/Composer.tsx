import { useEffect, useRef, useState } from 'react'
import {
  Bold,
  ChevronDown,
  Code2,
  Italic,
  Link2,
  List,
  ListOrdered,
  Loader2,
  Paperclip,
  Quote,
  RemoveFormatting,
  Send,
  Strikethrough,
  Underline,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { sanitizeComposerHtml } from '../lib/html'
import { t } from '../lib/i18n'
import { displayName, emailOf, formatBytes } from '../lib/format'
import { useComposer } from '../stores/composer'
import type { Composer } from '../stores/composer'
import { useMail } from '../stores/mail'
import { useUI } from '../stores/ui'
import { cancelOutbox } from '../lib/rpc'

export function ComposerLayer() {
  const items = useComposer((state) => state.items)
  if (!items.length) return null
  return (
    <>
      {items.map((item, index) => (
        <ComposerWindow key={item.key} composer={item} stacked={index > 0} />
      ))}
    </>
  )
}

function ComposerWindow({ composer, stacked }: { composer: Composer; stacked: boolean }) {
  const locale = useUI((state) => state.locale)
  const accounts = useMail((state) => state.accounts)
  const patch = useComposer((state) => state.patch)
  const close = useComposer((state) => state.close)
  const discard = useComposer((state) => state.discard)
  const send = useComposer((state) => state.send)
  const attach = useComposer((state) => state.attach)
  const detach = useComposer((state) => state.detach)
  const saveDraft = useComposer((state) => state.saveDraft)

  const bodyRef = useRef<HTMLDivElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const caretPlaced = useRef(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [askDiscard, setAskDiscard] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    const element = bodyRef.current
    if (!element) return
    // 最后一道收口：不管内容来自回复引用、草稿还是将来的新路径，赋值前统一净化
    const safe = sanitizeComposerHtml(composer.html)
    if (element.innerHTML !== safe) element.innerHTML = safe
    // 仅在切换草稿/新建时灌入初始内容，避免每次输入重设光标
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composer.key])

  useEffect(() => {
    if (!composer.touched) return
    const timer = window.setTimeout(() => {
      void saveDraft(composer.key, true).catch(() => undefined)
    }, 4500)
    return () => window.clearTimeout(timer)
  }, [composer.html, composer.to, composer.cc, composer.subject, composer.touched, composer.key, saveDraft])

  const title = () => {
    switch (composer.mode) {
      case 'reply':
        return t(locale, 'composer.reply')
      case 'replyAll':
        return t(locale, 'action.replyAll')
      case 'forward':
        return t(locale, 'composer.forward')
      case 'draft':
        return t(locale, 'composer.draft')
      default:
        return t(locale, 'composer.new')
    }
  }

  const syncBody = () => {
    const element = bodyRef.current
    if (element) patch(composer.key, { html: element.innerHTML })
  }

  const exec = (command: string, value?: string) => {
    bodyRef.current?.focus()
    document.execCommand(command, false, value)
    syncBody()
  }

  const insertLink = () => {
    const url = window.prompt(t(locale, 'composer.link'), 'https://')
    if (!url) return
    exec('createLink', url)
  }

  const doSend = async (mode: 'now' | 'delay' | 'schedule', seconds?: number) => {
    setMenuOpen(false)
    if (!composer.to.trim()) {
      toast.error(t(locale, 'composer.emptyWarn'))
      return
    }
    if (!composer.accountId) {
      toast.error(t(locale, 'wizard.required'))
      return
    }
    syncBody()
    try {
      const requestedAt = mode === 'schedule' ? tomorrowMorning() : undefined
      const result = await send(composer.key, {
        mode,
        delaySeconds: seconds,
        scheduledAt: requestedAt,
      })
      toast.success(t(locale, 'composer.undoSend', { seconds: Math.max(1, result.undoSeconds) }), {
        action: {
          label: t(locale, 'action.undo'),
          onClick: () => {
            void cancelOutbox(result.outboxId)
            toast.success(t(locale, 'outbox.canceledToast'))
          },
        },
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  const requestClose = () => {
    if (!composer.touched && !composer.attachments.length) {
      close(composer.key)
      return
    }
    setAskDiscard(true)
  }

  const account = accounts.find((item) => item.id === composer.accountId)
  const toHint = recipientHint(composer.to)

  return (
    <div className="overlay" style={stacked ? { zIndex: 41 } : undefined}>
      <div
        className="composer"
        onDragOver={(event) => {
          event.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragOver(false)
          const files = Array.from(event.dataTransfer.files)
          if (files.length) void attach(composer.key, files)
        }}
        style={dragOver ? { outline: '2px dashed var(--accent)', outlineOffset: -6 } : undefined}
      >
        <div className="cmp-head">
          <span className="cmp-title">{title()}</span>
          <button className="icon-btn" onClick={requestClose} title={t(locale, 'action.close')}>
            <X size={16} />
          </button>
        </div>

        {accounts.length > 1 && (
          <label className="cmp-field">
            <span className="cmp-field-label">{t(locale, 'composer.from')}</span>
            <select
              className="select"
              style={{ border: 0, background: 'transparent', height: 32, paddingLeft: 0 }}
              value={composer.accountId}
              onChange={(event) => patch(composer.key, { accountId: Number(event.target.value) })}
            >
              {accounts.map((item) => (
                <option key={item.id} value={item.id}>
                  {displayName(item.displayName, item.email)} &lt;{item.email}&gt;
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="cmp-field">
          <span className="cmp-field-label">{t(locale, 'composer.to')}</span>
          <input
            value={composer.to}
            placeholder={account?.email ?? ''}
            onChange={(event) => patch(composer.key, { to: event.target.value })}
            onBlur={() => {
              if (composer.to) patch(composer.key, { to: composer.to })
            }}
          />
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => patch(composer.key, { showCc: !composer.showCc })}
          >
            {composer.showCc ? t(locale, 'composer.hideCc') : t(locale, 'composer.addCc')}
          </button>
        </div>

        {composer.showCc && (
          <>
            <div className="cmp-field">
              <span className="cmp-field-label">{t(locale, 'composer.cc')}</span>
              <input
                value={composer.cc}
                onChange={(event) => patch(composer.key, { cc: event.target.value })}
              />
            </div>
            <div className="cmp-field">
              <span className="cmp-field-label">{t(locale, 'composer.bcc')}</span>
              <input
                value={composer.bcc}
                onChange={(event) => patch(composer.key, { bcc: event.target.value })}
              />
            </div>
          </>
        )}

        <div className="cmp-field">
          <input
            className="subject"
            placeholder={t(locale, 'composer.subject')}
            value={composer.subject}
            onChange={(event) => patch(composer.key, { subject: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') bodyRef.current?.focus()
            }}
          />
        </div>

        <div className="cmp-tools">
          <button className="tool-btn" title={t(locale, 'composer.bold')} onClick={() => exec('bold')}>
            <Bold size={14} />
          </button>
          <button className="tool-btn" title={t(locale, 'composer.italic')} onClick={() => exec('italic')}>
            <Italic size={14} />
          </button>
          <button
            className="tool-btn"
            title={t(locale, 'composer.underline')}
            onClick={() => exec('underline')}
          >
            <Underline size={14} />
          </button>
          <button
            className="tool-btn"
            title={t(locale, 'composer.strike')}
            onClick={() => exec('strikeThrough')}
          >
            <Strikethrough size={14} />
          </button>
          <button
            className="tool-btn"
            title={t(locale, 'composer.code')}
            onClick={() => exec('fontName', 'monospace')}
          >
            <Code2 size={14} />
          </button>
          <span className="cap-sep" />
          <button className="tool-btn" title={t(locale, 'composer.link')} onClick={insertLink}>
            <Link2 size={14} />
          </button>
          <button className="tool-btn" title={t(locale, 'composer.quote')} onClick={() => exec('formatBlock', 'blockquote')}>
            <Quote size={14} />
          </button>
          <button
            className="tool-btn"
            title={t(locale, 'composer.bullets')}
            onClick={() => exec('insertUnorderedList')}
          >
            <List size={14} />
          </button>
          <button
            className="tool-btn"
            title={t(locale, 'composer.numbered')}
            onClick={() => exec('insertOrderedList')}
          >
            <ListOrdered size={14} />
          </button>
          <button
            className="tool-btn"
            title={t(locale, 'composer.clear')}
            onClick={() => exec('removeFormat')}
          >
            <RemoveFormatting size={14} />
          </button>
        </div>

        <div
          className="cmp-body"
          ref={bodyRef}
          contentEditable
          suppressContentEditableWarning
          data-placeholder={t(locale, 'composer.body')}
          onInput={syncBody}
          onMouseUp={() => {
            // 第一次点击正文时把光标放到签名之前，别让用户写在签名下面。
            // 必须在 mouseup 里做：点击的默认行为会在 focus 之后重新定位光标。
            if (caretPlaced.current) return
            caretPlaced.current = true
            const element = bodyRef.current
            const signature = element?.querySelector('[data-signature]')
            if (!element || !signature) return
            const range = document.createRange()
            const anchor = signature.previousElementSibling
            if (anchor) {
              range.setStart(anchor, 0)
            } else {
              range.setStartBefore(signature)
            }
            range.collapse(true)
            const selection = window.getSelection()
            selection?.removeAllRanges()
            selection?.addRange(range)
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void doSend('now')
          }}
        />

        {composer.attachments.length > 0 && (
          <div className="cmp-attachments">
            {composer.attachments.map((file) => (
              <span className="attach-chip" key={file.path}>
                <Paperclip size={11} />
                <span className="name" title={file.name}>
                  {file.name}
                </span>
                <span className="hint">{formatBytes(file.size)}</span>
                <button className="x" onClick={() => detach(composer.key, file.path)}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        {composer.error && (
          <div style={{ padding: '0 16px 8px', color: 'var(--red)', fontSize: 12 }}>{composer.error}</div>
        )}

        <div className="cmp-foot">
          <button
            className="icon-btn"
            title={t(locale, 'action.addAttachment')}
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip size={16} />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              if (files.length) void attach(composer.key, files)
              event.target.value = ''
            }}
          />

          {askDiscard ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
              <span style={{ fontSize: 12.5, color: 'var(--ink-dim)' }}>{t(locale, 'composer.discardDesc')}</span>
              <button
                className="btn btn-sm"
                onClick={async () => {
                  await saveDraft(composer.key)
                  close(composer.key)
                }}
              >
                {t(locale, 'composer.keepDraft')}
              </button>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => {
                  void discard(composer.key)
                  void useMail.getState().loadDrafts()
                }}
              >
                {t(locale, 'action.discard')}
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => setAskDiscard(false)}>
                {t(locale, 'action.cancel')}
              </button>
            </div>
          ) : (
            <>
              <span className="grow">
                {composer.savedAt ? t(locale, 'composer.saved') : toHint || t(locale, 'composer.attachHint')}
              </span>
              <div style={{ position: 'relative' }}>
                <div className="split">
                  <button
                    className="btn btn-primary"
                    onClick={() => void doSend('now')}
                    disabled={composer.sending}
                  >
                    {composer.sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
                    {composer.sending ? t(locale, 'composer.sending') : t(locale, 'action.send')}
                  </button>
                  <button className="split-more" onClick={() => setMenuOpen(!menuOpen)} title={t(locale, 'action.sendLater')}>
                    <ChevronDown size={14} />
                  </button>
                </div>
                {menuOpen && (
                  <>
                    <div style={{ position: 'fixed', inset: 0, zIndex: 45 }} onClick={() => setMenuOpen(false)} />
                    <div className="menu" style={{ right: 0, bottom: 42 }}>
                      <button onClick={() => void doSend('now')}>
                        <Send size={14} /> {t(locale, 'composer.sendNow')}
                      </button>
                      <button onClick={() => void doSend('delay', 600)}>
                        <Send size={14} /> {t(locale, 'composer.sendIn10')}
                      </button>
                      <button onClick={() => void doSend('delay', 3600)}>
                        <Send size={14} /> {t(locale, 'composer.sendIn1h')}
                      </button>
                      <button onClick={() => void doSend('schedule')}>
                        <Send size={14} /> {t(locale, 'composer.sendTomorrow')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function tomorrowMorning(): number {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  date.setHours(9, 0, 0, 0)
  return date.getTime()
}

function recipientHint(value: string): string {
  const parts = value
    .split(/[,;]/)
    .map((part) => emailOf(part.trim()))
    .filter(Boolean)
  if (!parts.length) return ''
  return parts.length === 1 ? parts[0] : `${parts[0]} +${parts.length - 1}`
}
