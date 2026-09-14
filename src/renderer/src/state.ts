import type { Settings } from '@shared/types'

export interface ConflictState {
  rel: string
  kind: 'modified' | 'removed'
  diskMtimeMs: number
}

export interface AppStateShape {
  settings: Settings | null
  /** 应用版本号，设置面板底部显示 */
  version: string
  /** 窗口是否最大化（自绘的窗口按钮要据此换图标） */
  maximized: boolean
  vaultPath: string | null
  currentRel: string | null
  dirty: boolean
  saving: boolean
  lastSavedAt: number | null
  lastSaveError: string | null
  /** 当前文件在磁盘上的 mtime，用来识别外部改动 */
  diskMtimeMs: number | null
  conflict: ConflictState | null
  watchMessage: string | null
  pdfBusy: boolean
}

export const state: AppStateShape = {
  settings: null,
  version: '',
  maximized: false,
  vaultPath: null,
  currentRel: null,
  dirty: false,
  saving: false,
  lastSavedAt: null,
  lastSaveError: null,
  diskMtimeMs: null,
  conflict: null,
  watchMessage: null,
  pdfBusy: false
}

const listeners = new Set<() => void>()

export function onChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function changed(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.error('状态订阅回调出错', error)
    }
  }
}
