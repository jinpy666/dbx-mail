/**
 * 邮件状态
 *
 * 唯一的数据来源：账户、文件夹、设置、列表、当前会话与正文。
 * 所有写操作都是「先请求后端，再更新内存」，后端失败时界面保持原样并抛出错误。
 */
import { create } from 'zustand'
import { toast } from 'sonner'
import * as api from '../lib/rpc'
import type {
  Account,
  Bootstrap,
  Counts,
  Draft,
  Mailbox,
  MessageDetail,
  MessageSummary,
  OutboxItem,
  Settings,
  ThreadItem,
} from '../lib/rpc'
import { demoEnabled } from '../lib/demo'
import { useUI } from './ui'

export type ScopeKind =
  | 'all-inbox'
  | 'starred'
  | 'outbox'
  | 'drafts'
  | 'inbox'
  | 'sent'
  | 'archive'
  | 'junk'
  | 'trash'
  | 'all'
  | 'account'
  | 'mailbox'

export type FilterKind = 'all' | 'unread' | 'flagged' | 'files'

export interface Scope {
  kind: ScopeKind
  mailboxId?: number
  accountId?: number
}

const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  locale: 'zh-CN',
  density: 'comfortable',
  remoteImages: false,
  markReadOnOpen: true,
  undoDelay: 10,
  syncInterval: 5,
  syncScope: 'primary',
  initialLimit: 200,
  layout: 'split',
  conversations: true,
  pageSize: 60,
}

const EMPTY_COUNTS: Counts = { inboxUnread: 0, starred: 0, drafts: 0, outbox: 0 }

interface MailState {
  ready: boolean
  error: string
  demo: boolean
  version: string
  dataDir: string
  vault: 'keyring' | 'local' | ''
  platform: string

  accounts: Account[]
  mailboxes: Mailbox[]
  settings: Settings
  counts: Counts

  scope: Scope
  filter: FilterKind
  query: string

  threads: ThreadItem[]
  loadingList: boolean
  more: boolean
  checked: number[]

  thread: ThreadItem | null
  messages: MessageSummary[]
  activeId: number | null
  detail: MessageDetail | null
  loadingDetail: boolean
  detailError: string
  allowImages: boolean

  drafts: Draft[]
  outboxItems: OutboxItem[]
  syncing: boolean
  lastSyncAt: number

  init: () => Promise<void>
  reloadMeta: () => Promise<void>
  setScope: (scope: Scope) => void
  setFilter: (filter: FilterKind) => void
  setQuery: (query: string) => void
  loadList: (reset?: boolean) => Promise<void>
  openThread: (thread: ThreadItem) => Promise<void>
  closeThread: () => void
  openMessage: (id: number) => Promise<void>
  reloadDetail: () => Promise<void>
  setMessageFlag: (ids: number[], patch: { seen?: boolean; flagged?: boolean; answered?: boolean }) => Promise<void>
  archive: (ids: number[]) => Promise<void>
  trash: (ids: number[]) => Promise<void>
  moveTo: (ids: number[], mailboxId: number) => Promise<void>
  toggleCheck: (id: number) => void
  clearCheck: () => void
  toggleImages: () => void
  loadDrafts: () => Promise<void>
  loadOutbox: () => Promise<void>
  sync: (mailboxId?: number) => Promise<void>
  syncFolderIfNeeded: (mailboxId: number) => Promise<void>
  saveSettings: (patch: Partial<Settings>) => Promise<void>
  addAccount: (payload: Record<string, unknown>) => Promise<Account>
  updateAccount: (payload: Record<string, unknown>) => Promise<void>
  removeAccount: (id: number) => Promise<void>
  importEml: (path: string) => Promise<void>
  exportEml: (ids: number[], dir: string) => Promise<string[]>
}

