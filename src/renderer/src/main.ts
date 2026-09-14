/**
 * 渲染层入口：把编辑器、文件树、预览、保存、PDF 导出串起来。
 *
 * 保存策略（这是"不丢稿"的核心）：
 * - 停止输入 autosaveMs 毫秒后自动写盘，另外有一个"最长等待"，避免用户一直不停手就一直不保存
 * - 切换文稿、导出 PDF、关闭窗口、退出程序之前，都会先把待保存内容 flush 掉
 * - 写盘之后只有确认"内容没被继续修改"才清除脏标记，防止把新敲的字判成已保存
 */
import './styles.css'
// 预览区的排版样式。preview.ts 里还会以 ?raw 形式再读一份用于导出 PDF，
// 这里必须正常 import 一次，否则应用内的预览只有浏览器默认样式。
import './preview.css'
import { api, must } from './api'
import { byId, clear, el, formatTime, toast } from './dom'
import { createEditor } from './editor'
import type { EditorHandle } from './editor'
import { createTree, setDirtyDot } from './tree'
import type { TreeHandle } from './tree'
import {
  buildPrintDocument,
  countText,
  decorateLinks,
  renderMarkdown,
  rewriteRelativeUrls
} from './preview'
import type { TextStats } from './preview'
import { createCommandMenu } from './command-menu'
import type { CommandMenu } from './command-menu'
import { openSettingsDialog, promptText } from './dialog'
import { createFindBar } from './find-bar'
import type { FindBar } from './find-bar'
import { icon } from './icons'
import type { IconName } from './icons'
import { paginate, pageVars } from './paginate'
import { createListSearch } from './search'
import type { ListSearch, ListSearchTarget } from './search'
import { changed, onChange, state } from './state'
import type { DirEntry, MenuAction, Settings, WatchPayload } from '@shared/types'

const refs = {
  topbar: byId('topbar'),
  statusbar: byId('statusbar'),
  bannerHost: byId('banner-host'),
  welcome: byId('welcome'),
  treeHost: byId('tree-host'),
  resultsHost: byId('results-host'),
  findHost: byId('find-host'),
  workspace: byId('workspace'),
  editorHost: byId('editor-host'),
  editorPlaceholder: byId('editor-placeholder'),
  previewHost: byId('preview-host'),
  previewPane: byId('preview-pane'),
  sidebar: byId('sidebar'),
  splitterLeft: byId('splitter-left'),
  vaultName: byId('vault-name'),
  btnExpandAll: byId<HTMLButtonElement>('btn-expand-all'),
  btnNewFile: byId<HTMLButtonElement>('btn-new-file'),
  btnNewFolder: byId<HTMLButtonElement>('btn-new-folder')
}

let editor: EditorHandle | null = null
let tree: TreeHandle | null = null
let listSearch: ListSearch | null = null
let findBar: FindBar | null = null
let commandMenu: CommandMenu | null = null
/** 顶栏右侧的文稿名。单独持有引用，避免每次打字都重建整个工具栏。 */
let docChip: HTMLElement | null = null

/** 外部（磁盘）内容写进编辑器时，不要把它当成"用户输入" */
let suppressChanges = false
/** 滚动同步的互斥标记，防止两个面板互相触发 */
let suppressScroll = false
let previewTimer: number | null = null
let saveTimer: number | null = null
let saveMaxTimer: number | null = null
let saveChain: Promise<void> = Promise.resolve()
let statsTimer: number | null = null
let latestStats: TextStats = { words: 0, chars: 0, lines: 0, paragraphs: 0 }

/* ------------------------------ 小工具 ------------------------------ */

function currentSettings(): Settings {
  if (!state.settings) throw new Error('设置还没加载完成')
  return state.settings
}

function parentOfRel(rel: string): string {
  const index = rel.lastIndexOf('/')
  return index === -1 ? '' : rel.slice(0, index)
}

function basenameOf(fullPath: string): string {
  const parts = fullPath.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? fullPath
}

function titleOf(rel: string): string {
  const base = basenameOf(rel)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

function docDirAbs(rel: string): string | null {
  const vault = state.vaultPath
  if (!vault) return null
  const normalised = vault.replace(/\\/g, '/').replace(/\/+$/, '')
  const parent = parentOfRel(rel)
  return parent ? `${normalised}/${parent}` : normalised
}

/* ------------------------------ 保存 ------------------------------ */

function scheduleSave(): void {
  const delay = state.settings?.autosaveMs ?? 1500
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    void flushSave()
  }, delay)
  if (saveMaxTimer === null) {
    saveMaxTimer = window.setTimeout(() => {
      saveMaxTimer = null
      void flushSave()
    }, Math.max(5000, delay * 4))
  }
}

async function performSave(): Promise<void> {
  const rel = state.currentRel
  if (!rel || !editor || !state.dirty) return
  const content = editor.getDoc()
  state.saving = true
  changed()
  const result = await api.writeFile(rel, content)
  state.saving = false
  if (!result.ok) {
    state.lastSaveError = result.error
    changed()
    toast(`保存失败：${result.error}`, 'error')
    return
  }
  state.diskMtimeMs = result.data.mtimeMs
  state.lastSavedAt = Date.now()
  state.lastSaveError = null
  // 只有内容没被继续改动，才算真的"保存完了"
  if (editor.getDoc() === content) state.dirty = false
  changed()
  if (tree) setDirtyDot(refs.treeHost, state.currentRel, state.dirty)
}

function flushSave(): Promise<void> {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer)
    saveTimer = null
  }
  if (saveMaxTimer !== null) {
    window.clearTimeout(saveMaxTimer)
    saveMaxTimer = null
  }
  saveChain = saveChain.then(() => performSave()).catch(() => undefined)
  return saveChain
}

function onDocChange(): void {
  if (suppressChanges) return
  state.dirty = true
  state.lastSaveError = null
  scheduleSave()
  scheduleStats()
  changed()
  if (tree) setDirtyDot(refs.treeHost, state.currentRel, true)
}

/* ------------------------------ 文稿开关 ------------------------------ */

