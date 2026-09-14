/**
 * IPC 通道名集中定义。两边都从这里引用，避免手写字符串写错。
 */
export const CH = {
  /** invoke: 取初始状态（设置等） */
  appState: 'app:state',
  /** invoke: 弹目录选择框 */
  chooseVault: 'vault:choose',
  /** invoke: 打开指定目录作为文件库 */
  openVault: 'vault:open',
  /** invoke: 关闭当前文件库 */
  closeVault: 'vault:close',

  /** invoke: 列目录 */
  listDir: 'fs:list',
  /** invoke: 读文件 */
  readFile: 'fs:read',
  /** invoke: 写文件（原子写入） */
  writeFile: 'fs:write',
  /** invoke: 新建文件 / 文件夹 */
  createEntry: 'fs:create',
  /** invoke: 重命名 */
  renameEntry: 'fs:rename',
  /** invoke: 移动 */
  moveEntry: 'fs:move',
  /** invoke: 移到回收站 */
  trashEntry: 'fs:trash',
  /** invoke: 取文件状态 */
  statEntry: 'fs:stat',
  /** invoke: 在资源管理器中显示 */
  revealEntry: 'fs:reveal',
  /** invoke: 批量导入 Markdown 文件 */
  importFiles: 'fs:import',
  /** invoke: 全库搜索 */
  searchRun: 'search:run',
  /** invoke: 一键备份整个文档库 */
  backupLibrary: 'backup:run',
  /** invoke: 备份到指定目录（一键备份按钮用） */
  backupTo: 'backup:to',
  /** invoke: 界面缩放 */
  zoom: 'ui:zoom',
  /** invoke: 窗口按钮（最小化 / 最大化 / 关闭） */
  windowControl: 'window:control',
  /** main -> renderer: 窗口最大化状态变化 */
  windowState: 'window:state',

  /** invoke: 导出 PDF */
  exportPdf: 'pdf:export',
  /** invoke: 更新设置 */
  updateSettings: 'settings:update',

  /** invoke: 系统确认框 */
  confirm: 'dialog:confirm',
  /** invoke: 用系统默认程序打开链接 */
  openExternal: 'shell:open-external',
  /** invoke: 打开回收站 / 数据目录这类特殊位置 */
  openSpecial: 'shell:open-special',
  /** invoke: 选一个目录（导出目录 / 备份目录用） */
  chooseDirectory: 'dialog:choose-directory',
  /** invoke: 读待办清单 */
  tasksLoad: 'tasks:load',
  /** invoke: 写待办清单 */
  tasksSave: 'tasks:save',
  /** invoke: 写系统剪贴板 */
  writeClipboard: 'clipboard:write',

  /** main -> renderer: 菜单动作 */
  menuAction: 'menu:action',
  /** main -> renderer: 当前文件库变了 */
  vaultChanged: 'vault:changed',
  /** main -> renderer: 磁盘变化 */
  fsChanged: 'watch:changed',
  /** main -> renderer: 监听状态 */
  watchStatus: 'watch:status',
  /** main -> renderer: 退出前请立刻落盘 */
  requestFlush: 'app:request-flush',
  /** renderer -> main: 落盘完成 */
  flushDone: 'app:flush-done',
  /** renderer -> main: 渲染进程已就绪 */
  rendererReady: 'app:renderer-ready'
} as const

export type ChannelName = (typeof CH)[keyof typeof CH]

/** 允许渲染进程订阅的主进程事件通道 */
export const SUBSCRIBABLE: readonly string[] = [
  CH.menuAction,
  CH.fsChanged,
  CH.watchStatus,
  CH.requestFlush,
  CH.vaultChanged,
  CH.windowState
]
