/**
 * preload：唯一被允许跨越主进程 / 渲染进程边界的桥。
 *
 * 安全前提（配合 main 里的 webPreferences）：
 * contextIsolation: true + nodeIntegration: false + sandbox: true
 * 渲染进程拿不到 require，也拿不到 ipcRenderer 本体，只能用下面这几个方法。
 *
 * 这里把所有 IPC 都包装成 Result 对象，渲染进程就不用满屏 try/catch。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { CH, SUBSCRIBABLE } from '@shared/channels'
import type { MobiApi, Unsubscribe } from '@shared/api'
import type {
  AppState,
  BackupResult,
  ConfirmRequest,
  DirEntry,
  EntryKind,
  ImportResult,
  MenuAction,
  PdfRequest,
  PdfResult,
  ReadResult,
  Result,
  SaveResult,
  SearchRequest,
  SearchResult,
  Settings,
  StatResult,
  Task,
  WatchPayload,
  WatchStatus
} from '@shared/types'
import type { VaultChangedPayload } from '@shared/api'

/** 把 Electron 包了一层的那句 "Error invoking remote method 'xxx':" 去掉，只留真正的错误信息 */
function cleanMessage(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : String(raw)
  const match = /Error invoking remote method '[^']*':\s*(?:Error:\s*)?([\s\S]*)$/.exec(text)
  return (match?.[1] ?? text).trim() || '未知错误'
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
  try {
    const data = (await ipcRenderer.invoke(channel, ...args)) as T
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: cleanMessage(error) }
  }
}

function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  if (!SUBSCRIBABLE.includes(channel)) {
    throw new Error(`不允许订阅的通道：${channel}`)
  }
  const handler = (_event: unknown, payload: T): void => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: MobiApi = {
  platform: process.platform,

  getState: () => invoke<AppState>(CH.appState),

  chooseVault: () => invoke<string | null>(CH.chooseVault),
  openVault: (dir: string) => invoke<void>(CH.openVault, dir),
  closeVault: () => invoke<void>(CH.closeVault),

  listDir: (rel: string) => invoke<DirEntry[]>(CH.listDir, rel),
  readFile: (rel: string) => invoke<ReadResult>(CH.readFile, rel),
  writeFile: (rel: string, content: string) => invoke<SaveResult>(CH.writeFile, rel, content),
  createEntry: (dirRel: string, name: string, kind: EntryKind) =>
    invoke<DirEntry>(CH.createEntry, dirRel, name, kind),
  renameEntry: (rel: string, name: string) => invoke<DirEntry>(CH.renameEntry, rel, name),
  moveEntry: (rel: string, destDirRel: string) => invoke<DirEntry>(CH.moveEntry, rel, destDirRel),
  trashEntry: (rel: string) => invoke<{ trashPath: string }>(CH.trashEntry, rel),
  statEntry: (rel: string) => invoke<StatResult>(CH.statEntry, rel),
  revealEntry: (rel: string) => invoke<void>(CH.revealEntry, rel),
  importFiles: (dirRel: string) => invoke<ImportResult>(CH.importFiles, dirRel),
  search: (request: SearchRequest) => invoke<SearchResult>(CH.searchRun, request),
  backupLibrary: () => invoke<BackupResult | null>(CH.backupLibrary),
  backupLibraryTo: (dir: string) => invoke<BackupResult>(CH.backupTo, dir),
  zoom: (action: 'in' | 'out' | 'reset') => invoke<number>(CH.zoom, action),
  windowControl: (action: 'minimize' | 'maximize' | 'close') => invoke<void>(CH.windowControl, action),

  exportPdf: (request: PdfRequest) => invoke<PdfResult>(CH.exportPdf, request),
  updateSettings: (patch: Partial<Settings>) => invoke<Settings>(CH.updateSettings, patch),

  confirm: (request: ConfirmRequest) => invoke<boolean>(CH.confirm, request),
  openExternal: (url: string) => invoke<void>(CH.openExternal, url),
  openSpecial: (target: 'trash' | 'data-dir') => invoke<void>(CH.openSpecial, target),
  chooseDirectory: (title?: string) => invoke<string | null>(CH.chooseDirectory, title),
  loadTasks: () => invoke<Task[]>(CH.tasksLoad),
  saveTasks: (tasks: Task[]) => invoke<void>(CH.tasksSave, tasks),
  writeClipboard: (text: string) => invoke<void>(CH.writeClipboard, text),

  notifyReady: () => {
    ipcRenderer.send(CH.rendererReady)
  },
  notifyFlushDone: (ok: boolean, error?: string) => {
    ipcRenderer.send(CH.flushDone, { ok, error })
  },

  onMenuAction: (cb: (action: MenuAction) => void) => subscribe<MenuAction>(CH.menuAction, cb),
  onFsChanged: (cb: (payload: WatchPayload) => void) => subscribe<WatchPayload>(CH.fsChanged, cb),
  onWatchStatus: (cb: (status: WatchStatus) => void) => subscribe<WatchStatus>(CH.watchStatus, cb),
  onRequestFlush: (cb: () => void) => subscribe<undefined>(CH.requestFlush, cb),
  onWindowState: (cb: (payload: { maximized: boolean }) => void) => subscribe<{ maximized: boolean }>(CH.windowState, cb),
  onVaultChanged: (cb: (payload: VaultChangedPayload) => void) =>
    subscribe<VaultChangedPayload>(CH.vaultChanged, cb)
}

contextBridge.exposeInMainWorld('mobi', api)