function applyDiskContent(content: string, mtimeMs: number, preserveScroll: boolean): void {
  state.diskMtimeMs = mtimeMs
  state.dirty = false
  state.lastSavedAt = Date.now()
  state.lastSaveError = null
  state.conflict = null
  suppressChanges = true
  try {
    editor?.setDoc(content, {
      preserveScrollRatio: preserveScroll && editor ? editor.scrollRatio() : undefined
    })
  } finally {
    suppressChanges = false
  }
  latestStats = countText(content)
  renderPreview()
  if (tree) setDirtyDot(refs.treeHost, state.currentRel, false)
  // 换了文档，把查找栏里的查询重新应用到新文档上（否则高亮会丢）
  findBar?.refresh()
  changed()
}

async function openFile(rel: string): Promise<void> {
  if (state.currentRel === rel) return
  await flushSave()
  const result = await api.readFile(rel)
  if (!result.ok) {
    toast(`打不开这个文件：${result.error}`, 'error')
    return
  }
  state.currentRel = rel
  applyDiskContent(result.data.content, result.data.mtimeMs, false)
  tree?.setActive(rel)
  refs.editorPlaceholder.style.display = 'none'
  renderStatus()
  void api.updateSettings({ lastOpenedFile: rel })
}

/** 从搜索结果跳过来：打开文稿并选中命中位置 */
async function openFileAt(target: ListSearchTarget): Promise<void> {
  await openFile(target.rel)
  if (state.currentRel !== target.rel) return
  if (target.line && target.line > 0) {
    editor?.revealPosition(target.line, target.column ?? 0, target.length ?? 0)
  }
}

/** 搜索：统一走查找替换栏，「在列表中搜索」是它的一个勾选项 */
function openSearch(): void {
  findBar?.open('find')
}

/** 新建一个不重名的文稿（名字被占了就往后加序号） */
async function createUniqueFile(dir: string, base: string): Promise<DirEntry> {
  for (let index = 1; index <= 30; index += 1) {
    const candidate = index === 1 ? base : `${base} ${index}`
    const result = await api.createEntry(dir, candidate, 'file')
    if (result.ok) return result.data
    if (!result.error.includes('已经存在')) throw new Error(result.error)
  }
  throw new Error('同名文稿太多了，换个名字吧')
}

