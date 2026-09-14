/**
 * 主进程与渲染进程共享的类型定义。
 * 这里只放纯类型，不放任何运行时依赖，方便两边同时引用。
 */

export type EntryKind = 'dir' | 'file'

export interface DirEntry {
  name: string
  /** 相对文件库根目录的路径，统一使用 / 分隔 */
  rel: string
  kind: EntryKind
}

export type ThemeName = 'light' | 'dark'

export type PageSize = 'A4' | 'A5' | 'A3' | 'Letter'

export interface PdfOptions {
  pageSize: PageSize
  marginMm: number
  pageNumbers: boolean
  printBackground: boolean
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface Settings {
  /** 当前打开的文件库根目录 */
  vaultPath: string | null
  recentVaults: string[]
  theme: ThemeName
  /** 停止输入后多久自动保存（毫秒） */
  autosaveMs: number
  showLineNumbers: boolean
  previewVisible: boolean
  /** 只看预览：打开预览时把源代码那一栏收起来 */
  previewOnly: boolean
  /** 编辑区行距 */
  editorLineHeight: number
  /** 正文字号（pt），预览与导出共用 */
  previewFontPt: number
  /** 正文段落首行缩进两格（中文文稿习惯） */
  paragraphIndent: boolean
  /** 预览与导出的行距 */
  previewLineHeight: number
  /** 预览与导出的段后距，单位 em */
  previewParagraphGap: number
  /** 上次备份的位置，下次备份默认用它 */
  lastBackupDir: string | null
  /** 界面缩放级别（Electron 的 zoomLevel，每级 20%） */
  zoomLevel: number
  /** 左栏（文稿树）是否显示 */
  sidebarVisible: boolean
  /** 下栏（状态栏）是否显示 */
  statusbarVisible: boolean
  /** 预览按纸张分页显示（A4 等） */
  previewPageMode: boolean
  /** 导出分页 PDF 时在最前面生成目录 */
  pdfToc: boolean
  /** 【】标记文字的颜色 */
  markColor: string
  /** 右栏是否显示 */
  rightPanelVisible: boolean
  /** 右栏当前标签页：outline / typography / find / library */
  rightPanelTab: string
  pdf: PdfOptions
  windowBounds: WindowBounds | null
  /** 上次编辑的文件，用于重启后恢复 */
  lastOpenedFile: string | null
}

export interface ReadResult {
  content: string
  mtimeMs: number
  size: number
}

export interface SaveResult {
  mtimeMs: number
  size: number
}

export interface StatResult {
  exists: boolean
  isDir: boolean
  mtimeMs: number
  size: number
}

/** 主进程监听到的磁盘变化，批量下发给渲染进程 */
export interface WatchPayload {
  /** 这些目录的列表可能变了，需要刷新树 */
  dirs: string[]
  /** 这些文件的内容变了 */
  files: string[]
  /** 这些路径已经不存在了 */
  removed: string[]
}

export interface WatchStatus {
  watching: boolean
  message?: string
}

export interface PdfRequest {
  /** 渲染进程已经生成好的完整 HTML 文档 */
  html: string
  /** 当前文档所在目录的绝对路径，用于解析相对图片路径 */
  docDirAbs: string
  baseName: string
  options: PdfOptions
  /** 页面已经在渲染层分好了：打印时页边距设 0、不要页眉页脚，才能一张纸对一页 */
  exactPages?: boolean
}

export interface PdfResult {
  saved: boolean
  path?: string
}

export interface ConfirmRequest {
  title: string
  message: string
  detail?: string
  confirmLabel: string
  cancelLabel: string
  danger?: boolean
}

/** 批量导入 Markdown 文件的结果 */
export interface ImportResult {
  /** 成功导入的相对路径 */
  imported: string[]
  /** 因为重名被自动改名的：'原名 → 新名' */
  renamed: string[]
  /** 后缀不支持被跳过的文件名 */
  skipped: string[]
}

/** 备份结果 */
export interface BackupResult {
  /** 备份到的目录（备份是一次性快照，会带上时间戳） */
  destination: string
  files: number
  bytes: number
}

/** 搜索范围：只看文件名，还是连正文一起搜 */
export type SearchScope = 'name' | 'all'

export interface SearchLine {
  /** 行号，从 1 开始 */
  line: number
  /** 该行内容（过长会截断显示） */
  text: string
  /** 命中位置在该行中的列（0 开始），用于跳转后选中 */
  column: number
}

export interface SearchHit {
  /** 相对文档库的路径 */
  rel: string
  /** 显示名（不含后缀） */
  name: string
  /** 文件名命中 / 正文命中 */
  kind: 'name' | 'content'
  /** 正文命中的行；文件名命中时为空 */
  lines: SearchLine[]
}

export interface SearchRequest {
  query: string
  scope: SearchScope
  caseSensitive: boolean
}

export interface SearchResult {
  query: string
  scope: SearchScope
  hits: SearchHit[]
  /** 扫描了多少个文稿 */
  scanned: number
  /** 是否因为数量上限提前结束 */
  truncated: boolean
  elapsedMs: number
}

export interface AppState {
  settings: Settings
  /** 应用版本号，设置面板里显示 */
  version: string
}

/** 统一的 IPC 返回包装，避免渲染进程到处写 try/catch */
export type Result<T> = { ok: true; data: T } | { ok: false; error: string }

export type MenuAction =
  | 'open-vault'
  | 'close-vault'
  | 'new-file'
  | 'new-folder'
  | 'save'
  | 'export-pdf'
  | 'undo'
  | 'redo'
  | 'find'
  | 'replace'
  | 'search'
  | 'backup'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'open-command-menu'
  | 'toggle-sidebar'
  | 'toggle-statusbar'
  | 'toggle-preview'
  | 'toggle-focus'
  | 'toggle-line-numbers'
  | 'toggle-theme'
  | 'open-settings'
