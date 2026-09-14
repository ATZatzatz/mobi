/**
 * 文件树。
 *
 * 结构：最上层直接就是文档库里的文件夹和文稿（不再套一层「文档库」节点），
 * 树的层级 = 磁盘上真实的文件夹层级，展开时按需读取（懒加载）。
 *
 * 拖拽：不用浏览器的 HTML5 拖放（那个拖影和落点提示都很粗糙），
 * 改成自己用 Pointer 事件实现：
 *   - 拖起来的行变成一张跟手的浮起卡片，带轻微放大和阴影
 *   - 拖到文件夹上时整个文件夹亮起来，悬停一会儿会自动展开
 *   - 拖到空白处 = 移到文档库最外层
 *   - 靠近上下边缘会自动滚动
 *   - Esc 取消
 */
import { api, must } from './api'
import { clear, el } from './dom'
import { promptText } from './dialog'
import type { DirEntry } from '@shared/types'

/** 一键展开的保护上限：超过这个数量的文件夹就停下，避免超大文档库把界面拖死 */
const EXPAND_ALL_LIMIT = 1200

/** 文稿后缀。树上不显示后缀，但重命名时要保证文件名仍然带后缀。 */
const TEXT_EXTENSION = /\.(md|markdown|mdx|txt)$/i

/** 指针移动超过这个距离才算拖拽，避免和点击打架 */
const DRAG_THRESHOLD = 5
/** 悬停在收起的文件夹上多久自动展开 */
const SPRING_OPEN_DELAY = 550
/** 距离上下边缘多少像素开始自动滚动 */
const AUTO_SCROLL_ZONE = 30

function extensionOf(name: string): string {
  return TEXT_EXTENSION.exec(name)?.[0] ?? '.md'
}

/** 树上显示的名字：文件夹原样，文稿去掉 .md 这类后缀 */
function displayName(entry: DirEntry): string {
  return entry.kind === 'file' ? entry.name.replace(TEXT_EXTENSION, '') : entry.name
}

export interface TreeCallbacks {
  onOpenFile: (rel: string) => void
  /** 重命名后通知外部跟着改当前路径 */
  onRenamed: (oldRel: string, newRel: string) => void
  /** 删除后通知外部，如果删的是当前文件就关掉 */
  onRemoved: (rel: string) => void
  /** 多选后请求合并（按文件列表里的先后顺序） */
  onMergeRequest?: (files: string[]) => void
  /** 把选中的多篇合并导出成一份 PDF */
  onExportMergeRequest?: (files: string[]) => void
  /** 导入 Markdown 文件（要用主进程的文件选择框，所以交给外部处理） */
  onImportRequest?: (dirRel: string) => void
  /** 树结构或展开状态变化，用来刷新「全部展开 / 折叠」按钮 */
  onTreeChanged?: () => void
  onError: (message: string) => void
}

interface NodeRecord {
  li: HTMLElement
  row: HTMLElement
  childHost: HTMLElement | null
  entry: DirEntry
  loaded: boolean
}

interface DragState {
  sourceRel: string
  sourceRow: HTMLElement
  ghost: HTMLElement | null
  pointerId: number
  /** 抓取点在行内的偏移，保证卡片跟手 */
  offsetX: number
  offsetY: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  started: boolean
  targetDir: string | null
  springRel: string | null
  springAt: number
  lastHitTestAt: number
}

export interface ExpandAllResult {
  dirs: number
  truncated: boolean
}

export interface TreeHandle {
  setVault(root: string | null): void
  refresh(rels: string[]): void
  setActive(rel: string | null): void
  createIn(dirRel: string, kind: 'dir' | 'file'): Promise<void>
  renameRel(rel: string): Promise<void>
  trashRel(rel: string): Promise<void>
  revealRel(rel: string): Promise<void>
  expandAll(): Promise<ExpandAllResult>
  collapseAll(): void
  isAllExpanded(): boolean
  selectedRel(): string
  /** 新建 / 导入的目标目录：选中文件夹就用它，选中文稿就用它所在的文件夹 */
  targetDir(): string
}