/** 从光标处把当前文稿切成两篇：前半留在原文件，后半另存为 xxx_被切分 */
async function splitAtCursor(): Promise<void> {
  const rel = state.currentRel
  if (!rel || !editor) {
    toast('先打开一篇文稿', 'info')
    return
  }
  const doc = editor.getDoc()
  const head = editor.view.state.selection.main.head
  const before = doc.slice(0, head)
  const after = doc.slice(head)
  if (before.trim().length === 0 || after.trim().length === 0) {
    toast('光标两边都要有内容才能切分', 'info')
    return
  }
  const dir = parentOfRel(rel)
  try {
    const created = await createUniqueFile(dir, `${titleOf(rel)}_被切分`)
    must(await api.writeFile(created.rel, after))
    // 原文件只保留前半部分，光标停在切分点上
    const lines = before.split('\n')
    editor.setDoc(before)
    editor.revealPosition(lines.length, (lines[lines.length - 1] ?? '').length, 0)
    state.dirty = true
    await flushSave()
    tree?.refresh([dir])
    toast(`已切分，后半部分是 ${created.rel}`, 'success')
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

/** 合并多篇文稿：按文件列表里的先后顺序拼起来，原文稿保留 */
async function mergeFiles(files: string[]): Promise<void> {
  const first = files[0]
  if (files.length < 2 || !first) {
    toast('至少选中两篇文稿才能合并', 'info')
    return
  }
  const dir = parentOfRel(first)
  try {
    const parts: string[] = []
    for (const rel of files) {
      const result = await api.readFile(rel)
      if (!result.ok) throw new Error(`${rel}：${result.error}`)
      parts.push(result.data.content.replace(/\s+$/, ''))
    }
    const created = await createUniqueFile(dir, `${titleOf(first)}_被合并`)
    must(await api.writeFile(created.rel, parts.join('\n\n')))
    tree?.refresh([dir])
    await openFile(created.rel)
    toast(`已把 ${files.length} 篇合并成 ${created.rel}（原文稿都保留着）`, 'success')
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

/** 把选中的多篇当成一本书导出：同一份分页 + 自动目录，原文稿不动 */
async function exportMergedPdf(files: string[]): Promise<void> {
  const first = files[0]
  if (!first || files.length === 0) return
  const settings = currentSettings()
  try {
    const chunks: string[] = []
    for (const rel of files) {
      const result = await api.readFile(rel)
      if (!result.ok) throw new Error(`${rel}：${result.error}`)
      chunks.push(renderMarkdown(result.data.content))
    }
    const bodyHtml = chunks.join('')
    const paginated = settings.previewPageMode
      ? paginate(bodyHtml, {
          pageSize: settings.pdf.pageSize,
          marginMm: settings.pdf.marginMm,
          pageNumbers: settings.pdf.pageNumbers,
          toc: settings.pdfToc
        })
      : null
    const html = buildPrintDocument({
      title: files.length === 1 ? titleOf(first) : '合并导出',
      bodyHtml: paginated ? paginated.pages.join('') : bodyHtml,
      docDirAbs: docDirAbs(first),
      theme: 'light',
      typography: {
        lineHeight: settings.previewLineHeight,
        paragraphGap: settings.previewParagraphGap,
        fontPt: settings.previewFontPt,
        indent: settings.paragraphIndent
      },
      paginated: paginated
        ? {
            pageSize: settings.pdf.pageSize,
            marginMm: settings.pdf.marginMm,
            markColor: settings.markColor
          }
        : undefined
    })
    state.pdfBusy = true
    renderTopbar()
    try {
      const result = await api.exportPdf({
        html,
        docDirAbs: docDirAbs(first) ?? '',
        baseName: files.length === 1 ? titleOf(first) : `${titleOf(first)}_等${files.length}篇`,
        options: settings.pdf,
        exactPages: paginated !== null
      })
      if (!result.ok) throw new Error(result.error)
      if (result.data.saved) toast(`已导出 ${files.length} 篇：${result.data.path ?? ''}`, 'success')
    } finally {
      state.pdfBusy = false
      renderTopbar()
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

/** 编辑器里的右键菜单 */
function showEditorContextMenu(x: number, y: number): void {
  document.querySelector('.context-menu')?.remove()
  const menu = el('div', { class: 'context-menu' })
  const items: Array<{ label: string; run: () => void } | 'separator'> = [
    { label: '从光标处切分文件', run: () => void splitAtCursor() },
    'separator',
    { label: '查找', run: () => findBar?.open('find') },
    { label: '查找并替换', run: () => findBar?.open('replace') },
    'separator',
    {
      label: '全选',
      run: () => {
        const view = editor?.view
        if (view) view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
      }
    }
  ]
  for (const item of items) {
    if (item === 'separator') {
      menu.append(el('div', { class: 'context-sep' }))
      continue
    }
    menu.append(
      el('button', {
        class: 'context-item',
        type: 'button',
        text: item.label,
        onclick: () => {
          menu.remove()
          item.run()
        }
      })
    )
  }
  document.body.append(menu)
  const rect = menu.getBoundingClientRect()
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`
}

async function closeFile(): Promise<void> {
  await flushSave()
  state.currentRel = null
  state.dirty = false
  state.conflict = null
  state.diskMtimeMs = null
  suppressChanges = true
  try {
    editor?.setDoc('', {})
  } finally {
    suppressChanges = false
  }
  clear(refs.previewHost)
  latestStats = { words: 0, chars: 0, lines: 0, paragraphs: 0 }
  refs.editorPlaceholder.style.display = 'flex'
  tree?.setActive(null)
  void api.updateSettings({ lastOpenedFile: null })
  renderStatus()
  changed()
}

async function reloadFromDisk(rel: string, notify: boolean): Promise<void> {
  const result = await api.readFile(rel)
  if (!result.ok) {
    toast(`重新载入失败：${result.error}`, 'error')
    return
  }
  applyDiskContent(result.data.content, result.data.mtimeMs, true)
  renderStatus()
  if (notify) toast('已从磁盘重新载入', 'success')
}

/* ------------------------------ 预览 ------------------------------ */

function renderPreview(): void {
  const rel = state.currentRel
  if (!rel || !editor) {
    clear(refs.previewHost)
    return
  }
  const settings = state.settings
  const scroller = refs.previewHost
  const before = scroller.scrollHeight - scroller.clientHeight
  const ratio = before > 0 ? scroller.scrollTop / before : 0

  const html = renderMarkdown(editor.getDoc())
  if (settings?.previewPageMode) {
    // 分页预览：和导出用的是同一份分页结果，所以所见即所得
    const result = paginate(html, {
      pageSize: settings.pdf.pageSize,
      marginMm: settings.pdf.marginMm,
      pageNumbers: settings.pdf.pageNumbers,
      toc: settings.pdfToc
    })
    scroller.classList.add('md-pages')
    scroller.innerHTML = result.pages.join('')
    scroller.dataset['overflow'] = result.overflow ? '1' : '0'
  } else {
    scroller.classList.remove('md-pages')
    scroller.innerHTML = html
  }
  rewriteRelativeUrls(scroller, docDirAbs(rel))

  const after = scroller.scrollHeight - scroller.clientHeight
  if (after > 0) scroller.scrollTop = after * ratio
}

function schedulePreview(): void {
  if (previewTimer !== null) return
  // 分页预览每次都要离屏量高度，代价高一些，所以延迟放宽
  const delay = state.settings?.previewPageMode ? 520 : 140
  previewTimer = window.setTimeout(() => {
    previewTimer = null
    renderPreview()
  }, delay)
}

function syncFromEditor(): void {
  if (suppressScroll || !state.settings?.previewVisible) return
  suppressScroll = true
  const scroller = refs.previewHost
  const max = scroller.scrollHeight - scroller.clientHeight
  if (max > 0 && editor) scroller.scrollTop = max * editor.scrollRatio()
  requestAnimationFrame(() => {
    suppressScroll = false
  })
}

function syncFromPreview(): void {
  if (suppressScroll || !editor) return
  suppressScroll = true
  const scroller = refs.previewHost
  const max = scroller.scrollHeight - scroller.clientHeight
  if (max > 0) editor.setScrollRatio(scroller.scrollTop / max)
  requestAnimationFrame(() => {
    suppressScroll = false
  })
}

function onCursorMove(line: number, total: number): void {
  if (suppressScroll || !state.settings?.previewVisible) return
  suppressScroll = true
  const scroller = refs.previewHost
  const max = scroller.scrollHeight - scroller.clientHeight
  if (max > 0) {
    const ratio = total <= 1 ? 0 : (line - 1) / (total - 1)
    scroller.scrollTop = max * ratio
  }
  requestAnimationFrame(() => {
    suppressScroll = false
  })
}

/* ------------------------------ 界面渲染 ------------------------------ */

function scheduleStats(): void {
  if (statsTimer !== null) window.clearTimeout(statsTimer)
  statsTimer = window.setTimeout(() => {
    statsTimer = null
    latestStats = countText(editor?.getDoc() ?? '')
    renderStatus()
  }, 180)
}

function updateTitle(): void {
  const rel = state.currentRel
  document.title = rel ? `${state.dirty ? '• ' : ''}${titleOf(rel)} — 墨笔` : '墨笔'
  if (docChip) docChip.textContent = rel ? titleOf(rel) : ''
}

function renderStatus(): void {
  const host = refs.statusbar
  clear(host)
  const rel = state.currentRel

  let saveText = '未打开文稿'
  let errorClass = ''
  if (rel) {
    if (state.saving) saveText = '保存中…'
    else if (state.lastSaveError) {
      saveText = `保存失败：${state.lastSaveError}`
      errorClass = 'status-error'
    } else if (state.dirty) saveText = '有未保存的改动'
    else if (state.lastSavedAt) saveText = `已保存 ${formatTime(state.lastSavedAt)}`
    else saveText = '已保存'
  }

  host.append(
    el('span', { class: 'status-path', text: rel ?? '未打开文稿' }),
    el('span', { text: `${latestStats.words} 字` }),
    el('span', { text: `${latestStats.chars} 字符` }),
    el('span', { text: `${latestStats.lines} 行` }),
    el('span', { class: errorClass || undefined, text: saveText })
  )

  if (state.watchMessage) {
    host.append(el('span', { class: 'status-error', text: state.watchMessage }))
  }
  // 首行缩进是写作时随手会切的，放在下栏；设置入口也在这（另一个是 Ctrl+,）
  host.append(
    el(
      'button',
      {
        class: state.settings?.paragraphIndent ? 'status-action active' : 'status-action',
        type: 'button',
        title: '正文首行缩进两格（中文文稿习惯）',
        onclick: () => void toggleSetting('paragraphIndent')
      },
      [icon('lines', 13), el('span', { text: '首行缩进' })]
    ),

    el('button', {
      class: 'status-action',
      type: 'button',
      title: '设置  Ctrl+,',
      onclick: () => void openSettings()
    }, [icon('sliders', 13), el('span', { text: '设置' })])
  )
  updateTitle()
}

function renderBanner(): void {
  const host = refs.bannerHost
  clear(host)
  const conflict = state.conflict
  if (!conflict) return
  const removed = conflict.kind === 'removed'
  const text = removed
    ? `「${conflict.rel}」已经不在磁盘上了（被外部删除或改名）。编辑器里还留着内容，建议另存为新文稿。`
    : `「${conflict.rel}」在磁盘上被外部程序改过，而你这边还有没保存的改动。直接保存会覆盖磁盘上的版本。`

  const buttons: HTMLElement[] = removed
    ? [
        el('button', { type: 'button', text: '另存为新文稿', onclick: () => void saveAsCopy() }),
        el('button', { type: 'button', text: '关闭这篇文稿', onclick: () => void closeFile() })
      ]
    : [
        el('button', {
          type: 'button',
          text: '重新载入磁盘版本',
          onclick: () => void reloadFromDisk(conflict.rel, true)
        }),
        el('button', {
          type: 'button',
          text: '用我的覆盖磁盘',
          onclick: () => void overwriteDisk()
        }),
        el('button', {
          type: 'button',
          text: '先不管',
          onclick: () => {
            state.conflict = null
            state.dirty = true
            changed()
            toast('已忽略。下次自动保存会覆盖磁盘上的版本。', 'info')
          }
        })
      ]

  host.append(el('div', { class: 'banner' }, [el('span', { class: 'banner-text', text }), ...buttons]))
}

async function overwriteDisk(): Promise<void> {
  state.conflict = null
  state.dirty = true
  changed()
  await flushSave()
}

function renderWelcome(): void {
  const host = refs.welcome
  const show = !state.vaultPath
  host.classList.toggle('visible', show)
  if (!show) return
  clear(host)
  const recent = state.settings?.recentVaults ?? []
  const recentBox = el('div', { class: 'recent' }, [el('div', { class: 'recent-title', text: '最近打开' })])
  if (recent.length === 0) {
    recentBox.append(el('div', { class: 'recent-title', text: '（还没有记录）' }))
  } else {
    for (const item of recent) {
      recentBox.append(
        el('button', {
          class: 'recent-item',
          type: 'button',
          text: item,
          onclick: () => void openVaultPath(item)
        })
      )
    }
  }
  host.append(
    el('div', { class: 'welcome-mark' }, [icon('book', 30)]),
    el('h1', { text: '墨笔' }),
    el('p', {
      text: '正常情况下启动就会自动打开你的文档库（我的文档\\MobiWriter），所有文稿都存在那一个文件夹里，不需要每次选。这里可以改成别的文件夹当文档库。'
    }),
    el('button', {
      class: 'btn primary',
      type: 'button',
      text: '选择其他文件夹',
      onclick: () => void chooseVault()
    }),
    recentBox
  )
}

function renderTopbar(): void {
  const host = refs.topbar
  clear(host)
  const settings = state.settings
  const hasVault = Boolean(state.vaultPath)
  const pdfBusy = state.pdfBusy
  const previewOn = settings?.previewVisible ?? false
  const sidebarOn = settings?.sidebarVisible ?? true
  const statusbarOn = settings?.statusbarVisible ?? true
  const focusOn = document.body.classList.contains('focus-mode')
  const linesOn = settings?.showLineNumbers ?? false
  const dark = settings?.theme === 'dark'

  const iconButton = (
    name: IconName,
    label: string,
    on: boolean,
    run: () => void
  ): HTMLButtonElement =>
    el(
      'button',
      {
        class: `icon-button${on ? ' toggle-on' : ''}`,
        type: 'button',
        title: label,
        'aria-label': label,
        onclick: run
      },
      [icon(name)]
    )

  docChip = el('span', {
    class: 'doc-chip',
    text: state.currentRel ? titleOf(state.currentRel) : ''
  })

  // 顶栏左侧：一个「菜单」按钮，命令都从这里进（不再往设置里塞）
  const menuButton = iconButton('menu', '菜单  Ctrl+K', false, () => commandMenu?.toggle())

  // 面板开关放在标题栏右侧（类似 VS Code 的布局按钮），窗口按钮更靠右。
  // 注意：前面必须有 spacer 把内容顶到右边，否则所有东西都会挤在左边。
  host.append(
    menuButton,
    el('div', { class: 'spacer' }),
    docChip,
    el('div', { class: 'panel-toggles' }, [
      iconButton('panel-left', '显示 / 隐藏左栏（文稿树）', sidebarOn, () => void togglePanel('sidebar')),
      iconButton('panel-bottom', '显示 / 隐藏下栏（状态栏）', statusbarOn, () => void togglePanel('statusbar')),
      iconButton('panel-right', '显示 / 隐藏右栏（预览）', previewOn, () => void togglePanel('preview'))
    ]),
    // 窗口按钮自己画：系统画的那些不跟页面缩放走，一缩放就和顶栏对不上、很跳。
    // 自己画就永远和顶栏在同一个缩放体系里。
    el('div', { class: 'window-buttons' }, [
      winButton('win-min', '最小化', () => void api.windowControl('minimize')),
      winButton(
        state.maximized ? 'win-restore' : 'win-max',
        state.maximized ? '向下还原' : '最大化',
        () => void api.windowControl('maximize')
      ),
      winButton('win-close', '关闭', () => void api.windowControl('close'), 'close')
    ])
  )
}

/** 自绘的窗口按钮 */
function winButton(name: IconName, label: string, run: () => void, extra = ''): HTMLButtonElement {
  const className = extra ? `window-button ${extra}` : 'window-button'
  return el('button', { class: className, type: 'button', title: label, onclick: run }, [icon(name, 14)])
}

/** 左栏 / 右栏 / 下栏的开关 */
async function togglePanel(panel: 'preview' | 'sidebar' | 'statusbar'): Promise<void> {
  const settings = currentSettings()
  if (panel === 'preview') await applySettingsPatch({ previewVisible: !settings.previewVisible })
  else if (panel === 'sidebar') await applySettingsPatch({ sidebarVisible: !settings.sidebarVisible })
  else await applySettingsPatch({ statusbarVisible: !settings.statusbarVisible })
}

function renderAll(): void {
  renderTopbar()
  renderStatus()
  renderBanner()
  renderWelcome()
  if (tree) setDirtyDot(refs.treeHost, state.currentRel, state.dirty)
  refs.vaultName.textContent = state.vaultPath ? `文档库 · ${basenameOf(state.vaultPath)}` : '文档库'
  refs.vaultName.title = state.vaultPath
    ? `文档库位置：${state.vaultPath}\n（点顶栏第一个图标可以换位置）`
    : '还没有打开文档库'
  refs.btnNewFile.disabled = !state.vaultPath
  refs.btnNewFolder.disabled = !state.vaultPath
  refs.btnExpandAll.disabled = !state.vaultPath
  refreshExpandButton()
}

/** 「一键展开 / 折叠整个文档库」按钮的图标跟着当前状态走 */
function refreshExpandButton(): void {
  if (!refs.btnExpandAll) return
  const expanded = tree?.isAllExpanded() ?? false
  refs.btnExpandAll.replaceChildren(icon(expanded ? 'collapse-all' : 'expand-all', 15))
  refs.btnExpandAll.title = expanded ? '折叠全部目录' : '一键展开整个文档库'
}

async function toggleExpandAll(): Promise<void> {
  if (!tree || !state.vaultPath) return
  if (tree.isAllExpanded()) {
    tree.collapseAll()
  } else {
    const result = await tree.expandAll()
    if (result.truncated) {
      toast(`目录太多，先展开了 ${result.dirs} 个文件夹就停下了，剩下的点开看吧`, 'info')
    }
  }
  refreshExpandButton()
}

function applyChrome(): void {
  const settings = state.settings
  if (!settings) return
  document.documentElement.dataset['theme'] = settings.theme
  document.body.classList.toggle('no-preview', !settings.previewVisible)
  document.body.classList.toggle('no-sidebar', !settings.sidebarVisible)
  document.body.classList.toggle('no-statusbar', !settings.statusbarVisible)
  // 只看预览：预览开着并且设置了「隐藏源代码」时才收起编辑区
  document.body.classList.toggle('preview-mode', settings.previewVisible)

  // 行距和段后距交给 CSS 变量，编辑器和预览各用各的
  const root = document.documentElement.style
  root.setProperty('--editor-line-height', String(settings.editorLineHeight))
  root.setProperty('--preview-line-height', String(settings.previewLineHeight))
  root.setProperty('--preview-para-gap', `${settings.previewParagraphGap}em`)
  root.setProperty('--preview-mark', settings.markColor)
  root.setProperty('--preview-font-pt', `${settings.previewFontPt}pt`)
  root.setProperty('--preview-indent', settings.paragraphIndent ? '2em' : '0')
  // 分页预览的纸张尺寸
  for (const [name, value] of Object.entries(
    pageVars({
      pageSize: settings.pdf.pageSize,
      marginMm: settings.pdf.marginMm,
      pageNumbers: settings.pdf.pageNumbers
    })
  )) {
    root.setProperty(name, value)
  }

  editor?.setTheme(settings.theme)
  editor?.setLineNumbers(settings.showLineNumbers)
  editor?.setParagraphIndent(settings.paragraphIndent)
}

/* ------------------------------ 动作 ------------------------------ */

async function applySettingsPatch(patch: Partial<Settings>): Promise<void> {
  const result = await api.updateSettings(patch)
  if (!result.ok) {
    toast(result.error, 'error')
    return
  }
  state.settings = result.data
  applyChrome()
  renderAll()
  // 有些设置会影响预览的渲染方式（分页开关、纸张大小），改完要重画一次
  if (state.currentRel) renderPreview()
}

async function chooseVault(): Promise<void> {
  await flushSave()
  const result = await api.chooseVault()
  if (!result.ok) toast(result.error, 'error')
}

async function openVaultPath(dir: string): Promise<void> {
  await flushSave()
  const result = await api.openVault(dir)
  if (!result.ok) toast(result.error, 'error')
}

async function closeVault(): Promise<void> {
  await flushSave()
  const result = await api.closeVault()
  if (!result.ok) toast(result.error, 'error')
}

async function newFile(): Promise<void> {
  if (!state.vaultPath) {
    toast('先打开一个文件夹', 'info')
    return
  }
  await tree?.createIn(tree.targetDir(), 'file')
}

async function newFolder(): Promise<void> {
  if (!state.vaultPath) {
    toast('先打开一个文件夹', 'info')
    return
  }
  await tree?.createIn(tree.targetDir(), 'dir')
}

/** 批量导入：把外部选中的 Markdown 复制进文档库（当前选中的文件夹） */
async function importMarkdownFiles(): Promise<void> {
  if (!state.vaultPath || !tree) {
    toast('先打开文档库', 'info')
    return
  }
  const dir = tree.targetDir()
  const result = await api.importFiles(dir)
  if (!result.ok) {
    toast(`导入失败：${result.error}`, 'error')
    return
  }
  const { imported, renamed, skipped } = result.data
  if (imported.length === 0 && renamed.length === 0 && skipped.length === 0) return

  const parts: string[] = []
  if (imported.length > 0) parts.push(`已导入 ${imported.length} 篇`)
  if (renamed.length > 0) parts.push(`${renamed.length} 篇重名已自动改名`)
  if (skipped.length > 0) parts.push(`跳过 ${skipped.length} 个（后缀不支持）`)
  toast(parts.join('，'), imported.length > 0 ? 'success' : 'info')

  tree.refresh([dir])
  if (imported.length === 1 && imported[0]) await openFile(imported[0])
}

async function toggleSetting(key: 'previewVisible' | 'showLineNumbers' | 'paragraphIndent'): Promise<void> {
  const settings = currentSettings()
  await applySettingsPatch({ [key]: !settings[key] } as Partial<Settings>)
}

async function toggleTheme(): Promise<void> {
  const settings = currentSettings()
  await applySettingsPatch({ theme: settings.theme === 'dark' ? 'light' : 'dark' })
}

/** 一键备份：整个文档库复制到指定位置（带时间戳，可以是网盘同步目录） */
async function backupNow(): Promise<void> {
  if (!state.vaultPath) {
    toast('先打开文档库', 'info')
    return
  }
  toast('正在备份，文档多的话会慢一点…', 'info')
  const result = await api.backupLibrary()
  if (!result.ok) {
    toast(`备份失败：${result.error}`, 'error')
    return
  }
  if (result.data === null) return
  const { destination, files, bytes } = result.data
  toast(`已备份 ${files} 个文件（${formatBytes(bytes)}）：${destination}`, 'success')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 界面缩放：主进程改 webContents 的 zoomLevel 并持久化 */
async function zoomBy(action: 'in' | 'out' | 'reset'): Promise<number> {
  const result = await api.zoom(action)
  if (!result.ok) return currentSettings().zoomLevel
  // 窗口按钮是自己画的，跟顶栏同一套缩放，不需要再做任何反算
  return result.data
}

/** 菜单和快捷键都走这里（不弹提示，避免每次缩放都跳一个通知） */
async function zoomByAction(action: 'in' | 'out' | 'reset'): Promise<void> {
  await zoomBy(action)
}

function toggleFocus(): void {
  const on = !document.body.classList.contains('focus-mode')
  document.body.classList.toggle('focus-mode', on)
  // 专注模式顺带打开打字机滚动，光标一直停在视口偏上位置
  editor?.setTypewriter(on)
  renderTopbar()
}

async function openSettings(): Promise<void> {
  const settings = currentSettings()
  const result = await openSettingsDialog(
    {
      autosaveMs: settings.autosaveMs,
      showLineNumbers: settings.showLineNumbers,
      previewVisible: settings.previewVisible,
      previewOnly: settings.previewOnly,
      previewPageMode: settings.previewPageMode,
      markColor: settings.markColor,
      previewFontPt: settings.previewFontPt,
      paragraphIndent: settings.paragraphIndent,
      pdfToc: settings.pdfToc,
      editorLineHeight: settings.editorLineHeight,
      previewLineHeight: settings.previewLineHeight,
      previewParagraphGap: settings.previewParagraphGap,
      pageSize: settings.pdf.pageSize,
      marginMm: settings.pdf.marginMm,
      pageNumbers: settings.pdf.pageNumbers,
      printBackground: settings.pdf.printBackground
    },
    {
      version: state.version,
      onBackup: backupNow,
      zoomLevel: settings.zoomLevel,
      onZoom: zoomBy
    }
  )
  if (!result) return
  await applySettingsPatch({
    autosaveMs: result.autosaveMs,
    showLineNumbers: result.showLineNumbers,
    previewVisible: result.previewVisible,
    previewOnly: result.previewOnly,
    previewPageMode: result.previewPageMode,
    markColor: result.markColor,
    previewFontPt: result.previewFontPt,
    paragraphIndent: result.paragraphIndent,
    pdfToc: result.pdfToc,
    editorLineHeight: result.editorLineHeight,
    previewLineHeight: result.previewLineHeight,
    previewParagraphGap: result.previewParagraphGap,
    pdf: {
      pageSize: result.pageSize,
      marginMm: result.marginMm,
      pageNumbers: result.pageNumbers,
      printBackground: result.printBackground
    }
  })
}

async function saveAsCopy(): Promise<void> {
  const rel = state.currentRel
  if (!rel || !editor) return
  const dir = parentOfRel(rel)
  const name = await promptSaveAsName(titleOf(rel))
  if (!name) return
  try {
    const created = must(await api.createEntry(dir, name, 'file'))
    const saved = must(await api.writeFile(created.rel, editor.getDoc()))
    state.conflict = null
    state.currentRel = created.rel
    state.diskMtimeMs = saved.mtimeMs
    state.dirty = false
    state.lastSavedAt = Date.now()
    tree?.refresh([dir])
    tree?.setActive(created.rel)
    renderStatus()
    changed()
    toast(`已另存为 ${created.rel}`, 'success')
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function promptSaveAsName(base: string): Promise<string | null> {
  return promptText({
    title: '另存为新文稿',
    label: '新文件名',
    value: `${base} 副本.md`,
    selectStem: true
  })
}

async function exportPdf(): Promise<void> {
  const rel = state.currentRel
  if (!rel || !editor) {
    toast('先打开一篇文稿', 'info')
    return
  }
  await flushSave()
  const dir = docDirAbs(rel)
  const title = titleOf(rel)
  const settings = currentSettings()
  const bodyHtml = renderMarkdown(editor.getDoc())
  const paginated = settings.previewPageMode
    ? paginate(bodyHtml, {
        pageSize: settings.pdf.pageSize,
        marginMm: settings.pdf.marginMm,
        pageNumbers: settings.pdf.pageNumbers,
        toc: settings.pdfToc
      })
    : null
  const html = buildPrintDocument({
    title,
    bodyHtml: paginated ? paginated.pages.join('') : bodyHtml,
    docDirAbs: dir,
    theme: 'light',
    typography: {
      lineHeight: settings.previewLineHeight,
      paragraphGap: settings.previewParagraphGap,
      fontPt: settings.previewFontPt,
      indent: settings.paragraphIndent
    },
    paginated: paginated
      ? {
          pageSize: settings.pdf.pageSize,
          marginMm: settings.pdf.marginMm,
          markColor: settings.markColor
        }
      : undefined
  })

  state.pdfBusy = true
  renderTopbar()
  try {
    const result = await api.exportPdf({
      html,
      docDirAbs: dir ?? '',
      baseName: title,
      options: settings.pdf,
      exactPages: paginated !== null
    })
    if (!result.ok) {
      toast(`导出失败：${result.error}`, 'error')
      return
    }
    if (result.data.saved) toast(`已导出：${result.data.path ?? ''}`, 'success')
  } finally {
    state.pdfBusy = false
    renderTopbar()
  }
}

/* ------------------------------ 磁盘变化 ------------------------------ */

async function handleFsChanged(payload: WatchPayload): Promise<void> {
  const current = state.currentRel

  // 我们刚刚自己改过名 / 移动过：磁盘事件是这次操作的残留，直接忽略这一轮
  const renamed = recentRename
  if (renamed && Date.now() - renamed.at < 2000) {
    const touched = [renamed.oldRel, renamed.newRel]
    const hit =
      touched.some((rel) => payload.removed.includes(rel) || payload.files.includes(rel)) ||
      payload.dirs.length > 0
    if (hit) {
      if (payload.dirs.length > 0) tree?.refresh(payload.dirs)
      return
    }
  }

  if (current && payload.removed.includes(current)) {
    state.conflict = { rel: current, kind: 'removed', diskMtimeMs: 0 }
    changed()
  } else if (current && payload.files.includes(current)) {
    if (!state.dirty && !state.saving) {
      // 先确认文件真的还在：改名那一瞬间的事件可能指向已经不存在的旧路径，
      // 直接重载会弹一个没头没尾的 ENOENT
      const stat = await api.statEntry(current)
      if (!stat.ok || !stat.data.exists) {
        if (payload.dirs.length > 0) tree?.refresh(payload.dirs)
        return
      }
      await reloadFromDisk(current, false)
      toast('磁盘上的文件有变化，已自动重新载入', 'info')
    } else {
      const stat = await api.statEntry(current)
      state.conflict = {
        rel: current,
        kind: 'modified',
        diskMtimeMs: stat.ok ? stat.data.mtimeMs : 0
      }
      changed()
    }
  }

  if (payload.dirs.length > 0) tree?.refresh(payload.dirs)
}

/** 刚改过名的路径（新旧都记），用来忽略随之而来的磁盘事件 */
let recentRename: { oldRel: string; newRel: string; at: number } | null = null

function handleRenamed(oldRel: string, newRel: string): void {
  recentRename = { oldRel, newRel, at: Date.now() }
  const current = state.currentRel
  if (!current) return
  if (current === oldRel || current.startsWith(`${oldRel}/`)) {
    const next = newRel + current.slice(oldRel.length)
    state.currentRel = next
    tree?.setActive(next)
    renderStatus()
    void api.updateSettings({ lastOpenedFile: next })
  }
  changed()
}

function handleRemoved(rel: string): void {
  const current = state.currentRel
  if (!current) return
  if (current === rel || current.startsWith(`${rel}/`)) {
    state.dirty = true
    state.conflict = { rel: current, kind: 'removed', diskMtimeMs: 0 }
    toast('当前文稿已被删除，编辑器里还留着内容，请另存为新文稿。', 'error')
    changed()
  }
}

/* ------------------------------ 菜单动作 ------------------------------ */

async function handleMenuAction(action: MenuAction): Promise<void> {
  switch (action) {
    case 'open-vault':
      return chooseVault()
    case 'close-vault':
      return closeVault()
    case 'new-file':
      return newFile()
    case 'new-folder':
      return newFolder()
    case 'save':
      await flushSave()
      return
    case 'export-pdf':
      return exportPdf()
    case 'undo':
      editor?.undo()
      return
    case 'redo':
      editor?.redo()
      return
    case 'find':
      findBar?.open('find')
      return
    case 'replace':
      findBar?.open('replace')
      return
    case 'search':
      openSearch()
      return
    case 'backup':
      return backupNow()
    case 'toggle-preview':
      return toggleSetting('previewVisible')
    case 'toggle-sidebar':
      return togglePanel('sidebar')
    case 'toggle-statusbar':
      return togglePanel('statusbar')
    case 'zoom-in':
      return zoomByAction('in')
    case 'zoom-out':
      return zoomByAction('out')
    case 'zoom-reset':
      return zoomByAction('reset')
    case 'toggle-focus':
      toggleFocus()
      return
    case 'toggle-line-numbers':
      return toggleSetting('showLineNumbers')
    case 'toggle-theme':
      return toggleTheme()
    case 'open-settings':
      return openSettings()
    case 'open-command-menu':
      commandMenu?.toggle()
      return
  }
}

/* ------------------------------ 分隔条 ------------------------------ */

function setupSplitters(): void {
  let dragging: 'left' | 'right' | null = null

  refs.splitterLeft.addEventListener('mousedown', (event) => {
    dragging = 'left'
    event.preventDefault()
  })

  window.addEventListener('mousemove', (event) => {
    if (!dragging) return
    const workspace = refs.previewPane.parentElement
    if (!workspace) return
    const rect = workspace.getBoundingClientRect()
    if (dragging === 'left') {
      const width = Math.min(Math.max(event.clientX - rect.left, 160), Math.min(560, rect.width - 320))
      refs.sidebar.style.width = `${width}px`
    } else {
      const fromRight = rect.right - event.clientX
      const width = Math.min(Math.max(fromRight, 220), Math.max(220, rect.width - 320))
      refs.workspace.style.setProperty('--preview-width', `${width}px`)
    }
  })

  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = null
  })
}

/* ------------------------------ 启动 ------------------------------ */

async function bootstrap(): Promise<void> {
  // 让 CSS 知道平台：Windows / Linux 的窗口按钮是系统画在右上角的，顶栏要给它留位
  document.documentElement.dataset['platform'] = api.platform

  // 侧栏顶部三个按钮都用图标，避免出现「文稿 / 文件夹」这类文字标签
  refs.btnExpandAll.append(icon('expand-all', 15))
  refs.btnNewFile.append(icon('file-plus', 15))
  refs.btnNewFolder.append(icon('folder-plus', 15))
  refs.btnExpandAll.addEventListener('click', () => void toggleExpandAll())

  const initial = await api.getState()
  if (initial.ok) {
    state.settings = initial.data.settings
    state.version = initial.data.version
    state.vaultPath = initial.data.settings.vaultPath
  } else {
    toast(`读取设置失败：${initial.error}`, 'error')
  }

  editor = createEditor({
    parent: refs.editorHost,
    initialDoc: '',
    theme: state.settings?.theme ?? 'light',
    showLineNumbers: state.settings?.showLineNumbers ?? false,
    paragraphIndent: state.settings?.paragraphIndent ?? false,
    onChange: () => {
      schedulePreview()
      onDocChange()
    },
    onSaveShortcut: () => void flushSave(),
    onFindShortcut: (mode) => findBar?.open(mode),
    onCursorMove
  })

  tree = createTree(refs.treeHost, {
    onOpenFile: (rel) => void openFile(rel),
    onRenamed: handleRenamed,
    onRemoved: handleRemoved,
    onImportRequest: () => void importMarkdownFiles(),
    onMergeRequest: (files) => void mergeFiles(files),
    onExportMergeRequest: (files) => void exportMergedPdf(files),
    onTreeChanged: refreshExpandButton,
    onError: (message) => toast(message, 'error')
  })

  listSearch = createListSearch({
    resultsHost: refs.resultsHost,
    treeHost: refs.treeHost,
    onOpen: (target) => void openFileAt(target),
    onError: (message) => toast(message, 'error')
  })

  // 菜单锚在顶栏上（顶栏是常驻元素，而里面的按钮每次重渲染都会换掉）
  commandMenu = createCommandMenu(refs.topbar, (id) => {
    if (id === 'import-files') void importMarkdownFiles()
    else void handleMenuAction(id as MenuAction)
  })

  findBar = createFindBar(refs.findHost, () => editor?.view ?? null, {
    // 勾选「在列表中搜索」时，把关键词同步给左栏列表（替换只作用于当前文稿）
    onListSearch: (query, options) => listSearch?.search(query, options)
  })

  decorateLinks(refs.previewHost, () => (state.currentRel ? parentOfRel(state.currentRel) : ''), {
    onOpenFile: (rel) => void openFile(rel),
    onExternal: (url) => void api.openExternal(url)
  })

  refs.editorHost.addEventListener('scroll', syncFromEditor, true)
  refs.editorHost.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    showEditorContextMenu(event.clientX, event.clientY)
  })
  refs.previewHost.addEventListener('scroll', syncFromPreview)

  api.onMenuAction((action) => void handleMenuAction(action))
  api.onFsChanged((payload) => void handleFsChanged(payload))
  api.onWatchStatus((status) => {
    state.watchMessage = status.watching ? null : (status.message ?? '文件监听不可用')
    changed()
  })
  api.onRequestFlush(() => {
    void (async () => {
      try {
        await flushSave()
        api.notifyFlushDone(true)
      } catch (error) {
        api.notifyFlushDone(false, error instanceof Error ? error.message : String(error))
      }
    })()
  })
  api.onWindowState((payload) => {
    state.maximized = payload.maximized
    renderTopbar()
  })

  api.onVaultChanged((payload) => {
    state.settings = payload.settings
    const nextVault = payload.settings.vaultPath
    if (nextVault !== state.vaultPath) {
      state.vaultPath = nextVault
      if (nextVault) {
        tree?.setVault(nextVault)
      } else {
        tree?.setVault(null)
        void closeFile()
      }
    }
    applyChrome()
    renderAll()
  })

  onChange(() => {
    renderStatus()
    renderBanner()
    if (tree) setDirtyDot(refs.treeHost, state.currentRel, state.dirty)
  })

  setupSplitters()
  applyChrome()
  renderAll()

  if (state.vaultPath) {
    tree.setVault(state.vaultPath)
    const last = state.settings?.lastOpenedFile
    if (last) {
      const stat = await api.statEntry(last)
      if (stat.ok && stat.data.exists && !stat.data.isDir) {
        await openFile(last)
      }
    }
  }

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const menu = document.querySelector('.context-menu')
      menu?.remove()
      return
    }
    // 界面缩放。菜单里也有，但菜单栏是隐藏的，所以这里兜一层，免得快捷键"不明显"
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey === undefined) return
    if (event.key === ',') {
      event.preventDefault()
      void openSettings()
    } else if (event.key === 'k' || event.key === 'K') {
      event.preventDefault()
      commandMenu?.toggle()
    } else if (event.key === 'f' || event.key === 'F') {
      event.preventDefault()
      findBar?.open('find')
    } else if (event.key === 'h' || event.key === 'H') {
      event.preventDefault()
      findBar?.open('replace')
    } else if (event.key === '=' || event.key === '+') {
      event.preventDefault()
      void zoomByAction('in')
    } else if (event.key === '-') {
      event.preventDefault()
      void zoomByAction('out')
    } else if (event.key === '0') {
      event.preventDefault()
      void zoomByAction('reset')
    }
  })

  api.notifyReady()
}

void bootstrap().catch((error: unknown) => {
  toast(`启动失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  console.error(error)
})
