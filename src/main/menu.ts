/**
 * 应用菜单。菜单动作一律转发给渲染进程处理，
 * 因为撤销/重做/查找必须由 CodeMirror 自己做，
 * 交给 Electron 原生的 role 会和编辑器自己的历史记录打架。
 */
import { Menu, app, dialog, shell } from 'electron'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { CH } from '@shared/channels'
import { trashDirPath } from './vault'
import type { MenuAction } from '@shared/types'

export function buildMenu(window: BrowserWindow): void {
  const send =
    (action: MenuAction) =>
    (): void => {
      if (!window.isDestroyed()) window.webContents.send(CH.menuAction, action)
    }

  const isMac = process.platform === 'darwin'

  const fileMenu: MenuItemConstructorOptions = {
    label: '文件',
    submenu: [
      { label: '打开文件夹…', accelerator: 'CmdOrCtrl+O', click: send('open-vault') },
      { label: '关闭文件夹', click: send('close-vault') },
      { type: 'separator' },
      { label: '新建文稿', accelerator: 'CmdOrCtrl+N', click: send('new-file') },
      { label: '新建文件夹', accelerator: 'CmdOrCtrl+Shift+N', click: send('new-folder') },
      { type: 'separator' },
      { label: '保存', accelerator: 'CmdOrCtrl+S', click: send('save') },
      { label: '导出 PDF…', accelerator: 'CmdOrCtrl+P', click: send('export-pdf') },
      { type: 'separator' },
      { label: '备份整个文档库…', click: send('backup') },
      { type: 'separator' },
      {
        label: '打开回收站',
        click: (): void => {
          try {
            void shell.openPath(trashDirPath())
          } catch {
            void dialog.showMessageBox(window, {
              type: 'info',
              message: '还没有打开文件夹，回收站里是空的'
            })
          }
        }
      },
      {
        label: '打开数据目录',
        click: (): void => {
          void shell.openPath(app.getPath('userData'))
        }
      },
      { type: 'separator' },
      isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' }
    ]
  }

  const editMenu: MenuItemConstructorOptions = {
    label: '编辑',
    submenu: [
      { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
      { label: '重做', accelerator: 'CmdOrCtrl+Shift+Z', click: send('redo') },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' },
      { type: 'separator' },
      { label: '查找', accelerator: 'CmdOrCtrl+F', click: send('find') },
      { label: '查找并替换', accelerator: 'CmdOrCtrl+H', click: send('replace') },
      { type: 'separator' },
      { label: '全局搜索（整个文档库）', accelerator: 'CmdOrCtrl+Shift+F', click: send('search') }
    ]
  }

  const viewMenu: MenuItemConstructorOptions = {
    label: '视图',
    submenu: [
      { label: '显示 / 隐藏预览', accelerator: 'CmdOrCtrl+Shift+P', click: send('toggle-preview') },
      { label: '专注模式', accelerator: 'F11', click: send('toggle-focus') },
      { type: 'separator' },
      { label: '行号', click: send('toggle-line-numbers') },
      { label: '浅色 / 深色主题', accelerator: 'CmdOrCtrl+Shift+L', click: send('toggle-theme') },
      { label: '设置…', accelerator: 'CmdOrCtrl+,', click: send('open-settings') },
      { type: 'separator' },
      { label: '放大界面', accelerator: 'CmdOrCtrl+=', click: send('zoom-in') },
      { label: '缩小界面', accelerator: 'CmdOrCtrl+-', click: send('zoom-out') },
      { label: '恢复界面大小', accelerator: 'CmdOrCtrl+0', click: send('zoom-reset') },
      { type: 'separator' },
      { role: 'reload', label: '重新加载界面' },
      { role: 'toggleDevTools', label: '开发者工具' }
    ]
  }

  const helpMenu: MenuItemConstructorOptions = {
    role: 'help',
    label: '帮助',
    submenu: [
      {
        label: '关于 墨笔',
        click: (): void => {
          void dialog.showMessageBox(window, {
            type: 'info',
            title: '关于',
            message: '墨笔',
            detail:
              `版本 ${app.getVersion()}\n` +
              'Electron + CodeMirror 6 + markdown-it\n\n' +
              '文稿以普通 Markdown 文件保存在你自己选择的文档库里，\n' +
              '没有数据库、没有私有格式，随时可以整个文件夹拷走。',
            buttons: ['好']
          })
        }
      },
      {
        label: '打开日志目录',
        click: (): void => {
          void shell.openPath(app.getPath('userData'))
        }
      },
      {
        label: '打开回收站目录',
        click: (): void => {
          try {
            void shell.openPath(trashDirPath())
          } catch {
            void dialog.showMessageBox(window, {
              type: 'info',
              message: '还没有打开文件夹，回收站里是空的'
            })
          }
        }
      }
    ]
  }

  const template: MenuItemConstructorOptions[] = []
  if (isMac) {
    template.push({
      role: 'appMenu',
      label: app.name,
      submenu: [
        { role: 'about', label: '关于' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    })
  }
  template.push(fileMenu, editMenu, viewMenu, helpMenu)

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
