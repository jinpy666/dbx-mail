import { useCallback, useEffect, useState } from 'react'
import { ArrowUp, File, Folder, HardDrive, Home, Loader2, X } from 'lucide-react'
import { t } from '../lib/i18n'
import { formatBytes } from '../lib/format'
import * as api from '../lib/rpc'
import type { DirEntry, DirListing } from '../lib/rpc'
import { useUI } from '../stores/ui'

export function DirPickerDialog() {
  const request = useUI((state) => state.dirPicker)
  const close = useUI((state) => state.closeDirPicker)
  const locale = useUI((state) => state.locale)
  const [listing, setListing] = useState<DirListing | null>(null)
  const [files, setFiles] = useState<DirEntry[]>([])
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const isFile = request?.mode === 'file'

  const load = useCallback(
    async (path: string) => {
      if (!request) return
      setLoading(true)
      setError('')
      setSelected('')
      try {
        const [dirs, fileList] = await Promise.all([
          api.listDirs(path),
          request.mode === 'file' ? api.listFiles(path) : Promise.resolve({ items: [] as DirEntry[] }),
        ])
        setListing(dirs)
        setFiles(fileList.items)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setLoading(false)
      }
    },
    [request],
  )

  useEffect(() => {
    if (!request) return
    void load(request.start)
  }, [request, load])

  if (!request) return null

  const title = request.title || (isFile ? t(locale, 'dir.titleFile') : t(locale, 'dir.title'))

  const confirm = () => {
    if (isFile) {
      if (selected) close(selected)
      return
    }
    if (listing) close(listing.path)
  }

  return (
    <div className="overlay" style={{ zIndex: 50 }}>
      <div className="dialog md" style={{ maxHeight: 'min(620px, calc(100vh - 40px))' }}>
        <div className="dialog-head">
          <span className="dialog-title">{title}</span>
          <button className="icon-btn" onClick={() => close(null)}>
            <X size={16} />
          </button>
        </div>

        <div className="path-bar">
          <button
            className="icon-btn"
            style={{ width: 28, height: 28 }}
            title={t(locale, 'dir.up')}
            disabled={!listing?.parent}
            onClick={() => listing?.parent && void load(listing.parent)}
          >
            <ArrowUp size={15} />
          </button>
          <span className="path-text" title={listing?.path}>
            {listing?.path || (loading ? t(locale, 'misc.loading') : '—')}
          </span>
          {loading && <Loader2 size={14} className="spin" style={{ color: 'var(--ink-faint)' }} />}
        </div>

        {listing && listing.shortcuts.length > 0 && (
          <div className="shortcuts">
            {listing.shortcuts.map((entry) => (
              <button key={entry.path} className="shortcut" onClick={() => void load(entry.path)}>
                <Home size={11} /> {entry.name}
              </button>
            ))}
            {listing.roots
              .filter((root) => !listing.shortcuts.some((item) => item.path === root.path))
              .map((root) => (
                <button key={root.path} className="shortcut" onClick={() => void load(root.path)}>
                  <HardDrive size={11} /> {root.name}
                </button>
              ))}
          </div>
        )}

        <div className="dialog-body" style={{ padding: '8px 10px' }}>
          {error && <div style={{ padding: 12, color: 'var(--red)', fontSize: 12.5 }}>{error}</div>}

          {!error && !loading && listing?.entries.length === 0 && files.length === 0 && (
            <div className="empty-list">
              <div className="art">
                <Folder size={20} />
              </div>
              <div className="desc">{t(locale, 'dir.empty')}</div>
            </div>
          )}

          {listing?.entries.map((entry) => (
            <button
              key={entry.path}
              className="entry"
              onDoubleClick={() => void load(entry.path)}
              onClick={() => {
                if (isFile) setSelected('')
                void load(entry.path)
              }}
            >
              <Folder size={15} style={{ color: 'var(--accent)' }} />
              <span className="name">{entry.name}</span>
            </button>
          ))}

          {isFile &&
            files.map((entry) => (
              <button
                key={entry.path}
                className={`entry ${selected === entry.path ? 'selected' : ''}`}
                onClick={() => setSelected(entry.path)}
                onDoubleClick={() => close(entry.path)}
              >
                <File size={15} style={{ color: 'var(--ink-faint)' }} />
                <span className="name">{entry.name}</span>
                <span className="meta">{formatBytes(entry.size ?? 0)}</span>
              </button>
            ))}
        </div>

        <div className="dialog-foot">
          <span className="grow" style={{ fontSize: 11.5, color: 'var(--ink-faint)' }}>
            {isFile ? selected : listing?.path}
          </span>
          <button className="btn btn-ghost" onClick={() => close(null)}>
            {t(locale, 'action.cancel')}
          </button>
          <button className="btn btn-primary" onClick={confirm} disabled={isFile ? !selected : !listing}>
            {isFile ? t(locale, 'dir.selectFile') : t(locale, 'dir.choose')}
          </button>
        </div>
      </div>
    </div>
  )
}
