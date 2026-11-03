import { X } from 'lucide-react'
import { t } from '../lib/i18n'
import { useUI } from '../stores/ui'

const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ['c'], label: 'action.compose' },
  { keys: ['r'], label: 'action.reply' },
  { keys: ['a'], label: 'action.replyAll' },
  { keys: ['f'], label: 'action.forward' },
  { keys: ['j'], label: 'action.next' },
  { keys: ['k'], label: 'action.prev' },
  { keys: ['e'], label: 'action.archive' },
  { keys: ['#'], label: 'action.delete' },
  { keys: ['s'], label: 'action.flag' },
  { keys: ['u'], label: 'action.markUnread' },
  { keys: ['/'], label: 'action.search' },
  { keys: ['Ctrl', 'Enter'], label: 'action.send' },
  { keys: ['Esc'], label: 'action.close' },
]

export function ShortcutsDialog() {
  const locale = useUI((state) => state.locale)
  const closeDialog = useUI((state) => state.closeDialog)

  return (
    <div className="overlay" style={{ zIndex: 45 }}>
      <div className="dialog md">
        <div className="dialog-head">
          <span className="dialog-title">{t(locale, 'misc.help')}</span>
          <button className="icon-btn" onClick={closeDialog}>
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">
          <div className="shortcut-grid">
            {SHORTCUTS.map((item) => (
              <div className="shortcut-item" key={item.label}>
                <span style={{ display: 'flex', gap: 4 }}>
                  {item.keys.map((key) => (
                    <kbd className="kbd" key={key}>
                      {key}
                    </kbd>
                  ))}
                </span>
                <span className="grow">{t(locale, item.label)}</span>
              </div>
            ))}
          </div>
          <div className="hint" style={{ marginTop: 14, lineHeight: 1.7 }}>
            {t(locale, 'misc.shortcuts')}
          </div>
        </div>
        <div className="dialog-foot">
          <span className="grow" />
          <button className="btn btn-primary" onClick={closeDialog}>
            {t(locale, 'action.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
