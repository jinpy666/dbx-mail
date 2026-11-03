import {
  Archive,
  Clock3,
  FileText,
  Folder,
  Inbox,
  Mail,
  Plus,
  Send,
  Settings2,
  ShieldAlert,
  Star,
  Trash2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { t } from '../lib/i18n'
import { useMail } from '../stores/mail'
import type { Scope } from '../stores/mail'
import { useUI } from '../stores/ui'

const ROLE_ICONS: Record<string, LucideIcon> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileText,
  archive: Archive,
  junk: ShieldAlert,
  trash: Trash2,
  flagged: Star,
  all: Mail,
}

const ROLE_ORDER = ['inbox', 'sent', 'drafts', 'archive', 'junk', 'trash']

const ROLE_KEYS: Record<string, string> = {
  inbox: 'nav.inbox',
  sent: 'nav.sent',
  drafts: 'nav.drafts',
  archive: 'nav.archive',
  junk: 'nav.junk',
  trash: 'nav.trash',
  flagged: 'nav.starred',
  all: 'nav.all',
}

function sameScope(scope: Scope, other: Scope): boolean {
  return (
    scope.kind === other.kind &&
    (scope.mailboxId ?? 0) === (other.mailboxId ?? 0) &&
    (scope.accountId ?? 0) === (other.accountId ?? 0)
  )
}

