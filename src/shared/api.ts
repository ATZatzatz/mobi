/**
 * preload 暴露给渲染进程的窄接口定义。
 * 放在 shared 里，这样 preload 实现、渲染进程引用的是同一份契约。
 */
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
} from './types'

export type Unsubscribe = () => void

export interface VaultChangedPayload {
  settings: Settings
}

export interface MobiApi {
  /** 运行平台，渲染层用它调整布局（例如给 Windows 的窗口按钮留位） */
  readonly platform: string

  getState(): Promise<Result<AppState>>

  chooseVault(): Promise<Result<string | null>>
  openVault(dir: string): Promise<Result<void>>
  closeVault(): Promise<Result<void>>

  listDir(rel: string): Promise<Result<DirEntry[]>>
  readFile(rel: string): Promise<Result<ReadResult>>
  writeFile(rel: string, content: string): Promise<Result<SaveResult>>
  createEntry(dirRel: string, name: string, kind: EntryKind): Promise<Result<DirEntry>>
  renameEntry(rel: string, name: string): Promise<Result<DirEntry>>
  moveEntry(rel: string, destDirRel: string): Promise<Result<DirEntry>>
  trashEntry(rel: string): Promise<Result<{ trashPath: string }>>
  statEntry(rel: string): Promise<Result<StatResult>>
  revealEntry(rel: string): Promise<Result<void>>
  /** 弹文件选择框，把选中的 Markdown 复制进文档库的 dirRel 目录 */
  importFiles(dirRel: string): Promise<Result<ImportResult>>
  /** 全库搜索（文件名 / 文件名 + 正文） */
  search(request: SearchRequest): Promise<Result<SearchResult>>
  /** 一键备份：选一个目录，把整个文档库复制过去（带时间戳） */
  backupLibrary(): Promise<Result<BackupResult | null>>
  /** 备份到指定目录（一键备份按钮用；不弹选择框） */
  backupLibraryTo(dir: string): Promise<Result<BackupResult>>
  /** 界面缩放，返回新的缩放级别 */
  zoom(action: 'in' | 'out' | 'reset'): Promise<Result<number>>
  /** 自绘的窗口按钮 */
  windowControl(action: 'minimize' | 'maximize' | 'close'): Promise<Result<void>>
  onWindowState(cb: (payload: { maximized: boolean }) => void): Unsubscribe

  exportPdf(request: PdfRequest): Promise<Result<PdfResult>>
  updateSettings(patch: Partial<Settings>): Promise<Result<Settings>>

  confirm(request: ConfirmRequest): Promise<Result<boolean>>
  openExternal(url: string): Promise<Result<void>>
  /** target: 'trash' 回收站 | 'data-dir' 设置与日志所在目录 */
  openSpecial(target: 'trash' | 'data-dir'): Promise<Result<void>>
  /** 选一个目录（导出默认目录 / 备份目录用），取消返回 null */
  chooseDirectory(title?: string): Promise<Result<string | null>>
  /** 读待办清单 */
  loadTasks(): Promise<Result<Task[]>>
  /** 写待办清单 */
  saveTasks(tasks: Task[]): Promise<Result<void>>
  writeClipboard(text: string): Promise<Result<void>>

  notifyReady(): void
  notifyFlushDone(ok: boolean, error?: string): void

  onMenuAction(cb: (action: MenuAction) => void): Unsubscribe
  onFsChanged(cb: (payload: WatchPayload) => void): Unsubscribe
  onWatchStatus(cb: (status: WatchStatus) => void): Unsubscribe
  onRequestFlush(cb: () => void): Unsubscribe
  onVaultChanged(cb: (payload: VaultChangedPayload) => void): Unsubscribe
}
