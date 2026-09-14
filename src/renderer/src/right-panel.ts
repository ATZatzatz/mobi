/**
 * 右边栏：两个标签页。
 *
 *   目录 —— 当前文稿的标题层级（默认）。按层级缩进 + 画层级引导线，
 *           右键标签页可以选「显示到第几级标题」。
 *   工具 —— 排版参数 / 查找替换 / 文档库，三段并排在一页里。
 *
 * 思路来自 Word 的任务窗格：把「边写边要调、边写边要看」的东西放常驻侧栏，
 * 而不是塞进模态对话框（模态框遮住正文，调完才能看效果）。
 */
import { api } from './api'
import { el } from './dom'
import type { Settings, Task } from '@shared/types'

export type RightTab = 'outline' | 'tools' | 'tasks'

export interface OutlineItem {
  level: number
  text: string
  line: number
}

/**
 * 从 Markdown 源码里抽出标题（含自定义的 `#@ 居中标题`）。
 * 跳过围栏代码块，否则代码里的 # 也会被当成标题。
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
  /** 查找栏挂到这个容器里 */
  findHost: HTMLElement
  onJump: (line: number) => void
  getOutlineText: () => string
  getSettings: () => Settings | null
  patchSettings: (patch: Partial<Settings>) => void
  getLibrary: () => LibraryInfo
  onChooseVault: () => void
  onOpenVault: (dir: string) => void
  /** 切换标签页（用于持久化 + 进入工具页时确保查找栏可见） */
  onTabChange?: (tab: RightTab) => void
}

export interface RightPanel {
  element: HTMLElement
  findHost: HTMLElement
  setVisible(on: boolean): void
  show(tab: RightTab): void
  activeTab(): RightTab
  refresh(): void
}

const TABS: Array<{ id: RightTab; label: string }> = [
  { id: 'outline', label: '目录' },
  { id: 'tools', label: '工具' },
  { id: 'tasks', label: '任务' }
]

