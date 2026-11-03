import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, ChevronDown, Loader2, Plus, Server, X } from 'lucide-react'
import { toast } from 'sonner'
import { t } from '../lib/i18n'
import * as api from '../lib/rpc'
import type { ProviderPreset } from '../lib/rpc'
import { useMail } from '../stores/mail'
import { useUI } from '../stores/ui'

interface FormState {
  email: string
  password: string
  displayName: string
  imapHost: string
  imapPort: number
  imapSecurity: string
  smtpHost: string
  smtpPort: number
  smtpSecurity: string
  signature: string
}

const EMPTY: FormState = {
  email: '',
  password: '',
  displayName: '',
  imapHost: '',
  imapPort: 993,
  imapSecurity: 'tls',
  smtpHost: '',
  smtpPort: 465,
  smtpSecurity: 'tls',
  signature: '',
}

export function AccountWizard() {
  const locale = useUI((state) => state.locale)
  const closeDialog = useUI((state) => state.closeDialog)
  const addAccount = useMail((state) => state.addAccount)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [advanced, setAdvanced] = useState(false)
  const [testing, setTesting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    void api
      .accountPresets()
      .then((result) => setPresets(result.items))
      .catch(() => setPresets([]))
  }, [])

  const domain = form.email.split('@')[1]?.toLowerCase() ?? ''
  const matched = useMemo(
    () =>
      presets.find((preset) =>
        preset.domains.some((item) => domain === item || domain.endsWith(`.${item}`)),
      ),
    [presets, domain],
  )

  useEffect(() => {
    if (!matched) return
    setForm((state) => ({
      ...state,
      imapHost: matched.imapHost,
      imapPort: matched.imapPort,
      imapSecurity: matched.imapSecurity,
      smtpHost: matched.smtpHost,
      smtpPort: matched.smtpPort,
      smtpSecurity: matched.smtpSecurity,
    }))
  }, [matched])

  const update = (patch: Partial<FormState>) => setForm((state) => ({ ...state, ...patch }))

  const payload = () => ({
    email: form.email.trim(),
    password: form.password,
    displayName: form.displayName.trim(),
    username: form.email.trim(),
    imapHost: form.imapHost.trim(),
    imapPort: form.imapPort,
    imapSecurity: form.imapSecurity,
    smtpHost: form.smtpHost.trim(),
    smtpPort: form.smtpPort,
    smtpSecurity: form.smtpSecurity,
    signature: form.signature,
    verify: false,
  })

  const test = async () => {
    if (!form.email.includes('@') || !form.password) {
      setError(t(locale, 'wizard.required'))
      return
    }
    setTesting(true)
    setError('')
    setLines([])
    try {
      const result = await api.accountTest({ ...payload(), verify: true })
      setLines([t(locale, 'wizard.testOk'), ...result.lines])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setTesting(false)
    }
  }

  const submit = async () => {
    if (!form.email.includes('@') || !form.password) {
      setError(t(locale, 'wizard.required'))
      return
    }
    setBusy(true)
    setError('')
    try {
      await addAccount(payload())
      toast.success(t(locale, 'wizard.added'))
      closeDialog()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" style={{ zIndex: 45 }}>
      <div className="dialog md">
        <div className="dialog-head">
          <Plus size={16} style={{ color: 'var(--accent)' }} />
          <span className="dialog-title">{t(locale, 'wizard.title')}</span>
          <button className="icon-btn" onClick={closeDialog}>
            <X size={16} />
          </button>
        </div>

        <div className="dialog-body">
          <div className="field">
            <span className="field-label">{t(locale, 'wizard.email')}</span>
            <input
              className="input"
              autoFocus
              value={form.email}
              placeholder="name@example.com"
              onChange={(event) => update({ email: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit()
              }}
            />
          </div>

          <div className="field">
            <span className="field-label">{t(locale, 'wizard.password')}</span>
            <input
              className="input"
              type="password"
              value={form.password}
              onChange={(event) => update({ password: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit()
              }}
            />
            <span className="hint">{t(locale, 'wizard.passwordHint')}</span>
          </div>

          <div className="field">
            <span className="field-label">{t(locale, 'wizard.displayName')}</span>
            <input
              className="input"
              value={form.displayName}
              onChange={(event) => update({ displayName: event.target.value })}
            />
          </div>

          {matched && (
            <div
              style={{
                display: 'flex',
                gap: 8,
                padding: '9px 11px',
                borderRadius: 10,
                background: 'var(--accent-tint)',
                color: 'var(--accent)',
                fontSize: 12.5,
                marginBottom: 12,
              }}
            >
              <CheckCircle2 size={14} style={{ marginTop: 1, flex: 'none' }} />
              <span>
                <b>{t(locale, 'wizard.autoConfig')}</b> · {matched.label}
                {matched.hint ? ` · ${matched.hint}` : ''}
              </span>
            </div>
          )}

          <button
            className="btn btn-ghost btn-sm"
            style={{ marginBottom: advanced ? 10 : 4 }}
            onClick={() => setAdvanced(!advanced)}
          >
            <Server size={13} />
            {advanced ? t(locale, 'action.hideDetails') : t(locale, 'wizard.advanced')}
            <ChevronDown size={13} style={{ transform: advanced ? 'rotate(180deg)' : 'none' }} />
          </button>

          {advanced && (
            <div className="fade-in">
              <div className="field-label" style={{ marginBottom: 6 }}>
                {t(locale, 'wizard.imap')}
              </div>
              <div className="field-row" style={{ marginBottom: 12 }}>
                <input
                  className="input"
                  placeholder="imap.example.com"
                  value={form.imapHost}
                  onChange={(event) => update({ imapHost: event.target.value })}
                />
                <input
                  className="input"
                  type="number"
                  value={form.imapPort}
                  onChange={(event) => update({ imapPort: Number(event.target.value) || 993 })}
                />
                <select
                  className="select"
                  value={form.imapSecurity}
                  onChange={(event) => update({ imapSecurity: event.target.value })}
                >
                  <option value="tls">{t(locale, 'wizard.security.tls')}</option>
                  <option value="starttls">{t(locale, 'wizard.security.starttls')}</option>
                  <option value="none">{t(locale, 'wizard.security.none')}</option>
                </select>
              </div>

              <div className="field-label" style={{ marginBottom: 6 }}>
                {t(locale, 'wizard.smtp')}
              </div>
              <div className="field-row" style={{ marginBottom: 12 }}>
                <input
                  className="input"
                  placeholder="smtp.example.com"
                  value={form.smtpHost}
                  onChange={(event) => update({ smtpHost: event.target.value })}
                />
                <input
                  className="input"
                  type="number"
                  value={form.smtpPort}
                  onChange={(event) => update({ smtpPort: Number(event.target.value) || 465 })}
                />
                <select
                  className="select"
                  value={form.smtpSecurity}
                  onChange={(event) => update({ smtpSecurity: event.target.value })}
                >
                  <option value="tls">{t(locale, 'wizard.security.tls')}</option>
                  <option value="starttls">{t(locale, 'wizard.security.starttls')}</option>
                  <option value="none">{t(locale, 'wizard.security.none')}</option>
                </select>
              </div>

              <div className="field">
                <span className="field-label">{t(locale, 'settings.signature')}</span>
                <textarea
                  className="input"
                  value={form.signature}
                  onChange={(event) => update({ signature: event.target.value })}
                />
              </div>
            </div>
          )}

          {error && (
            <div style={{ color: 'var(--red)', fontSize: 12.5, lineHeight: 1.5, marginTop: 4 }}>{error}</div>
          )}
          {lines.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--green)' }}>
              {lines.map((line) => (
                <div key={line}>· {line}</div>
              ))}
            </div>
          )}
        </div>

        <div className="dialog-foot">
          <button className="btn btn-ghost" onClick={() => void test()} disabled={testing}>
            {testing ? <Loader2 size={13} className="spin" /> : <Server size={13} />}
            {testing ? t(locale, 'wizard.testing') : t(locale, 'wizard.test')}
          </button>
          <span className="grow" />
          <button className="btn" onClick={closeDialog}>
            {t(locale, 'action.cancel')}
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
            {busy ? t(locale, 'wizard.adding') : t(locale, 'wizard.add')}
          </button>
        </div>
      </div>
    </div>
  )
}