export const useMail = create<MailState>((set, get) => ({
  ready: false,
  error: '',
  demo: demoEnabled,
  version: '',
  dataDir: '',
  vault: '',
  platform: '',

  accounts: [],
  mailboxes: [],
  settings: DEFAULT_SETTINGS,
  counts: EMPTY_COUNTS,

  scope: { kind: 'all-inbox' },
  filter: 'all',
  query: '',

  threads: [],
  loadingList: false,
  more: false,
  checked: [],

  thread: null,
  messages: [],
  activeId: null,
  detail: null,
  loadingDetail: false,
  detailError: '',
  allowImages: false,

  drafts: [],
  outboxItems: [],
  syncing: false,
  lastSyncAt: 0,

  init: async () => {
    set({ error: '' })
    try {
      const data: Bootstrap = await api.bootstrap()
      applyBootstrap(set, data)
      set({ ready: true })
      await get().loadList(true)
    } catch (error) {
      set({ ready: true, error: error instanceof Error ? error.message : String(error) })
    }
  },

  reloadMeta: async () => {
    try {
      const data = await api.bootstrap()
      applyBootstrap(set, data)
    } catch {
      /* 元数据刷新失败不打断当前阅读 */
    }
  },

  setScope: (scope) => {
    set({ scope, checked: [], thread: null, messages: [], detail: null, activeId: null, query: '' })
    void get().loadList(true)
    if (scope.kind === 'drafts') void get().loadDrafts()
    if (scope.kind === 'outbox') void get().loadOutbox()
    if (scope.kind === 'outbox' || scope.kind === 'drafts') set({ threads: [] })
    // 自定义文件夹不在默认同步范围内，第一次点进来时补拉
    const mailboxId = scope.kind === 'mailbox' ? scope.mailboxId : undefined
    if (mailboxId) void get().syncFolderIfNeeded(mailboxId)
  },

  setFilter: (filter) => {
    set({ filter })
    void get().loadList(true)
  },

  setQuery: (query) => {
    set({ query })
    void get().loadList(true)
  },

  loadList: async (reset = true) => {
    const { scope, filter, query, settings, threads } = get()
    if (scope.kind === 'drafts' || scope.kind === 'outbox') return
    const offset = reset ? 0 : threads.length
    const limit = Math.max(20, settings.pageSize || 60)
    set({ loadingList: true })
    try {
      const page = await api.listThreads({ ...listParams(scope, filter, query), limit, offset })
      const items = reset ? page.items : dedupe([...threads, ...page.items])
      set({ threads: items, more: page.items.length >= limit, loadingList: false })
    } catch (error) {
      set({ loadingList: false, error: error instanceof Error ? error.message : String(error) })
    }
  },

  openThread: async (thread) => {
    set({
      thread,
      messages: [],
      detail: null,
      activeId: null,
      loadingDetail: true,
      detailError: '',
      allowImages: get().settings.remoteImages,
    })
    try {
      const { items } = await api.loadThread(thread.accountId, thread.threadId)
      const ordered = items.slice().sort((left, right) => left.date - right.date)
      set({ messages: ordered, loadingDetail: false })
      const target = ordered.find((item) => !item.seen) ?? ordered[ordered.length - 1]
      if (target) await get().openMessage(target.id)
    } catch (error) {
      set({ loadingDetail: false, detailError: error instanceof Error ? error.message : String(error) })
    }
  },

  closeThread: () => set({ thread: null, messages: [], detail: null, activeId: null, detailError: '' }),

  openMessage: async (id) => {
    set({ activeId: id, loadingDetail: true, detailError: '' })
    try {
      const detail = await api.openMessage(id, true)
      set({ detail, loadingDetail: false })
      if (!detail.seen && get().settings.markReadOnOpen) {
        await get().setMessageFlag([id], { seen: true })
      }
    } catch (error) {
      set({
        loadingDetail: false,
        detailError: error instanceof Error ? error.message : String(error),
      })
    }
  },

  reloadDetail: async () => {
    const detail = get().detail
    if (!detail) return
    try {
      const fresh = await api.openMessage(detail.id, true)
      set({ detail: fresh })
    } catch (error) {
      set({ detailError: error instanceof Error ? error.message : String(error) })
    }
  },

  setMessageFlag: async (ids, patch) => {
    if (!ids.length) return
    await api.setFlags(ids, patch)
    set((state) => ({
      messages: state.messages.map((message) => (ids.includes(message.id) ? { ...message, ...patch } : message)),
      detail:
        state.detail && ids.includes(state.detail.id) ? { ...state.detail, ...patch } : state.detail,
      thread: state.thread
        ? {
            ...state.thread,
            flagged:
              patch.flagged === undefined
                ? state.thread.flagged
                : patch.flagged || state.messages.some((message) => ids.includes(message.id) && message.flagged),
            unread:
              patch.seen === undefined
                ? state.thread.unread
                : Math.max(
                    0,
                    state.thread.unread +
                      (patch.seen
                        ? -state.messages.filter((message) => ids.includes(message.id) && !message.seen).length
                        : state.messages.filter((message) => ids.includes(message.id) && message.seen).length),
                  ),
          }
        : null,
      threads: state.threads.map((item) =>
        ids.includes(item.latestId) && patch.flagged !== undefined
          ? { ...item, flagged: patch.flagged }
          : item,
      ),
    }))
    void refreshCounts(set)
  },

  archive: async (ids) => {
    if (!ids.length) return
    await api.moveMessages(ids, { kind: 'archive' })
    afterMove(set, get, ids)
  },

  trash: async (ids) => {
    if (!ids.length) return
    await api.moveMessages(ids, { kind: 'trash' })
    afterMove(set, get, ids)
  },

  moveTo: async (ids, mailboxId) => {
    if (!ids.length) return
    await api.moveMessages(ids, { kind: 'mailbox', mailboxId })
    afterMove(set, get, ids)
  },

  toggleCheck: (id) =>
    set((state) => ({
      checked: state.checked.includes(id)
        ? state.checked.filter((item) => item !== id)
        : [...state.checked, id],
    })),

  clearCheck: () => set({ checked: [] }),

  toggleImages: () => set((state) => ({ allowImages: !state.allowImages })),

  loadDrafts: async () => {
    try {
      const { items } = await api.listDrafts()
      set({ drafts: items })
    } catch {
      /* 草稿列表失败不阻塞界面 */
    }
  },

  loadOutbox: async () => {
    try {
      const { items } = await api.listOutbox()
      set({ outboxItems: items })
    } catch {
      /* 同上 */
    }
  },

  sync: async (mailboxId) => {
    if (get().syncing) return
    set({ syncing: true })
    try {
      const params: { mailboxId?: number } = {}
      if (mailboxId) params.mailboxId = mailboxId
      await api.syncNow(params)
      const data = await api.bootstrap()
      applyBootstrap(set, data)
      await get().loadList(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      toast.error(message)
    } finally {
      set({ syncing: false, lastSyncAt: Date.now() })
    }
  },

  /**
   * 首次进入某个文件夹时按需拉取
   *
   * 同步范围默认只覆盖收件箱/已发送/草稿/存档，自定义文件夹（如「12306」「通行费」）
   * 从来没有邮件头，点进去就是空的。uidValidity 为 0 说明这个文件夹从未同步过，
   * 这里主动拉一次；同步过（或服务器上本来就是空文件夹）就不会再触发。
   */
  syncFolderIfNeeded: async (mailboxId) => {
    const mailbox = get().mailboxes.find((item) => item.id === mailboxId)
    if (!mailbox || !mailbox.selectable) return
    if (mailbox.uidValidity > 0 || mailbox.lastUid > 0) return
    if (get().syncing) return
    await get().sync(mailboxId)
  },

  saveSettings: async (patch) => {
    const next = { ...get().settings, ...patch }
    set({ settings: next })
    if (patch.locale) useUI.getState().setLocale(patch.locale)
    try {
      const result = await api.saveSettings(next)
      set({ settings: result.settings })
    } catch (error) {
      set({ settings: get().settings })
      throw error
    }
  },

  addAccount: async (payload) => {
    const result = await api.accountAdd(payload)
    await get().reloadMeta()
    void get().sync()
    return result.account
  },

  updateAccount: async (payload) => {
    await api.accountUpdate(payload)
    await get().reloadMeta()
  },

  removeAccount: async (id) => {
    await api.accountRemove(id)
    const accounts = get().accounts.filter((account) => account.id !== id)
    set({
      accounts,
      mailboxes: get().mailboxes.filter((mailbox) => mailbox.accountId !== id),
      thread: null,
      messages: [],
      detail: null,
      activeId: null,
      scope: accounts.length ? { kind: 'all-inbox' } : { kind: 'all-inbox' },
    })
    await get().reloadMeta()
    await get().loadList(true)
  },

  importEml: async (path) => {
    const { scope, mailboxes, accounts } = get()
    let mailboxId = scope.mailboxId ?? 0
    let accountId = scope.accountId ?? 0
    if (!mailboxId) {
      const inbox = mailboxes.find((mailbox) => mailbox.role === 'inbox' && mailbox.selectable)
      mailboxId = inbox?.id ?? 0
      accountId = inbox?.accountId ?? accounts[0]?.id ?? 0
    }
    if (!mailboxId) throw new Error('先添加一个账户')
    await api.importEml(accountId, mailboxId, path)
    await get().loadList(true)
    await refreshCounts(set)
  },

  exportEml: async (ids, dir) => {
    const result = await api.exportEml(ids, dir)
    return result.paths
  },
}))

/* ---------------- 内部工具 ---------------- */

type Setter = (partial: Partial<MailState> | ((state: MailState) => Partial<MailState>)) => void

function applyBootstrap(set: Setter, data: Bootstrap) {
  const settings = { ...DEFAULT_SETTINGS, ...data.settings }
  set({
    version: data.version,
    dataDir: data.dataDir,
    vault: data.vault,
    platform: data.platform,
    accounts: data.accounts,
    mailboxes: data.mailboxes,
    settings,
    counts: data.counts,
  })
  useUI.getState().setLocale(settings.locale)
}

function listParams(scope: Scope, filter: FilterKind, query: string) {
  const params: Parameters<typeof api.listThreads>[0] = { kind: filter, query }
  if (scope.mailboxId) params.mailboxId = scope.mailboxId
  if (scope.accountId) params.accountId = scope.accountId
  switch (scope.kind) {
    case 'all-inbox':
    case 'inbox':
      params.role = 'inbox'
      break
    case 'starred':
      params.role = 'starred'
      break
    case 'all':
      params.role = 'all'
      break
    case 'sent':
    case 'archive':
    case 'junk':
    case 'trash':
      params.role = scope.kind
      break
    default:
      break
  }
  return params
}

function dedupe(items: ThreadItem[]): ThreadItem[] {
  const seen = new Map<string, ThreadItem>()
  for (const item of items) seen.set(`${item.accountId}:${item.threadId}`, item)
  return Array.from(seen.values())
}

async function refreshCounts(set: Setter) {
  try {
    const data = await api.bootstrap()
    set({ counts: data.counts, mailboxes: data.mailboxes, accounts: data.accounts })
  } catch {
    /* 计数刷新失败不影响主流程 */
  }
}

function afterMove(set: Setter, get: () => MailState, ids: number[]) {
  const state = get()
  const keep = (item: ThreadItem) => !ids.includes(item.latestId)
  set({
    threads: state.threads.filter(keep),
    messages: state.messages.filter((message) => !ids.includes(message.id)),
    checked: [],
  })
  if (state.messages.every((message) => ids.includes(message.id))) {
    set({ thread: null, detail: null, activeId: null })
  }
  void refreshCounts(set)
}

export { DEFAULT_SETTINGS }