export function createRightPanel(options: RightPanelOptions): RightPanel {
  let active: RightTab = 'outline'
  let tabBar: HTMLElement | null = null

  const outlineHost = el('div', { class: 'right-body' })
  const toolsHost = el('div', { class: 'right-body' })
  const tasksHost = el('div', { class: 'right-body' })

  // 工具页三段：排版 / 查找 / 文档库
  const typographySection = el('div', { class: 'right-section' })
  const findSection = el('div', { class: 'right-section' })
  const librarySection = el('div', { class: 'right-section' })
  toolsHost.append(typographySection, findSection, librarySection)

  const panel = el('aside', { class: 'right-panel' }, [outlineHost, toolsHost, tasksHost])

  function sectionTitle(text: string): HTMLElement {
    return el('div', { class: 'right-section-title', text })
  }

  /* ------------------------------ 目录 ------------------------------ */

  let levelMenu: HTMLElement | null = null

  function closeLevelMenu(): void {
    levelMenu?.remove()
    levelMenu = null
  }

  function openLevelMenu(x: number, y: number): void {
    closeLevelMenu()
    const current = options.getSettings()?.outlineMaxLevel ?? 6
    const menu = el('div', { class: 'context-menu' })
    menu.append(el('div', { class: 'right-section-title', text: '显示到第几级标题' }))
    for (let level = 1; level <= 6; level += 1) {
      menu.append(
        el('button', {
          class: `context-item${level === current ? ' active' : ''}`,
          type: 'button',
          text: `${'#'.repeat(level)}　${level} 级${level === current ? '　✓' : ''}`,
          onclick: () => {
            closeLevelMenu()
            options.patchSettings({ outlineMaxLevel: level })
            renderOutline()
          }
        })
      )
    }
    document.body.append(menu)
    menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 8)}px`
    menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 8)}px`
    levelMenu = menu
  }

  function renderOutline(): void {
    const maxLevel = options.getSettings()?.outlineMaxLevel ?? 6
    const items = parseOutline(options.getOutlineText()).filter((item) => item.level <= maxLevel)
    outlineHost.replaceChildren()
    if (items.length === 0) {
      outlineHost.append(el('div', { class: 'right-empty', text: '这篇文稿还没有标题' }))
      return
    }
    for (const item of items) {
      const button = el('button', {
        class: `outline-item lv${item.level}`,
        type: 'button',
        title: item.text,
        onclick: () => options.onJump(item.line)
      })
      button.style.paddingLeft = `${8 + (item.level - 1) * 14}px`
      // 层级引导线：画在这一级缩进位置的前面，一眼能看出从属关系
      if (item.level > 1) button.style.setProperty('--guide', `${(item.level - 1) * 14 + 1}px`)
      button.append(el('span', { class: 'outline-text', text: item.text }))
      outlineHost.append(button)
    }
  }

  /* ------------------------------ 排版 ------------------------------ */

  const numericInputs: Array<{ input: HTMLInputElement; read: (s: Settings) => number }> = []
  const checkboxInputs: Array<{ input: HTMLInputElement; read: (s: Settings) => boolean }> = []

  function numberRow(label: string, field: string, step: number, read: (s: Settings) => number, apply: (v: number) => void): void {
    const input = el('input', { class: 'right-input', type: 'number', step: String(step), 'data-field': field }) as HTMLInputElement
    input.addEventListener('change', () => {
      const value = Number(input.value)
      if (Number.isFinite(value)) apply(value)
    })
    numericInputs.push({ input, read })
    typographySection.append(el('div', { class: 'right-row' }, [el('label', { class: 'right-label', text: label }), input]))
  }

  function checkRow(label: string, field: string, read: (s: Settings) => boolean, apply: (v: boolean) => void): void {
    const input = el('input', { type: 'checkbox', 'data-field': field }) as HTMLInputElement
    input.addEventListener('change', () => apply(input.checked))
    checkboxInputs.push({ input, read })
    typographySection.append(
      el('div', { class: 'right-row' }, [el('label', { class: 'right-check' }, [input, el('span', { text: label })])])
    )
  }

  typographySection.append(sectionTitle('排版'))
  numberRow('编辑区行距', 'editorLineHeight', 0.05, (s) => s.editorLineHeight, (v) => options.patchSettings({ editorLineHeight: v }))
  numberRow('正文字号（pt）', 'previewFontPt', 0.5, (s) => s.previewFontPt, (v) => options.patchSettings({ previewFontPt: v }))
  numberRow('预览行距', 'previewLineHeight', 0.05, (s) => s.previewLineHeight, (v) => options.patchSettings({ previewLineHeight: v }))
  numberRow('段后距（em）', 'previewParagraphGap', 0.1, (s) => s.previewParagraphGap, (v) => options.patchSettings({ previewParagraphGap: v }))
  checkRow('正文首行缩进两格', 'paragraphIndent', (s) => s.paragraphIndent, (v) => options.patchSettings({ paragraphIndent: v }))
  checkRow('显示行号', 'showLineNumbers', (s) => s.showLineNumbers, (v) => options.patchSettings({ showLineNumbers: v }))
  checkRow('预览按纸张分页', 'previewPageMode', (s) => s.previewPageMode, (v) => options.patchSettings({ previewPageMode: v }))
  checkRow('深色主题', 'theme', (s) => s.theme === 'dark', (v) => options.patchSettings({ theme: v ? 'dark' : 'light' }))

  /* ------------------------------ 查找 ------------------------------ */

  findSection.append(sectionTitle('查找替换'))
  const findBody = options.findHost
  findBody.classList.add('right-find-host')
  findSection.append(findBody)

  /* ------------------------------ 任务（类滴答清单） ------------------------------ */

  let tasks: Task[] = []
  let tasksLoaded = false

  const taskInput = el('input', { class: 'task-input', type: 'text', placeholder: '添加待办…' }) as HTMLInputElement
  const dueInput = el('input', { class: 'task-date', type: 'date', title: '计划日期（可留空）' }) as HTMLInputElement
  const listHost = el('div', { class: 'task-list' })

  function todayString(): string {
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  }

  function persist(): void {
    void api.saveTasks(tasks)
  }

  function addTask(): void {
    const text = taskInput.value.trim()
    if (!text) return
    tasks.unshift({
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      text,
      due: dueInput.value || null,
      done: false,
      createdAt: Date.now()
    })
    taskInput.value = ''
    persist()
    renderTasks()
  }

  const addButton = el('button', { class: 'btn task-add-button', type: 'button', text: '添加', onclick: addTask })
  taskInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      addTask()
    }
    event.stopPropagation()
  })

  function taskItem(task: Task): HTMLElement {
    const checkbox = el('input', { type: 'checkbox' }) as HTMLInputElement
    checkbox.checked = task.done
    checkbox.addEventListener('change', () => {
      task.done = checkbox.checked
      persist()
      renderTasks()
    })
    const row = el('div', { class: `task-item${task.done ? ' done' : ''}` }, [
      checkbox,
      el('span', { class: 'task-text', text: task.text, title: task.text })
    ])
    if (task.due) {
      const overdue = !task.done && task.due < todayString()
      row.append(el('span', { class: `task-due${overdue ? ' overdue' : ''}`, text: task.due.slice(5) }))
    }
    row.append(
      el('button', {
        class: 'task-del',
        type: 'button',
        title: '删除',
        text: '×',
        onclick: () => {
          tasks = tasks.filter((item) => item.id !== task.id)
          persist()
          renderTasks()
        }
      })
    )
    return row
  }

  function taskGroup(title: string, items: Task[]): void {
    if (items.length === 0) return
    listHost.append(el('div', { class: 'right-section-title', text: `${title}（${items.length}）` }))
    for (const task of items) listHost.append(taskItem(task))
  }

  function renderTasks(): void {
    tasksHost.replaceChildren(el('div', { class: 'right-section-title', text: '待办' }))
    tasksHost.append(el('div', { class: 'task-add' }, [taskInput, dueInput, addButton]))
    listHost.replaceChildren()

    if (!tasksLoaded) {
      listHost.append(el('div', { class: 'right-empty', text: '正在读取…' }))
    } else if (tasks.length === 0) {
      listHost.append(el('div', { class: 'right-empty', text: '还没有待办。上面输入内容后回车即可添加' }))
    } else {
      const today = todayString()
      const open = tasks.filter((task) => !task.done)
      // 已排期的按日期排前面（过期的自然排最前），没排期的放后面
      taskGroup(
        '今天 / 已过期',
        open.filter((task) => task.due && task.due <= today).sort((a, b) => String(a.due).localeCompare(String(b.due)))
      )
      taskGroup('已排期', open.filter((task) => task.due && task.due > today).sort((a, b) => String(a.due).localeCompare(String(b.due))))
      taskGroup('未排期', open.filter((task) => !task.due))
      taskGroup('已完成', tasks.filter((task) => task.done))
    }
    tasksHost.append(listHost)
  }

  async function loadTasks(): Promise<void> {
    const result = await api.loadTasks()
    tasks = result.ok ? result.data : []
    tasksLoaded = true
    renderTasks()
  }

  renderTasks()
  void loadTasks()

  /* ------------------------------ 文档库 ------------------------------ */

  function renderLibrary(): void {
    const info = options.getLibrary()
    librarySection.replaceChildren(sectionTitle('文档库'))
    librarySection.append(el('div', { class: 'right-path', text: info.current ?? '还没有打开文档库', title: info.current ?? '' }))
    librarySection.append(
      el('div', { class: 'right-row' }, [
        el('button', { class: 'btn right-button', type: 'button', text: '打开其他文件夹…', onclick: options.onChooseVault })
      ])
    )
    if (info.recent.length > 0) {
      librarySection.append(el('div', { class: 'right-section-title', text: '最近打开' }))
      for (const dir of info.recent) {
        librarySection.append(
          el('button', { class: 'right-recent', type: 'button', text: dir, title: dir, onclick: () => options.onOpenVault(dir) })
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
    outlineHost.hidden = tab !== 'outline'
    toolsHost.hidden = tab !== 'tools'
    tasksHost.hidden = tab !== 'tasks'
    for (const button of tabBar?.querySelectorAll('.right-tab') ?? []) {
      button.classList.toggle('active', button.getAttribute('data-tab') === tab)
    }
    if (tab === 'outline') renderOutline()
    else if (tab === 'tasks') {
      if (!tasksLoaded) void loadTasks()
      else renderTasks()
    } else {
      syncValues()
      renderLibrary()
    }
  }

  tabBar = el('div', { class: 'right-tabs' })
  for (const tab of TABS) {
    const button = el('button', {
      class: 'right-tab',
      type: 'button',
      text: tab.label,
      'data-tab': tab.id,
      onclick: () => {
        show(tab.id)
        options.onTabChange?.(tab.id)
      },
      oncontextmenu: (event: Event) => {
        if (tab.id !== 'outline') return
        event.preventDefault()
        const mouse = event as MouseEvent
        openLevelMenu(mouse.clientX, mouse.clientY)
      }
    })
    tabBar.append(button)
  }
  panel.prepend(tabBar)

  document.addEventListener('mousedown', (event) => {
    if (levelMenu && !levelMenu.contains(event.target as Node)) closeLevelMenu()
  })

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
      else if (active === 'tasks') {
        // 文稿库换了就重新读一遍待办
        if (!tasksLoaded) void loadTasks()
        else renderTasks()
      } else {
        syncValues()
        renderLibrary()
      }
    }
  }
}
