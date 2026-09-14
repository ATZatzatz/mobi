/**
 * PDF 导出。
 *
 * 路线选择：直接用 Electron 自带的 printToPDF（就是 Chromium 的打印引擎），
 * 不引入 pandoc / wkhtmltopdf / LaTeX。
 * 理由：零外部依赖、跨平台表现一致、CSS 控制力足够，用户也不需要额外装东西。
 * 代价：排版精度不如 LaTeX，但对长篇中文写作完全够用。
 */
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, app, dialog } from 'electron'
import { atomicWriteBuffer } from './atomic'
import { sanitizeFileName } from './relpath'
import type { PdfRequest, PdfResult } from '@shared/types'

const MM_PER_INCH = 25.4
/** 要显示页脚页码，下边距就必须留够，否则页码会压到正文上 */
const FOOTER_MIN_MARGIN_MM = 15

/** 随应用分发的 MiSans 字重。导出窗口是独立的，必须自己声明一遍 @font-face。 */
const FONT_FILES: Array<[file: string, weight: string]> = [
  ['MiSans-Regular.otf', '400'],
  ['MiSans-Medium.otf', '500 600'],
  ['MiSans-Bold.otf', '700 900']
]

function resolveFontDir(): string | null {
  const appPath = app.getAppPath()
  const candidates = app.isPackaged
    ? [
        join(appPath, 'out', 'renderer', 'fonts'),
        join(process.resourcesPath, 'app.asar.unpacked', 'out', 'renderer', 'fonts')
      ]
    : [join(appPath, 'src', 'renderer', 'public', 'fonts')]
  for (const dir of candidates) {
    if (FONT_FILES.some(([file]) => existsSync(join(dir, file)))) return dir
  }
  return null
}

function fontFaceCss(): string {
  const dir = resolveFontDir()
  if (!dir) return ''
  const rules: string[] = []
  for (const [file, weight] of FONT_FILES) {
    const abs = join(dir, file)
    if (!existsSync(abs)) continue
    rules.push(
      '@font-face{font-family:"MiSans";font-style:normal;font-weight:' +
        weight +
        ';font-display:block;src:url("' +
        pathToFileURL(abs).href +
        '") format("opentype");}'
    )
  }
  return rules.join('\n')
}

const FOOTER_TEMPLATE =
  '<div style="width:100%;font-size:9px;text-align:center;color:#8a8a8a;font-family:sans-serif;">' +
  '<span class="pageNumber"></span> / <span class="totalPages"></span></div>'

/**
 * 等字体和图片都就绪再打印。
 * 不等的话，首次导出经常出现中文缺字或图片空白。
 */
const WAIT_SCRIPT = `(async () => {
  try {
    if (document.fonts && document.fonts.ready) { await document.fonts.ready }
  } catch (e) {}
  const images = Array.from(document.images || []);
  await Promise.all(images.map((img) => {
    if (img.complete) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => resolve(true);
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
      setTimeout(done, 4000);
    });
  }));
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
  return true;
})()`

/**
 * 打印文档准备：
 * 1. 补一个 <base>，让文稿里的相对图片路径能解析；
 * 2. 注入 MiSans 的 @font-face（导出窗口是独立进程/页面，拿不到主界面的字体）。
 */
function preparePrintHtml(html: string, docDirAbs: string): string {
  const head: string[] = []
  if (docDirAbs) {
    let href = pathToFileURL(docDirAbs).href
    if (!href.endsWith('/')) href += '/'
    head.push(`<base href="${href}">`)
  }
  const faces = fontFaceCss()
  if (faces) head.push(`<style>${faces}</style>`)
  if (head.length === 0) return html
  const tags = head.join('')
  return html.includes('<head>') ? html.replace('<head>', `<head>${tags}`) : `${tags}${html}`
}

async function loadAndWait(win: BrowserWindow, file: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      win.webContents.removeListener('did-finish-load', onDone)
      win.webContents.removeListener('did-fail-load', onFail)
    }
    const onDone = (): void => {
      cleanup()
      resolve()
    }
    const onFail = (_event: unknown, code: number, description: string): void => {
      cleanup()
      reject(new Error(`导出用的临时页面加载失败：${description}（${code}）`))
    }
    win.webContents.once('did-finish-load', onDone)
    win.webContents.on('did-fail-load', onFail)
    win.loadFile(file).catch((error: unknown) => {
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
  await win.webContents.executeJavaScript(WAIT_SCRIPT, true).catch(() => undefined)
}

export async function exportPdf(parent: BrowserWindow | null, request: PdfRequest): Promise<PdfResult> {
  const { options } = request
  const dialogOptions = {
    title: '导出 PDF',
    defaultPath: join(
      request.docDirAbs || app.getPath('documents'),
      `${sanitizeFileName(request.baseName)}.pdf`
    ),
    filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
  }
  const picked = parent
    ? await dialog.showSaveDialog(parent, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions)
  if (picked.canceled || !picked.filePath) return { saved: false }

  const stamp = randomBytes(5).toString('hex')
  const tmpHtml = join(app.getPath('temp'), `mobiwriter-print-${stamp}.html`)
  await fs.writeFile(tmpHtml, preparePrintHtml(request.html, request.docDirAbs), 'utf8')

  const printWindow = new BrowserWindow({
    show: false,
    width: 1000,
    height: 1400,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
      webSecurity: true,
      backgroundThrottling: false
    }
  })

  try {
    await loadAndWait(printWindow, tmpHtml)
    // 自己分好页的情况：页边距已经做在页面里了，这里必须给 0，
    // 否则每页会被再挤一次，跟预览对不上；页码也由页面自己画。
    const exact = request.exactPages === true
    const marginMm = exact
      ? 0
      : options.pageNumbers
        ? Math.max(options.marginMm, FOOTER_MIN_MARGIN_MM)
        : options.marginMm
    const marginInch = marginMm / MM_PER_INCH
    const data = await printWindow.webContents.printToPDF({
      pageSize: options.pageSize,
      printBackground: options.printBackground,
      margins: {
        top: marginInch,
        bottom: marginInch,
        left: marginInch,
        right: marginInch
      },
      displayHeaderFooter: exact ? false : options.pageNumbers,
      headerTemplate: '<span></span>',
      footerTemplate: !exact && options.pageNumbers ? FOOTER_TEMPLATE : '<span></span>',
      preferCSSPageSize: false
    })
    await atomicWriteBuffer(picked.filePath, data)
    return { saved: true, path: picked.filePath }
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy()
    await fs.rm(tmpHtml, { force: true }).catch(() => undefined)
  }
}
