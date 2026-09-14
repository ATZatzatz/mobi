/**
 * 右边栏：一个面板，四个标签页。
 *
 * 思路来自 Word 的任务窗格 / VS Code 的右侧面板：把「边写边要调、边写边要看」的东西
 * 放在常驻侧栏里，而不是塞进模态对话框（模态框遮住正文，调完才能看效果）。
 *
 * 四个标签：
 *   目录   —— 当前文稿的标题层级，点一下跳过去（默认）
 *   排版   —— 最常调的几个参数（行距 / 字号 / 段后 / 缩进 / 主题…）
 *   查找   —— 查找替换栏就挂在这一页里（不再把编辑区往下挤）
 *   文档库 —— 当前库位置、最近打开、换库
 */
import { el } from './dom'
import { icon } from './icons'
import type { Settings } from '@shared/types'

export type RightTab = 'outline' | 'typography' | 'find' | 'library'

export interface OutlineItem {
  level: number
  text: string
  line: number
}

/**
 * 从 Markdown 源码里抽出标题（含自定义的 `#@ 居中标题`）。
 * 跳过围栏代码块里的内容，否则代码里的 # 也会被当成标题。
 */
export function parseOutline(text: string): OutlineItem[] {
  const items: OutlineItem[] = []
  let fence = false
  const lines = text.split(/\r\n|\r|\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trimEnd()
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence
      continue
    }
    if (fence) continue
    const matched = /^(#{1,6})@?\s+(.+?)\s*#*\s*$/.exec(line)
    if (matched) {
      items.push({ level: (matched[1] as string).length, text: matched[2] as string, line: index + 1 })
    }
  }
  return items
}

export interface LibraryInfo {
  current: string | null
  recent: string[]
}

export interface RightPanelOptions {
  /** 查找栏挂载到这个容器里（由本模块提供） */
  findHost: HTMLElement
  onJump: (line: number) => void
  getOutlineText: () => string
  getSettings: () => Settings | null
  patchSettings: (patch: Partial<Settings>) => void
  getLibrary: () => LibraryInfo
  onChooseVault: () => void
  onOpenVault: (dir: string) => void
  /** 用户切标签页时通知外部持久化 */
  onTabChange?: (tab: RightTab) => void
}

export interface RightPanel {
  /** 面板根元素，由 main.ts 挂到布局里 */
  element: HTMLElement
  /** 查找栏要挂进来的容器 */
  findHost: HTMLElement
  setVisible(on: boolean): void
  show(tab: RightTab): void
  activeTab(): RightTab
  /** 文稿内容或设置变了之后重画 */
  refresh(): void
}

const TABS: Array<{ id: RightTab; label: string }> = [
  { id: 'outline', label: '目录' },
  { id: 'typography', label: '排版' },
  { id: 'find', label: '查找' },
  { id: 'library', label: '文档库' }
]

