/**
 * 主进程入口。
 *
 * 稳定性相关的几件事都在这个文件里：
 * - 单实例锁：避免两个进程同时写同一个文件库
 * - 窗口关闭 / 退出前，先让渲染进程把未保存的内容落盘，再真正退出
 * - 渲染进程崩溃时保留现场并提供重新加载，而不是整个程序消失
 * - 未捕获异常写日志，不静默死掉
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { CH } from '@shared/channels'
import { WINDOW_BACKGROUND } from '@shared/theme'
import { registerIpc } from './ipc'
import { atomicWriteText } from './atomic'
import { getSettings, loadSettings, patchSettings, pushRecentVault } from './settings'
import * as vault from './vault'
import { startWatch, stopWatch } from './watcher'
import { buildMenu } from './menu'
import type { Settings, ThemeName } from '@shared/types'

/*
 * 启动前自检，必须放在最前面：
 * 如果 Electron 被以「纯 Node 模式」启动（环境变量 ELECTRON_RUN_AS_NODE 被设置了），
 * import 进来的 app 是 undefined，下面任何一行都会抛一个看不出原因的 TypeError。
 * 这里提前说清楚原因和解决办法。
 */
if (!app || typeof app.setName !== 'function') {
  console.error(
    '\n[墨笔] Electron 没有以图形界面模式启动。\n' +
      '原因：环境变量 ELECTRON_RUN_AS_NODE 被设置了，Electron 会退化成纯 Node 运行，窗口永远不会出现。\n' +
      '解决：在普通终端里运行 npm run dev；如果终端里有这个变量，先清掉它：\n' +
      '  PowerShell:  $env:ELECTRON_RUN_AS_NODE=""\n' +
      '  cmd:         set ELECTRON_RUN_AS_NODE=\n'
  )
  process.exit(1)
}

const isDev = !app.isPackaged
let mainWindow: BrowserWindow | null = null
let readyToQuit = false
let boundsTimer: NodeJS.Timeout | null = null

/*
 * 应用显示名与数据目录。
 *
 * 显示名改成「墨笔」，但 userData 必须显式钉在原来的路径上：
 * Electron 默认用应用名拼 userData 目录，一旦跟着改名，
 * 用户已有的设置、文档库位置、备份记录就全「消失」了（其实是换了个目录）。
 *
 * MOBIWRITER_USER_DATA 是给自动化测试用的覆盖口，正常使用不会设它。
 */
app.setName('墨笔')
app.setPath('userData', process.env['MOBIWRITER_USER_DATA'] || join(app.getPath('appData'), 'MobiWriter'))

function logFilePath(): string {
  return join(app.getPath('userData'), 'logs', 'main.log')
}

async function logLine(message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    await fs.mkdir(dirname(logFilePath()), { recursive: true })
    await fs.appendFile(logFilePath(), line)
  } catch {
    // 日志写不进去也不能影响主流程
  }
  if (isDev) console.error(line.trimEnd())
}

function send(channel: string, payload?: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const contents = mainWindow.webContents
  if (contents.isDestroyed()) return
  contents.send(channel, payload)
}

async function broadcastState(): Promise<void> {
  send(CH.vaultChanged, { settings: await getSettings() })
}

async function openVault(dir: string): Promise<void> {
  const stat = await fs.stat(dir).catch(() => null)
  if (!stat || !stat.isDirectory()) throw new Error('这个文件夹不存在或无法访问')
  vault.setRoot(dir)
  stopWatch()
  const swept = await vault.sweepTempFiles().catch(() => 0)
  if (swept > 0) await logLine(`清理上次遗留的临时文件 ${swept} 个`)
  startWatch(
    dir,
    (payload) => send(CH.fsChanged, payload),
    (status) => send(CH.watchStatus, status)
  )
  await pushRecentVault(dir)
  await broadcastState()
}

async function closeVault(): Promise<void> {
  stopWatch()
  vault.setRoot(null)
  await patchSettings({ vaultPath: null, lastOpenedFile: null })
  await broadcastState()
}

/** 默认文档库位置：我的文档\MobiWriter */
function defaultLibraryPath(): string {
  try {
    return join(app.getPath('documents'), 'MobiWriter')
  } catch {
    return join(app.getPath('home'), 'MobiWriter')
  }
}

/**
 * 保证有一个可用的文档库。
 *
 * 目标：用户永远不需要在启动时选文件夹——所有文稿都在同一个地方。
 * 只有一种情况会换位置：配置过的目录用不了（比如被删了或盘符没挂载），
 * 这时先尝试原地重建，重建失败才退回默认位置，并且写日志说明。
 */
async function ensureLibrary(configured: string | null): Promise<string> {
  if (configured) {
    const stat = await fs.stat(configured).catch(() => null)
    if (stat && stat.isDirectory()) return configured
    const recreated = await fs
      .mkdir(configured, { recursive: true })
      .then(() => true, () => false)
    if (recreated) {
      await logLine(`文档库目录原本不存在，已重新创建：${configured}`)
      return configured
    }
    await logLine(`文档库目录不可用，回退到默认位置。原路径：${configured}`)
  }
  const fallback = defaultLibraryPath()
  await fs.mkdir(fallback, { recursive: true })
  await logLine(`使用默认文档库：${fallback}`)
  return fallback
}

