/**
 * 界面外壳状态：语言、外观、当前弹层、目录选择请求
 *
 * 业务数据放在 useMail 里；这里只放「窗口级」的东西，避免两个 store 互相引用。
 */
import { create } from 'zustand'
import { hostAppearance, hostLocale } from '../lib/bridge'

export type DialogName = 'settings' | 'wizard' | 'shortcuts' | null
export type SettingsTab = 'general' | 'accounts' | 'sync' | 'about'

export interface DirPickerRequest {
  mode: 'dir' | 'file'
  start: string
  title: string
  resolve: (value: string | null) => void
}

interface UIState {
  locale: string
  appearance: 'light' | 'dark'
  dialog: DialogName
  settingsTab: SettingsTab
  sidebarHidden: boolean
  dirPicker: DirPickerRequest | null
  setLocale: (locale: string) => void
  setAppearance: (appearance: 'light' | 'dark') => void
  openDialog: (dialog: DialogName, tab?: SettingsTab) => void
  closeDialog: () => void
  toggleSidebar: () => void
  closeDirPicker: (value: string | null) => void
}

export const useUI = create<UIState>((set, get) => ({
  locale: hostLocale(),
  appearance: hostAppearance(),
  dialog: null,
  settingsTab: 'general',
  sidebarHidden: false,
  dirPicker: null,
  setLocale: (locale) => set({ locale }),
  setAppearance: (appearance) => set({ appearance }),
  openDialog: (dialog, tab) =>
    set((state) => ({ dialog, settingsTab: tab ?? (dialog === 'settings' ? state.settingsTab : 'general') })),
  closeDialog: () => set({ dialog: null }),
  toggleSidebar: () => set((state) => ({ sidebarHidden: !state.sidebarHidden })),
  closeDirPicker: (value) => {
    const request = get().dirPicker
    set({ dirPicker: null })
    request?.resolve(value)
  },
}))

/** 弹出目录选择器；用户取消返回 null */
export function pickDirectory(start = '', title = ''): Promise<string | null> {
  return new Promise((resolve) => {
    useUI.setState({ dirPicker: { mode: 'dir', start, title, resolve } })
  })
}

/** 弹出文件选择器；用户取消返回 null */
export function pickFile(start = '', title = ''): Promise<string | null> {
  return new Promise((resolve) => {
    useUI.setState({ dirPicker: { mode: 'file', start, title, resolve } })
  })
}