export function Sidebar() {
  const { accounts, mailboxes, counts, scope, syncing, setScope } = useMail()
  const locale = useUI((state) => state.locale)
  const openDialog = useUI((state) => state.openDialog)

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-mark">
            <Mail size={15} strokeWidth={2.4} />
          </span>
          <span className="brand-name">{t(locale, 'app.name')}</span>
        </div>
        <button
          className="icon-btn"
          title={t(locale, 'action.settings')}
          onClick={() => openDialog('settings')}
        >
          <Settings2 size={16} />
        </button>
      </div>

      <div className="side-scroll">
        <div className="side-label">{t(locale, 'nav.favorites')}</div>
        <button
          className={`nav-row ${sameScope(scope, { kind: 'all-inbox' }) ? 'active' : ''}`}
          onClick={() => setScope({ kind: 'all-inbox' })}
        >
          <span className="nav-icon">
            <Inbox size={16} />
          </span>
          <span className="nav-text">{t(locale, 'nav.allInbox')}</span>
          {counts.inboxUnread > 0 && <span className="nav-count">{counts.inboxUnread}</span>}
        </button>
        <button
          className={`nav-row ${sameScope(scope, { kind: 'starred' }) ? 'active' : ''}`}
          onClick={() => setScope({ kind: 'starred' })}
        >
          <span className="nav-icon">
            <Star size={16} />
          </span>
          <span className="nav-text">{t(locale, 'nav.starred')}</span>
          {counts.starred > 0 && <span className="nav-count">{counts.starred}</span>}
        </button>
        <button
          className={`nav-row ${sameScope(scope, { kind: 'outbox' }) ? 'active' : ''}`}
          onClick={() => setScope({ kind: 'outbox' })}
        >
          <span className="nav-icon">
            <Clock3 size={16} />
          </span>
          <span className="nav-text">{t(locale, 'nav.outbox')}</span>
          {counts.outbox > 0 && <span className="nav-count">{counts.outbox}</span>}
        </button>
        <button
          className={`nav-row ${sameScope(scope, { kind: 'drafts' }) ? 'active' : ''}`}
          onClick={() => setScope({ kind: 'drafts' })}
        >
          <span className="nav-icon">
            <FileText size={16} />
          </span>
          <span className="nav-text">{t(locale, 'nav.drafts')}</span>
          {counts.drafts > 0 && <span className="nav-count">{counts.drafts}</span>}
        </button>

        <div className="side-label">{t(locale, 'nav.accounts')}</div>
        {accounts.map((account) => {
          const own = mailboxes
            .filter((mailbox) => mailbox.accountId === account.id)
            .sort((left, right) => {
              const leftIndex = ROLE_ORDER.indexOf(left.role)
              const rightIndex = ROLE_ORDER.indexOf(right.role)
              return (
                (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex) ||
                left.sortOrder - right.sortOrder
              )
            })
          const extras = own.filter((mailbox) => !ROLE_ORDER.includes(mailbox.role) && mailbox.selectable)
          const accountScope: Scope = { kind: 'account', accountId: account.id }
          return (
            <div className="acct" key={account.id}>
              <button
                className={`acct-head ${sameScope(scope, accountScope) ? 'active' : ''}`}
                onClick={() => setScope(accountScope)}
                title={account.email}
              >
                <span className="acct-dot" style={{ background: account.color, color: account.color }} />
                <span className="acct-mail">{account.email}</span>
                {account.lastError && (
                  <span className="acct-badge" title={account.lastError}>
                    <ShieldAlert size={12} />
                  </span>
                )}
              </button>
              {own
                .filter((mailbox) => ROLE_ORDER.includes(mailbox.role))
                .map((mailbox) => {
                  const Icon = ROLE_ICONS[mailbox.role] ?? Folder
                  const active = sameScope(scope, { kind: 'mailbox', mailboxId: mailbox.id })
                  const unread = mailbox.unread
                  // 同一角色可能对上多个真实文件夹（如「垃圾邮件」和「广告邮件」都判为 junk）：
                  // 第一个仍用角色名，后面重复的用服务器上的名字区分
                  const sameRole = own.filter((item) => item.role === mailbox.role)
                  const duplicated = sameRole.findIndex((item) => item.id === mailbox.id) > 0
                  return (
                    <button
                      key={mailbox.id}
                      className={`nav-row ${active ? 'active' : ''}`}
                      onClick={() => setScope({ kind: 'mailbox', mailboxId: mailbox.id, accountId: account.id })}
                    >
                      <span className="nav-icon">
                        <Icon size={15} />
                      </span>
                      <span className="nav-text">
                        {duplicated
                          ? mailbox.name
                          : ROLE_KEYS[mailbox.role]
                            ? t(locale, ROLE_KEYS[mailbox.role])
                            : mailbox.name}
                      </span>
                      {unread > 0 && <span className="nav-count">{unread}</span>}
                    </button>
                  )
                })}
              {extras.map((mailbox) => {
                const active = sameScope(scope, { kind: 'mailbox', mailboxId: mailbox.id })
                return (
                  <button
                    key={mailbox.id}
                    className={`nav-row ${active ? 'active' : ''}`}
                    onClick={() => setScope({ kind: 'mailbox', mailboxId: mailbox.id, accountId: account.id })}
                    title={mailbox.name}
                  >
                    <span className="nav-icon">
                      <Folder size={15} />
                    </span>
                    <span className="nav-text">{mailbox.name}</span>
                    {mailbox.unread > 0 && <span className="nav-count">{mailbox.unread}</span>}
                  </button>
                )
              })}
            </div>
          )
        })}

        <button className="nav-row" style={{ marginTop: 6 }} onClick={() => openDialog('wizard')}>
          <span className="nav-icon">
            <Plus size={16} />
          </span>
          <span className="nav-text">{t(locale, 'nav.addAccount')}</span>
        </button>
      </div>

      <div className="side-foot">
        <span className={`sync-dot ${syncing ? 'busy' : accounts.length ? 'live' : ''}`} />
        <span className="grow">
          {syncing ? t(locale, 'action.sync') : accounts.length ? accountHint(accounts, locale) : t(locale, 'app.noAccountTitle')}
        </span>
        <button
          className="icon-btn"
          title={t(locale, 'misc.help')}
          onClick={() => openDialog('shortcuts')}
          style={{ width: 26, height: 26 }}
        >
          <span style={{ fontSize: 12, fontWeight: 700 }}>?</span>
        </button>
      </div>
    </aside>
  )
}

function accountHint(accounts: Array<{ lastSyncAt: number }>, locale: string): string {
  const latest = accounts.reduce((max, account) => Math.max(max, account.lastSyncAt), 0)
  if (!latest) return t(locale, 'app.never')
  const minutes = Math.max(0, Math.round((Date.now() - latest) / 60_000))
  if (minutes < 1) return t(locale, 'time.justNow')
  if (minutes < 60) return `${t(locale, 'app.lastSync')} · ${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${t(locale, 'app.lastSync')} · ${hours}h`
  return `${t(locale, 'app.lastSync')} · ${Math.round(hours / 24)}d`
}
