/**
 * IPC 注册。每个 handler 都尽量给出人话错误，
 * 因为渲染进程会把这些字符串直接显示给用户。
 */
import { app, clipboard, dialog, ipcMain, shell } from 'electron'
import type { BrowserWindow, MessageBoxOptions, OpenDialogOptions } from 'electron'
import { CH } from '@shared/channels'
import { ZOOM_RANGE } from '@shared/defaults'
import * as vault from './vault'
import { getSettings, patchSettings } from './settings'
import { exportPdf } from './pdf'
import { runSearch } from './search'
import { backupLibrary } from './backup'
import type {
  ConfirmRequest,
  DirEntry,
  EntryKind,
  PdfRequest,
  SearchRequest,
  Settings,
  Task
} from '@shared/types'

export interface IpcDeps {
  getWindow: () => BrowserWindow | null
  openVault: (dir: string) => Promise<void>
  closeVault: () => Promise<void>
  /** 设置变化后让主进程同步窗口外观（标题栏覆盖层颜色等） */
  onSettingsChanged?: (settings: Settings) => void
}

const EXTERNAL_SCHEME = /^(https?:|mailto:)/i

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`参数不合法：${label}`)
  return value
}

export function registerIpc(deps: IpcDeps): void {
  ipcMain.handle(CH.appState, async () => ({
    settings: await getSettings(),
    version: app.getVersion()
  }))

  ipcMain.handle(CH.chooseVault, async () => {
    const options: OpenDialogOptions = {
      title: '选择文稿文件夹',
      buttonLabel: '打开这个文件夹',
      properties: ['openDirectory', 'createDirectory']
    }
    const win = deps.getWindow()
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const dir = picked.filePaths[0]
    if (picked.canceled || !dir) return null
    await deps.openVault(dir)
    return dir
  })

  ipcMain.handle(CH.openVault, async (_event, dir: unknown) => {
    await deps.openVault(assertString(dir, 'dir'))
  })

  ipcMain.handle(CH.closeVault, async () => {
    await deps.closeVault()
  })

  ipcMain.handle(CH.listDir, async (_event, rel: unknown) => {
    return vault.listDir(typeof rel === 'string' ? rel : '')
  })

  ipcMain.handle(CH.readFile, async (_event, rel: unknown) => {
    return vault.readText(assertString(rel, 'rel'))
  })

  ipcMain.handle(CH.writeFile, async (_event, rel: unknown, content: unknown) => {
    if (typeof content !== 'string') throw new Error('写入内容必须是字符串')
    return vault.writeText(assertString(rel, 'rel'), content)
  })

  ipcMain.handle(
    CH.createEntry,
    async (_event, dirRel: unknown, name: unknown, kind: unknown): Promise<DirEntry> => {
      const safeKind: EntryKind = kind === 'dir' ? 'dir' : 'file'
      return vault.createEntry(typeof dirRel === 'string' ? dirRel : '', assertString(name, 'name'), safeKind)
    }
  )

  ipcMain.handle(CH.renameEntry, async (_event, rel: unknown, name: unknown) => {
    return vault.renameEntry(assertString(rel, 'rel'), assertString(name, 'name'))
  })

  ipcMain.handle(CH.moveEntry, async (_event, rel: unknown, destDirRel: unknown) => {
    return vault.moveEntry(assertString(rel, 'rel'), typeof destDirRel === 'string' ? destDirRel : '')
  })

  ipcMain.handle(CH.trashEntry, async (_event, rel: unknown) => {
    return vault.trashEntry(assertString(rel, 'rel'))
  })

  ipcMain.handle(CH.statEntry, async (_event, rel: unknown) => {
    return vault.statEntry(assertString(rel, 'rel'))
  })

  ipcMain.handle(CH.revealEntry, async (_event, rel: unknown) => {
    const abs = vault.resolveInside(assertString(rel, 'rel'))
    shell.showItemInFolder(abs)
  })

  ipcMain.handle(CH.importFiles, async (_event, dirRel: unknown) => {
    const options: OpenDialogOptions = {
      title: '导入 Markdown 文件',
      buttonLabel: '导入到文档库',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Markdown 文稿', extensions: ['md', 'markdown', 'mdx', 'txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }
    const win = deps.getWindow()
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || picked.filePaths.length === 0) {
      return { imported: [], renamed: [], skipped: [] }
    }
    return vault.importFiles(typeof dirRel === 'string' ? dirRel : '', picked.filePaths)
  })

  ipcMain.handle(CH.exportPdf, async (_event, request: unknown) => {
    const payload = request as PdfRequest
    if (!payload || typeof payload.html !== 'string') throw new Error('导出内容为空')
    return exportPdf(deps.getWindow(), payload)
  })

  ipcMain.handle(CH.updateSettings, async (_event, patch: unknown) => {
    const next = await patchSettings((patch ?? {}) as Partial<Settings>)
    deps.onSettingsChanged?.(next)
    return next
  })

  ipcMain.handle(CH.searchRun, async (_event, request: unknown) => {
    const payload = request as SearchRequest
    const query = typeof payload?.query === 'string' ? payload.query : ''
    const scope = payload?.scope === 'name' ? 'name' : 'all'
    if (query.trim().length === 0) {
      return { query, scope, hits: [], scanned: 0, truncated: false, elapsedMs: 0 }
    }
    return runSearch({ query, scope, caseSensitive: payload?.caseSensitive === true })
  })

  ipcMain.handle(CH.backupLibrary, async () => {
    const settings = await getSettings()
    const options: OpenDialogOptions = {
      title: '选择备份位置',
      buttonLabel: '备份到这里',
      defaultPath: settings.lastBackupDir ?? app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory']
    }
    const win = deps.getWindow()
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const dest = picked.filePaths[0]
    if (picked.canceled || !dest) return null
    const result = await backupLibrary(dest)
    await patchSettings({ lastBackupDir: dest })
    return result
  })

  ipcMain.handle(CH.zoom, async (_event, action: unknown) => {
    const current = await getSettings()
    const next =
      action === 'in'
        ? Math.min(ZOOM_RANGE.max, current.zoomLevel + 1)
        : action === 'out'
          ? Math.max(ZOOM_RANGE.min, current.zoomLevel - 1)
          : 0
    const win = deps.getWindow()
    if (win && !win.isDestroyed()) win.webContents.setZoomLevel(next)
    // 窗口按钮是系统画的，不跟着页面缩放，得手动把高度补上
    deps.onSettingsChanged?.({ ...current, zoomLevel: next })
    await patchSettings({ zoomLevel: next })
    return next
  })

  ipcMain.handle(CH.windowControl, async (_event, action: unknown) => {
    const win = deps.getWindow()
    if (!win || win.isDestroyed()) return
    if (action === 'minimize') win.minimize()
    else if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    } else if (action === 'close') win.close()
  })

  ipcMain.handle(CH.backupTo, async (_event, dir: unknown) => {
    return backupLibrary(assertString(dir, 'dir'))
  })

  ipcMain.handle(CH.chooseDirectory, async (_event, title: unknown) => {
    const options: OpenDialogOptions = {
      title: typeof title === 'string' && title ? title : '选择目录',
      buttonLabel: '就用这个目录',
      properties: ['openDirectory', 'createDirectory']
    }
    const win = deps.getWindow()
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const dir = picked.filePaths[0]
    return picked.canceled || !dir ? null : dir
  })

  ipcMain.handle(CH.tasksLoad, async () => vault.readTasks())

  ipcMain.handle(CH.tasksSave, async (_event, tasks: unknown) => {
    if (!Array.isArray(tasks)) throw new Error('待办数据格式不对')
    await vault.writeTasks(tasks as Task[])
  })

  ipcMain.handle(CH.confirm, async (_event, request: unknown) => {
    const payload = request as ConfirmRequest
    const options: MessageBoxOptions = {
      type: payload.danger ? 'warning' : 'question',
      title: payload.title || '确认',
      message: payload.message || '确定要继续吗？',
      detail: payload.detail ?? '',
      buttons: [payload.confirmLabel || '确定', payload.cancelLabel || '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }
    const win = deps.getWindow()
    const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    return result.response === 0
  })

  ipcMain.handle(CH.openExternal, async (_event, url: unknown) => {
    const target = assertString(url, 'url')
    if (!EXTERNAL_SCHEME.test(target)) throw new Error('只允许打开 http / https / mailto 链接')
    await shell.openExternal(target)
  })

  ipcMain.handle(CH.openSpecial, async (_event, target: unknown) => {
    if (target === 'trash') {
      await shell.openPath(vault.trashDirPath())
      return
    }
    if (target === 'data-dir') {
      await shell.openPath(app.getPath('userData'))
      return
    }
    throw new Error(`未知的打开目标：${String(target)}`)
  })

  ipcMain.handle(CH.writeClipboard, async (_event, text: unknown) => {
    clipboard.writeText(typeof text === 'string' ? text : String(text ?? ''))
  })
}