export function createTree(host: HTMLElement, callbacks: TreeCallbacks): TreeHandle {
  const nodes = new Map<string, NodeRecord>()
  const expanded = new Set<string>()
  let rootList: HTMLElement | null = null
  let activeRel: string | null = null
  let selectedRel: string | null = null
  /** 多选（Ctrl / Shift 点选）的文稿，用于合并 */
  const multiSelected = new Set<string>()
  let contextMenu: HTMLElement | null = null
  let dragState: DragState | null = null
  let dragRaf: number | null = null
  let pendingRefresh: string[] | null = null
  let suppressClickUntil = 0

  function closeContextMenu(): void {
    contextMenu?.remove()
    contextMenu = null
  }

  function reportError(error: unknown): void {
    callbacks.onError(error instanceof Error ? error.message : String(error))
  }

  function parentOf(rel: string): string {
    const index = rel.lastIndexOf('/')
    return index === -1 ? '' : rel.slice(0, index)
  }

  function isInside(candidate: string, ancestor: string): boolean {
    return candidate === ancestor || candidate.startsWith(`${ancestor}/`)
  }

  function notifyChanged(): void {
    callbacks.onTreeChanged?.()
  }

  function setSelected(rel: string | null): void {
    selectedRel = rel
    for (const [key, record] of nodes) {
      record.row.classList.toggle('selected', key === rel)
    }
  }

  function updateMultiClasses(): void {
    for (const [key, record] of nodes) {
      record.row.classList.toggle('multi', multiSelected.has(key))
    }
  }

  /** 当前可见行的 rel，按列表里的先后顺序 */
  function visibleRels(): string[] {
    return [...host.querySelectorAll('.row')]
      .filter((row) => (row as HTMLElement).offsetParent !== null)
      .map((row) => row.getAttribute('data-rel') ?? '')
      .filter((rel) => rel.length > 0)
  }

  /**
   * 选中的文稿，**按点选的先后顺序**。
   *
   * 刻意不用列表顺序：中文排序下「第二章」会排在「第一章」前面，
   * 合并出来的文件名和内容顺序会跟直觉相反。
   * 按点选顺序，用户想怎么拼就怎么点（框选一段时顺序就是从上到下）。
   */
  function selectedFilesInOrder(): string[] {
    return [...multiSelected].filter((rel) => nodes.get(rel)?.entry.kind === 'file')
  }

  function toggleMulti(rel: string): void {
    if (multiSelected.has(rel)) multiSelected.delete(rel)
    else multiSelected.add(rel)
    setSelected(rel)
    updateMultiClasses()
  }

  function selectRange(rel: string): void {
    const order = visibleRels()
    const anchor = order.indexOf(selectedRel ?? rel)
    const target = order.indexOf(rel)
    if (anchor === -1 || target === -1) return
    const [from, to] = anchor < target ? [anchor, target] : [target, anchor]
    for (let index = from; index <= to; index += 1) {
      const item = order[index]
      if (item && nodes.get(item)?.entry.kind === 'file') multiSelected.add(item)
    }
    setSelected(rel)
    updateMultiClasses()
  }

  function markActive(): void {
    for (const [key, record] of nodes) {
      const isActive = key === activeRel
      record.row.classList.toggle('active', isActive)
      if (isActive && !record.row.classList.contains('selected')) {
        record.row.classList.add('selected')
      }
    }
    // 重建 DOM 之后要把多选高亮补回来
    updateMultiClasses()
  }

  async function listDir(rel: string): Promise<DirEntry[]> {
    return must(await api.listDir(rel))
  }

  async function loadChildren(rel: string, container: HTMLElement): Promise<void> {
    const entries = await listDir(rel)
    clear(container)
    for (const entry of entries) {
      container.append(buildNode(entry))
    }
  }

  async function ensureChildrenLoaded(record: NodeRecord): Promise<void> {
    if (!record.childHost || record.loaded) return
    try {
      await loadChildren(record.entry.rel, record.childHost)
      record.loaded = true
    } catch (error) {
      reportError(error)
    }
  }

  async function setExpanded(record: NodeRecord, next: boolean): Promise<void> {
    if (record.entry.kind !== 'dir') return
    const rel = record.entry.rel
    if (next) {
      expanded.add(rel)
      record.li.classList.add('expanded')
      await ensureChildrenLoaded(record)
    } else {
      expanded.delete(rel)
      record.li.classList.remove('expanded')
    }
    notifyChanged()
  }

  async function toggle(record: NodeRecord): Promise<void> {
    await setExpanded(record, !expanded.has(record.entry.rel))
  }

  /* ------------------------------ 右键菜单 ------------------------------ */

  function openMenu(items: Array<{ label: string; run: () => void } | 'separator'>, x: number, y: number): void {
    closeContextMenu()
    const menu = el('div', { class: 'context-menu' })
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
            closeContextMenu()
            item.run()
          }
        })
      )
    }
    document.body.append(menu)
    const rect = menu.getBoundingClientRect()
    menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`
    menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`
    contextMenu = menu
  }

  function buildContextMenu(entry: DirEntry, x: number, y: number): void {
    if (entry.kind === 'dir') {
      openMenu(
        [
          { label: '在此新建文稿', run: () => void createIn(entry.rel, 'file') },
          { label: '在此新建文件夹', run: () => void createIn(entry.rel, 'dir') },
          {
            label: '导入 Markdown 文件…',
            run: () => callbacks.onImportRequest?.(entry.rel)
          },
          'separator',
          { label: '重命名', run: () => void renameRel(entry.rel) },
          { label: '删除（移到回收站）', run: () => void trashRel(entry.rel) },
          'separator',
          { label: '在资源管理器中显示', run: () => void revealRel(entry.rel) },
          { label: '复制相对路径', run: () => void api.writeClipboard(entry.rel) }
        ],
        x,
        y
      )
      return
    }
    openMenu(
      [
        ...(multiSelected.size >= 2 && multiSelected.has(entry.rel)
          ? ([
              {
                label: `合并选中的 ${selectedFilesInOrder().length} 个文稿…`,
                run: () => callbacks.onMergeRequest?.(selectedFilesInOrder())
              },
              {
                label: `把选中的 ${selectedFilesInOrder().length} 篇导出为一份 PDF…`,
                run: () => callbacks.onExportMergeRequest?.(selectedFilesInOrder())
              },
              'separator' as const
            ] as const)
          : []),
        { label: '重命名', run: () => void renameRel(entry.rel) },
        { label: '删除（移到回收站）', run: () => void trashRel(entry.rel) },
        'separator',
        { label: '在资源管理器中显示', run: () => void revealRel(entry.rel) },
        { label: '复制相对路径', run: () => void api.writeClipboard(entry.rel) }
      ],
      x,
      y
    )
  }

  /* ------------------------------ 拖拽 ------------------------------ */

  function isValidTarget(dirRel: string): boolean {
    if (!dragState) return false
    const source = dragState.sourceRel
    if (dirRel === source) return false
    // 不能拖进自己的子目录
    if (dirRel.startsWith(`${source}/`)) return false
    // 已经在里面了，不用动
    if (parentOf(source) === dirRel) return false
    return true
  }

  function clearDropHighlights(): void {
    for (const record of nodes.values()) record.row.classList.remove('drop-inside')
    host.classList.remove('drop-root')
  }

  function clearSpringOpen(): void {
    if (dragState) {
      dragState.springRel = null
      dragState.springAt = 0
    }
  }

  function startRay(): void {
    if (dragRaf !== null) return
    const step = (): void => {
      dragRaf = null
      if (!dragState?.started) return
      moveGhost()
      autoScroll()
      // 落点判定放在这里跑，避免指针移动事件的节流把它整个跳过去
      updateDropTarget()
      dragRaf = requestAnimationFrame(step)
    }
    dragRaf = requestAnimationFrame(step)
  }

  function moveGhost(): void {
    const state = dragState
    if (!state?.ghost) return
    const x = Math.round(state.lastX - state.offsetX)
    const y = Math.round(state.lastY - state.offsetY)
    state.ghost.style.transform = `translate3d(${x}px, ${y}px, 0)`
  }

  function autoScroll(): void {
    const state = dragState
    if (!state) return
    const rect = host.getBoundingClientRect()
    const y = state.lastY
    if (y < rect.top + AUTO_SCROLL_ZONE) {
      host.scrollTop -= Math.max(3, (rect.top + AUTO_SCROLL_ZONE - y) / 3)
    } else if (y > rect.bottom - AUTO_SCROLL_ZONE) {
      host.scrollTop += Math.max(3, (y - (rect.bottom - AUTO_SCROLL_ZONE)) / 3)
    }
  }

  /**
   * 找出坐标落在哪一行。
   *
   * 不用 document.elementFromPoint：它会被拖拽卡片、浮层这些元素干扰，
   * 而且依赖 pointer-events 的继承行为，容易踩坑。
   * 直接比矩形最稳，反正可见的行也就几十个。
   */
  function rowUnderPoint(x: number, y: number): HTMLElement | null {
    for (const record of nodes.values()) {
      const rect = record.row.getBoundingClientRect()
      if (rect.height === 0) continue
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return record.row
      }
    }
    return null
  }

  function updateDropTarget(): void {
    const state = dragState
    if (!state) return
    // 命中测试有点开销（要读几十个矩形），限制一下频率
    const now = performance.now()
    if (now - state.lastHitTestAt < 40) return
    state.lastHitTestAt = now

    clearDropHighlights()
    const rowEl = rowUnderPoint(state.lastX, state.lastY)
    const hostRect = host.getBoundingClientRect()
    const overHost =
      state.lastX >= hostRect.left &&
      state.lastX <= hostRect.right &&
      state.lastY >= hostRect.top &&
      state.lastY <= hostRect.bottom

    let target: string | null = null
    let springRel: string | null = null

    if (rowEl) {
      const rel = rowEl.getAttribute('data-rel') ?? ''
      const kind = rowEl.getAttribute('data-kind')
      if (kind === 'dir' && isValidTarget(rel)) {
        target = rel
        rowEl.classList.add('drop-inside')
        if (!expanded.has(rel)) springRel = rel
      } else if (kind === 'file' && isValidTarget(parentOf(rel))) {
        // 拖到文稿上 = 放进它所在的文件夹
        target = parentOf(rel)
        host.classList.add('drop-root')
      }
    } else if (overHost && isValidTarget('')) {
      target = ''
      host.classList.add('drop-root')
    }

    state.targetDir = target
    if (springRel) {
      if (state.springRel !== springRel) {
        state.springRel = springRel
        state.springAt = now
      }
    } else {
      clearSpringOpen()
    }
    runSpringOpen()
  }

  function runSpringOpen(): void {
    const state = dragState
    if (!state?.springRel || !state.springAt) return
    if (performance.now() - state.springAt < SPRING_OPEN_DELAY) return
    const record = nodes.get(state.springRel)
    const rel = state.springRel
    clearSpringOpen()
    if (record) void setExpanded(record, true)
    // 展开后原来的高亮节点可能已经重建，重新做一次命中
    const still = nodes.get(rel)
    if (still) still.row.classList.add('drop-inside')
  }

  function beginDragVisual(): void {
    const state = dragState
    if (!state) return
    const rect = state.sourceRow.getBoundingClientRect()
    const ghost = el('div', { class: 'drag-ghost' })
    const card = state.sourceRow.cloneNode(true) as HTMLElement
    card.classList.remove('active', 'selected', 'dragging-source')
    card.classList.add('drag-ghost-card')
    ghost.style.width = `${rect.width}px`
    ghost.append(card)
    document.body.append(ghost)
    state.ghost = ghost
    state.started = true
    state.sourceRow.classList.add('dragging-source')
    document.body.classList.add('tree-dragging')
    moveGhost()
    startRay()
  }

  function endDrag(cancelled: boolean): void {
    const state = dragState
    if (!state) return
    dragState = null
    if (dragRaf !== null) {
      cancelAnimationFrame(dragRaf)
      dragRaf = null
    }
    state.ghost?.remove()
    state.sourceRow.classList.remove('dragging-source')
    document.body.classList.remove('tree-dragging')
    clearDropHighlights()
    clearSpringOpen()
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerCancel)
    window.removeEventListener('keydown', onDragKey, true)

    if (!cancelled && state.started && state.targetDir !== null) {
      suppressClickUntil = Date.now() + 300
      void moveRel(state.sourceRel, state.targetDir)
    } else if (!state.started) {
      // 没真正拖起来，交给 click 正常处理
    }

    if (pendingRefresh) {
      const rels = pendingRefresh
      pendingRefresh = null
      void refresh(rels)
    }
  }

  function onPointerMove(event: PointerEvent): void {
    const state = dragState
    if (!state || event.pointerId !== state.pointerId) return
    state.lastX = event.clientX
    state.lastY = event.clientY
    if (!state.started) {
      const dx = Math.abs(event.clientX - state.startX)
      const dy = Math.abs(event.clientY - state.startY)
      if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return
      beginDragVisual()
    }
    event.preventDefault()
    updateDropTarget()
  }

  function onPointerUp(event: PointerEvent): void {
    if (!dragState || event.pointerId !== dragState.pointerId) return
    endDrag(false)
  }

  function onPointerCancel(): void {
    endDrag(true)
  }

  function onDragKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      endDrag(true)
    }
  }

  function beginRowDrag(event: PointerEvent, entry: DirEntry, row: HTMLElement): void {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).classList.contains('twisty')) return
    const rect = row.getBoundingClientRect()
    dragState = {
      sourceRel: entry.rel,
      sourceRow: row,
      ghost: null,
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      started: false,
      targetDir: null,
      springRel: null,
      springAt: 0,
      lastHitTestAt: 0
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    window.addEventListener('keydown', onDragKey, true)
  }

  async function moveRel(sourceRel: string, targetDirRel: string): Promise<void> {
    try {
      const moved = must(await api.moveEntry(sourceRel, targetDirRel))
      if (isInside(activeRel ?? '\u0000', sourceRel)) {
        callbacks.onRenamed(sourceRel, moved.rel)
      }
      const targetRecord = nodes.get(targetDirRel)
      if (targetRecord) {
        targetRecord.loaded = false
        await setExpanded(targetRecord, true)
      }
      await refresh([parentOf(sourceRel), targetDirRel])
    } catch (error) {
      reportError(error)
    }
  }

  /* ------------------------------ 建节点 ------------------------------ */

  function buildNode(entry: DirEntry): HTMLElement {
    const nameEl = el('span', { class: 'name', text: displayName(entry) })
    const row = el(
      'div',
      {
        class: `row ${entry.kind === 'dir' ? 'dir' : 'file'}`,
        'data-rel': entry.rel,
        'data-kind': entry.kind,
        tabindex: '0',
        title: entry.rel
      },
      [el('span', { class: 'twisty', text: entry.kind === 'dir' ? '▸' : '' }), nameEl, el('span', { class: 'dirty-dot', hidden: true })]
    )

    const li = el('li', { class: 'tree-node' }, [row])
    const record: NodeRecord = { li, row, childHost: null, entry, loaded: false }
    nodes.set(entry.rel, record)

    if (entry.kind === 'dir') {
      const childHost = el('ul', { class: 'tree-children' })
      li.append(childHost)
      record.childHost = childHost
      if (expanded.has(entry.rel)) {
        li.classList.add('expanded')
        void ensureChildrenLoaded(record)
      }
    }

    row.addEventListener('click', (event) => {
      if (Date.now() < suppressClickUntil) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if ((event.target as HTMLElement).classList.contains('renaming')) return
      // Ctrl / Shift 点选 = 多选（只对文稿生效，文件夹上不参与合并）
      if ((event.ctrlKey || event.metaKey) && entry.kind === 'file') {
        event.preventDefault()
        toggleMulti(entry.rel)
        return
      }
      if (event.shiftKey && entry.kind === 'file') {
        event.preventDefault()
        selectRange(entry.rel)
        return
      }
      multiSelected.clear()
      updateMultiClasses()
      setSelected(entry.rel)
      if (entry.kind === 'dir') {
        void toggle(record)
      } else {
        callbacks.onOpenFile(entry.rel)
      }
    })

    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      setSelected(entry.rel)
      buildContextMenu(entry, event.clientX, event.clientY)
    })

    row.addEventListener('pointerdown', (event) => {
      beginRowDrag(event, entry, row)
    })

    // 键盘操作：F2 重命名、Delete 删除、Enter 打开/展开。只在树上生效，不干扰正文输入。
    row.addEventListener('keydown', (event) => {
      if (event.key === 'F2') {
        event.preventDefault()
        void renameRel(entry.rel)
      } else if (event.key === 'Delete') {
        event.preventDefault()
        void trashRel(entry.rel)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        setSelected(entry.rel)
        if (entry.kind === 'dir') void toggle(record)
        else callbacks.onOpenFile(entry.rel)
      }
    })

    return li
  }

  async function renderTree(): Promise<void> {
    nodes.clear()
    clear(host)
    rootList = el('ul', { class: 'tree-root' })
    host.append(rootList)
    try {
      await loadChildren('', rootList)
    } catch (error) {
      reportError(error)
    }
    markActive()
    notifyChanged()
  }

  async function refresh(rels: string[]): Promise<void> {
    // 拖拽过程中重建 DOM 会打断拖拽，先记下来，等拖完再刷新
    if (dragState?.started) {
      pendingRefresh = [...(pendingRefresh ?? []), ...rels]
      return
    }
    const unique = [...new Set(rels)]
    for (const rel of unique) {
      if (rel === '') {
        if (rootList) {
          try {
            await loadChildren('', rootList)
          } catch (error) {
            reportError(error)
          }
        }
        continue
      }
      const record = nodes.get(rel)
      if (!record || record.entry.kind !== 'dir' || !record.loaded || !record.childHost) continue
      try {
        await loadChildren(rel, record.childHost)
      } catch (error) {
        reportError(error)
      }
    }
    markActive()
    notifyChanged()
  }

  async function createIn(dirRel: string, kind: 'dir' | 'file'): Promise<void> {
    const name = await promptText({
      title: kind === 'dir' ? '新建文件夹' : '新建文稿',
      label: kind === 'dir' ? '文件夹名称' : '文稿名称（不写后缀会自动加 .md）',
      placeholder: kind === 'dir' ? '例如：第一卷' : '例如：第一章'
    })
    if (name === null || !name.trim()) return
    try {
      const created = must(await api.createEntry(dirRel, name.trim(), kind))
      const parentRecord = dirRel === '' ? null : nodes.get(dirRel)
      if (parentRecord) {
        parentRecord.loaded = false
        await setExpanded(parentRecord, true)
      }
      await refresh([dirRel])
      if (created.kind === 'file') callbacks.onOpenFile(created.rel)
      setSelected(created.rel)
      notifyChanged()
    } catch (error) {
      reportError(error)
    }
  }

  async function renameRel(rel: string): Promise<void> {
    const record = nodes.get(rel)
    if (!record || rel === '') return
    const currentName = record.entry.name
    const currentDisplay = displayName(record.entry)
    const input = el('input', { class: 'rename-input', type: 'text', value: currentDisplay })
    const nameEl = record.row.querySelector('.name')
    if (!nameEl) return
    nameEl.replaceWith(input)
    input.focus()
    input.select()

    const restore = (): void => {
      const label = el('span', { class: 'name', text: currentDisplay })
      input.replaceWith(label)
    }

    // 一次改名只提交一次：Enter 提交后输入框会被移除，这又会触发 blur，
    // 不拦一下就会拿着旧文件名再改一次，报一个莫名其妙的 ENOENT
    let finished = false
    const commit = async (): Promise<void> => {
      if (finished) return
      const typed = input.value.trim()
      if (!typed || typed === currentDisplay) {
        finished = true
        restore()
        return
      }
      finished = true
      // 树上不显示后缀，所以这里要把后缀补回去；
      // 用户自己写了后缀就用他写的，避免出现「第01章.md.md」
      const next =
        record.entry.kind === 'file' && !TEXT_EXTENSION.test(typed)
          ? `${typed}${extensionOf(currentName)}`
          : typed
      try {
        const renamed = must(await api.renameEntry(rel, next))
        const parent = parentOf(rel)
        if (isInside(activeRel ?? '\u0000', rel)) {
          callbacks.onRenamed(rel, renamed.rel)
        }
        nodes.delete(rel)
        await refresh([parent])
        setSelected(renamed.rel)
      } catch (error) {
        // 失败了允许重来（比如名字冲突，用户改了再提一次）
        finished = false
        restore()
        reportError(error)
      }
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        void commit()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        restore()
      }
      event.stopPropagation()
    })
    input.addEventListener('blur', () => {
      void commit()
    })
  }

  async function trashRel(rel: string): Promise<void> {
    if (rel === '') return
    const record = nodes.get(rel)
    const isDir = record?.entry.kind === 'dir'
    const confirmed = must(
      await api.confirm({
        title: '删除',
        message: `确定删除「${rel}」吗？`,
        detail: isDir
          ? '整个文件夹会被移到文档库里的 .mobiwriter/trash 目录，不会真正删除，随时可以从磁盘上找回来。'
          : '文件会被移到文档库里的 .mobiwriter/trash 目录，不会真正删除。',
        confirmLabel: '移到回收站',
        cancelLabel: '取消',
        danger: true
      })
    )
    if (!confirmed) return
    try {
      must(await api.trashEntry(rel))
      if (isInside(activeRel ?? '\u0000', rel)) callbacks.onRemoved(rel)
      nodes.delete(rel)
      await refresh([parentOf(rel)])
      setSelected(null)
    } catch (error) {
      reportError(error)
    }
  }

  async function revealRel(rel: string): Promise<void> {
    try {
      must(await api.revealEntry(rel))
    } catch (error) {
      reportError(error)
    }
  }

  /** 逐个文件夹地展开，直到全部展开或撞到上限 */
  async function expandAll(): Promise<ExpandAllResult> {
    let count = 0
    const queue: string[] = []
    for (const [key, record] of nodes) {
      if (record.entry.kind === 'dir' && parentOf(key) === '') queue.push(key)
    }
    while (queue.length > 0) {
      const rel = queue.shift() as string
      const record = nodes.get(rel)
      if (!record || record.entry.kind !== 'dir') continue
      if (!record.loaded) await ensureChildrenLoaded(record)
      expanded.add(rel)
      record.li.classList.add('expanded')
      count += 1
      if (count >= EXPAND_ALL_LIMIT) {
        notifyChanged()
        return { dirs: count, truncated: true }
      }
      for (const [key, child] of [...nodes]) {
        if (child.entry.kind === 'dir' && parentOf(key) === rel) queue.push(key)
      }
    }
    notifyChanged()
    return { dirs: count, truncated: false }
  }

  function collapseAll(): void {
    for (const record of nodes.values()) {
      if (record.entry.kind !== 'dir') continue
      record.li.classList.remove('expanded')
    }
    expanded.clear()
    notifyChanged()
  }

  function isAllExpanded(): boolean {
    for (const record of nodes.values()) {
      if (record.entry.kind !== 'dir') continue
      if (!expanded.has(record.entry.rel)) return false
    }
    return true
  }

  document.addEventListener('click', (event) => {
    if (contextMenu && !contextMenu.contains(event.target as Node)) closeContextMenu()
  })
  window.addEventListener('blur', closeContextMenu)

  host.addEventListener('contextmenu', (event) => {
    if (event.target !== host && (event.target as HTMLElement).closest('.row')) return
    event.preventDefault()
    const dir = selectedRel && nodes.get(selectedRel)?.entry.kind === 'dir' ? selectedRel : ''
    openMenu(
      [
        { label: '新建文稿', run: () => void createIn(dir, 'file') },
        { label: '新建文件夹', run: () => void createIn(dir, 'dir') },
        { label: '导入 Markdown 文件…', run: () => callbacks.onImportRequest?.(dir) }
      ],
      event.clientX,
      event.clientY
    )
  })

  return {
    setVault(root) {
      endDrag(true)
      nodes.clear()
      expanded.clear()
      activeRel = null
      selectedRel = null
      if (!root) {
        clear(host)
        rootList = null
        return
      }
      void renderTree()
    },

    refresh(rels) {
      void refresh(rels)
    },

    setActive(rel) {
      activeRel = rel
      if (rel) setSelected(rel)
      markActive()
    },

    createIn,
    renameRel,
    trashRel,
    revealRel,
    expandAll,

    collapseAll() {
      collapseAll()
    },

    isAllExpanded,

    selectedRel() {
      return selectedRel ?? activeRel ?? ''
    },

    targetDir() {
      const rel = selectedRel ?? activeRel
      if (!rel) return ''
      const record = nodes.get(rel)
      if (record?.entry.kind === 'dir') return rel
      return parentOf(rel)
    }
  }
}

export function setDirtyDot(host: HTMLElement, rel: string | null, dirty: boolean): void {
  for (const row of host.querySelectorAll('.row.file')) {
    const rowRel = row.getAttribute('data-rel')
    const dot = row.querySelector('.dirty-dot')
    if (!dot) continue
    const show = dirty && rowRel === rel
    dot.toggleAttribute('hidden', !show)
  }
}