const WELCOME_NOTE = `# 欢迎使用 MobiWriter

这里是你的**文档库**：所有文稿都放在这一个文件夹里，启动就自动打开，不用每次选。

- 左边那棵树的层级，就是磁盘上真实的文件夹层级
- 文稿就是普通的 Markdown 文件，随时可以整包拷走、用 git 管理
- \`Ctrl+N\` 新建文稿，\`Ctrl+Shift+N\` 新建文件夹，\`Ctrl+S\` 立即保存
- \`Ctrl+P\` 导出 PDF，\`Ctrl+Shift+F\` 专注模式
- 想一眼看清整个结构，点侧栏左上角那个「一键展开」按钮

这篇说明可以随时删掉。
`

/** 只在一个全新的空文档库里放一篇欢迎稿，绝不碰已有内容 */
async function seedLibraryIfEmpty(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir)
    if (entries.some((name) => !name.startsWith('.'))) return
    await atomicWriteText(join(dir, '欢迎使用.md'), WELCOME_NOTE)
    await logLine('文档库是空的，已放入一篇欢迎说明')
  } catch {
    // 放不进去也不影响正常使用
  }
}

function scheduleBoundsSave(): void {
  if (boundsTimer) clearTimeout(boundsTimer)
  boundsTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    void patchSettings({ windowBounds: mainWindow.getNormalBounds() })
  }, 600)
}

/**
 * 无边框窗口下，窗口按钮由系统绘制，颜色要跟着主题走，
 * 否则浅色主题下就会出现一条颜色对不上的原生条。
 *
 * 高度必须跟着界面缩放一起算：系统按钮是原生画的，不受页面缩放影响，
 * 而顶栏是 CSS 像素（会跟着缩放），不跟着放大就会出现按钮比顶栏矮一截。
 */
function applyWindowChrome(window: BrowserWindow, theme: ThemeName): void {
  if (window.isDestroyed()) return
  window.setBackgroundColor(WINDOW_BACKGROUND[theme])
}

async function createWindow(): Promise<void> {
  const settings = await getSettings()
  const bounds = settings.windowBounds
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 840,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 760,
    minHeight: 500,
    show: false,
    title: '墨笔',
    backgroundColor: WINDOW_BACKGROUND[settings.theme],
    // 隐藏原生标题栏。窗口按钮由我们自己画（见 renderTopbar）：
    // 系统画的按钮不跟页面缩放走，一缩放就和顶栏对不上、看着很跳。
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    // 菜单栏固定隐藏，而且**不启用 Alt 唤出**：
    // 按 Alt 做列选择（竖着选）时如果菜单条弹出来会把客户区挤下去，体验很糟。
    // 应用菜单本身仍然挂在窗口上，所以 Ctrl+O / Ctrl+P 这些快捷键照常工作。
    autoHideMenuBar: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  /*
   * 显示窗口。
   *
   * 不能只依赖 ready-to-show：窗口是 show:false 创建的，而隐藏窗口在部分机器上
   * 不会产生首帧绘制，这个事件就永远不来 —— 现象是「进程在跑但窗口一直不出现」，
   * 也就是用户说的「打不开」，而且毫无线索。
   * 所以这里三条路兜底，谁先来算谁：
   *   1. 首帧绘制好了（最快的正常路径）
   *   2. 页面加载完成（本地应用，加载完就显示完全没问题）
   *   3. 1.5 秒超时（最后保险，避免用户对着空桌面等）
   */
  const showWindow = (reason: string): void => {
    if (showTimer) clearTimeout(showTimer)
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return
    mainWindow.show()
    void logLine(`窗口已显示（${reason}）`)
  }
  let showTimer: NodeJS.Timeout | null = setTimeout(() => showWindow('1.5 秒超时兜底'), 1500)

  mainWindow.once('ready-to-show', () => showWindow('ready-to-show'))

  mainWindow.webContents.once('did-finish-load', () => {
    void logLine('界面加载完成')
    showWindow('did-finish-load')
    // 缩放要等页面加载完再设：在首帧之前调 setZoomLevel 会让隐藏窗口的
    // 首帧绘制卡住，ready-to-show 就永远不来，窗口永远不显示。
    try {
      mainWindow?.webContents.setZoomLevel(settings.zoomLevel)
    } catch {
      // 忽略：缩放失败不影响使用
    }
  })

  // Windows 上在 maximize / unmaximize 事件里立刻读 isMaximized() 可能还是旧值，
  // 延后一拍再读，否则自绘按钮的图标会换不回来。
  const sendWindowState = (): void => {
    setTimeout(() => send(CH.windowState, { maximized: mainWindow?.isMaximized() ?? false }), 60)
  }
  mainWindow.on('maximize', sendWindowState)
  mainWindow.on('unmaximize', sendWindowState)
  mainWindow.once('closed', () => {
    if (showTimer) clearTimeout(showTimer)
  })

  mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
    void logLine(`界面加载失败：${description}（${code}）url=${validatedUrl} mainFrame=${String(isMainFrame)}`)
  })

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    void logLine(`preload 出错：${preloadPath} ${error.message}`)
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    void logLine(`渲染进程退出：reason=${details.reason} exitCode=${details.exitCode}`)
  })

  // 站外链接一律交给系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    if (url.startsWith('file://')) return
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    void (async () => {
      await logLine(`渲染进程退出：reason=${details.reason} exitCode=${details.exitCode}`)
      const result = await dialog.showMessageBox({
        type: 'error',
        title: '界面进程崩溃了',
        message: '界面进程意外退出。你的文稿已经自动保存到磁盘上。',
        detail: `原因：${details.reason}（退出码 ${details.exitCode}）`,
        buttons: ['重新加载界面', '退出程序'],
        defaultId: 0,
        cancelId: 1
      })
      if (result.response === 0) {
        mainWindow?.reload()
      } else {
        await shutdown()
      }
    })()
  })

  mainWindow.on('resize', scheduleBoundsSave)
  mainWindow.on('move', scheduleBoundsSave)

  // 点右上角关闭时，先把没保存的内容落盘，再关窗口
  mainWindow.on('close', (event) => {
    if (readyToQuit) return
    event.preventDefault()
    void shutdown()
  })

  buildMenu(mainWindow)
  mainWindow.setMenuBarVisibility(false)
  // 恢复上次的界面缩放（窗口按钮的高度也要跟着，否则对不齐）
  applyWindowChrome(mainWindow, settings.theme)

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    await mainWindow.loadURL(devUrl)
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** 请求渲染进程把所有待保存内容立刻写盘，最多等 5 秒 */
async function flushRenderer(): Promise<void> {
  const win = mainWindow
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  await new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | null = null
    const done = (): void => {
      if (timer) clearTimeout(timer)
      ipcMain.removeListener(CH.flushDone, done)
      resolve()
    }
    timer = setTimeout(() => {
      ipcMain.removeListener(CH.flushDone, done)
      resolve()
    }, 5000)
    ipcMain.on(CH.flushDone, done)
    win.webContents.send(CH.requestFlush)
  })
}