export function createRightPanel(options: RightPanelOptions): RightPanel {
  let active: RightTab = 'outline'
  const bodies = new Map<RightTab, HTMLElement>()
  const buttons = new Map<RightTab, HTMLButtonElement>()

  const listHost = el('div', { class: 'right-body' })
  const typographyHost = el('div', { class: 'right-body' })
  const findBody = options.findHost
  findBody.classList.add('right-body')
  const libraryHost = el('div', { class: 'right-body' })

  bodies.set('outline', listHost)
  bodies.set('typography', typographyHost)
  bodies.set('find', findBody)
  bodies.set('library', libraryHost)

  const tabBar = el('div', { class: 'right-tabs' })
  for (const tab of TABS) {
    const button = el('button', {
      class: 'right-tab',
      type: 'button',
      text: tab.label,
      onclick: () => {
        show(tab.id)
        options.onTabChange?.(tab.id)
      }
    })
    buttons.set(tab.id, button)
    tabBar.append(button)
  }

  const panel = el('aside', { class: 'right-panel' }, [tabBar, listHost, typographyHost, findBody, libraryHost])

  /* ------------------------------ 目录 ------------------------------ */

  function renderOutline(): void {
    const items = parseOutline(options.getOutlineText())
    listHost.replaceChildren()
    if (items.length === 0) {
      listHost.append(el('div', { class: 'right-empty', text: '这篇文稿还没有标题' }))
      return
    }
    for (const item of items) {
      const button = el('button', {
        class: 'outline-item',
        type: 'button',
        title: item.text,
        onclick: () => options.onJump(item.line)
      })
      button.style.paddingLeft = `${6 + (item.level - 1) * 12}px`
      button.append(el('span', { class: 'outline-text', text: item.text }))
      listHost.append(button)
    }
  }

  /* ------------------------------ 排版 ------------------------------ */

  const controls: Array<{ read: (s: Settings) => string | boolean; apply: (value: string) => void }> = []
  const numericInputs: Array<{ input: HTMLInputElement; read: (s: Settings) => number }> = []
  const checkboxInputs: Array<{ input: HTMLInputElement; read: (s: Settings) => boolean }> = []

  function numberRow(
    label: string,
    field: string,
    step: number,
    read: (s: Settings) => number,
    apply: (value: number) => void
  ): void {
    const input = el('input', {
      class: 'right-input',
      type: 'number',
      step: String(step),
      'data-field': field
    }) as HTMLInputElement
    input.addEventListener('change', () => {
      const value = Number(input.value)
      if (Number.isFinite(value)) apply(value)
    })
    numericInputs.push({ input, read })
    typographyHost.append(
      el('div', { class: 'right-row' }, [
        el('label', { class: 'right-label', text: label }),
        input
      ])
    )
  }

  function checkRow(label: string, field: string, read: (s: Settings) => boolean, apply: (value: boolean) => void): void {
    const input = el('input', { type: 'checkbox', 'data-field': field }) as HTMLInputElement
    input.addEventListener('change', () => apply(input.checked))
    checkboxInputs.push({ input, read })
    const wrapper = el('label', { class: 'right-check' }, [input, el('span', { text: label })])
    typographyHost.append(el('div', { class: 'right-row' }, [wrapper]))
  }

  typographyHost.append(el('div', { class: 'right-group', text: '正文排版' }))
  numberRow('编辑区行距', 'editorLineHeight', 0.05, (s) => s.editorLineHeight, (v) =>
    options.patchSettings({ editorLineHeight: v })
  )
  numberRow('正文字号（pt）', 'previewFontPt', 0.5, (s) => s.previewFontPt, (v) => options.patchSettings({ previewFontPt: v }))
  numberRow('预览行距', 'previewLineHeight', 0.05, (s) => s.previewLineHeight, (v) =>
    options.patchSettings({ previewLineHeight: v })
  )
  numberRow('段后距（em）', 'previewParagraphGap', 0.1, (s) => s.previewParagraphGap, (v) =>
    options.patchSettings({ previewParagraphGap: v })
  )
  checkRow('正文首行缩进两格', 'paragraphIndent', (s) => s.paragraphIndent, (v) =>
    options.patchSettings({ paragraphIndent: v })
  )

  typographyHost.append(el('div', { class: 'right-group', text: '显示' }))
  checkRow('显示行号', 'showLineNumbers', (s) => s.showLineNumbers, (v) => options.patchSettings({ showLineNumbers: v }))
  checkRow('预览按纸张分页', 'previewPageMode', (s) => s.previewPageMode, (v) =>
    options.patchSettings({ previewPageMode: v })
  )
  checkRow('深色主题', 'theme', (s) => s.theme === 'dark', (v) => options.patchSettings({ theme: v ? 'dark' : 'light' }))

  /* ------------------------------ 文档库 ------------------------------ */

  function renderLibrary(): void {
    const info = options.getLibrary()
    libraryHost.replaceChildren()
    libraryHost.append(el('div', { class: 'right-group', text: '当前文档库' }))
    libraryHost.append(
      el('div', { class: 'right-path', text: info.current ?? '还没有打开文档库', title: info.current ?? '' })
    )
    const choose = el('button', { class: 'btn right-button', type: 'button', text: '打开其他文件夹…', onclick: options.onChooseVault })
    libraryHost.append(el('div', { class: 'right-row' }, [choose]))

    if (info.recent.length > 0) {
      libraryHost.append(el('div', { class: 'right-group', text: '最近打开' }))
      for (const dir of info.recent) {
        libraryHost.append(
          el('button', {
            class: 'right-recent',
            type: 'button',
            text: dir,
            title: dir,
            onclick: () => options.onOpenVault(dir)
          })
        )
      }
    }
  }

  /* ------------------------------ 通用 ------------------------------ */

  function syncValues(): void {
    const settings = options.getSettings()
    if (!settings) return
    for (const { input, read } of numericInputs) {
      if (document.activeElement !== input) input.value = String(read(settings))
    }
    for (const { input, read } of checkboxInputs) {
      if (document.activeElement !== input) input.checked = read(settings)
    }
  }

  function show(tab: RightTab): void {
    active = tab
    for (const [id, body] of bodies) body.hidden = id !== tab
    for (const [id, button] of buttons) button.classList.toggle('active', id === tab)
    if (tab === 'outline') renderOutline()
    if (tab === 'typography') syncValues()
    if (tab === 'library') renderLibrary()
  }

  show('outline')

  return {
    element: panel,
    findHost: findBody,

    setVisible(on) {
      panel.hidden = !on
      if (on) show(active)
    },

    show,

    activeTab() {
      return active
    },

    refresh() {
      if (panel.hidden) return
      if (active === 'outline') renderOutline()
      else if (active === 'typography') syncValues()
      else if (active === 'library') renderLibrary()
    }
  }
}