async function shutdown(): Promise<void> {
  if (readyToQuit) return
  try {
    await flushRenderer()
  } catch (error) {
    await logLine(`退出前落盘失败：${String(error)}`)
  }
  if (boundsTimer) clearTimeout(boundsTimer)
  if (mainWindow && !mainWindow.isDestroyed()) {
    await patchSettings({ windowBounds: mainWindow.getNormalBounds() }).catch(() => undefined)
  }
  readyToQuit = true
  app.quit()
}

if (!app.requestSingleInstanceLock()) {
  // 关键：这里以前是静默退出，用户看到的现象就是「启动了但窗口不出来」。
  // 现在明确弹一个框说明原因，别让人以为是程序坏了。
  void logLine('检测到已有实例在运行，本次启动退出')
  void app.whenReady().then(async () => {
    await dialog
      .showMessageBox({
        type: 'info',
        title: '墨笔',
        message: '墨笔已经在运行了',
        detail:
          '同一时间只能开一个窗口（避免两个进程同时写同一批文稿）。\n' +
          '先把已经在运行的那个窗口关掉，再启动新的。',
        buttons: ['好']
      })
      .catch(() => undefined)
    app.quit()
  })
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.on('window-all-closed', () => {
    void shutdown()
  })

  app.on('before-quit', (event) => {
    if (readyToQuit) return
    event.preventDefault()
    void shutdown()
  })

  process.on('uncaughtException', (error) => {
    void logLine(`未捕获异常：${error.stack ?? error.message}`)
  })

  process.on('unhandledRejection', (reason) => {
    void logLine(`未处理的 Promise 拒绝：${String(reason)}`)
  })

  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.mobiwriter.app')
    await loadSettings()

    // 先把文档库准备好，再开窗口：渲染层一启动就能直接读到文稿，
    // 也避免「窗口已经能点、但主进程还没 setRoot」的竞态。
    const settings = await getSettings()
    const libraryPath = await ensureLibrary(settings.vaultPath)
    vault.setRoot(libraryPath)
    await seedLibraryIfEmpty(libraryPath)
    startWatch(
      libraryPath,
      (payload) => send(CH.fsChanged, payload),
      (status) => send(CH.watchStatus, status)
    )
    await pushRecentVault(libraryPath)

    registerIpc({
      getWindow: () => mainWindow,
      openVault,
      closeVault,
      onSettingsChanged: (next) => {
        if (mainWindow && !mainWindow.isDestroyed()) applyWindowChrome(mainWindow, next.theme)
      }
    })
    ipcMain.on(CH.rendererReady, () => {
      void broadcastState()
    })

    await createWindow()
    await broadcastState()
  })
}
