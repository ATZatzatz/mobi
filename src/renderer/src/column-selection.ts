/**
 * 竖着选（矩形 / 列选择）。
 *
 * 为什么不用 CodeMirror 自带的 rectangularSelection：
 * 它在「垂直正下方」拖拽时每一行的列跨度是 0，
 * 算出来的是每行一个光标（多光标），屏幕上不显示任何高亮，
 * 用户按住 Alt 往下拖会觉得「完全没反应」。
 *
 * 这里自己实现一份 mouseSelectionStyle：列跨度为 0 时自动向右扩一个字，
 * 保证无论往哪个方向拖，都能看到一块实实在在的选区。
 */
import { EditorSelection } from '@codemirror/state'
import type { EditorState, Extension, SelectionRange } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { MouseSelectionStyle, ViewUpdate } from '@codemirror/view'

interface ColumnPos {
  line: number
  col: number
}

function posAt(view: EditorView, event: MouseEvent): ColumnPos | null {
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
  if (pos === null) return null
  const line = view.state.doc.lineAt(pos)
  return { line: line.number, col: pos - line.from }
}

function rangesFor(state: EditorState, a: ColumnPos, b: ColumnPos): SelectionRange[] {
  const first = Math.min(a.line, b.line)
  const last = Math.max(a.line, b.line)
  const startCol = Math.min(a.col, b.col)
  let endCol = Math.max(a.col, b.col)
  // 关键：垂直拖拽时跨度是 0，向右扩一个字，否则什么都看不见
  if (startCol === endCol) endCol = startCol + 1

  const ranges: SelectionRange[] = []
  for (let n = first; n <= last; n += 1) {
    const line = state.doc.line(n)
    if (line.length <= startCol) {
      ranges.push(EditorSelection.cursor(line.to))
      continue
    }
    const from = line.from + startCol
    const to = line.from + Math.min(endCol, line.length)
    // 短行取不到内容时退化成行尾光标，和 CodeMirror 自带行为一致
    ranges.push(to > from ? EditorSelection.range(from, to) : EditorSelection.cursor(line.to))
  }
  return ranges
}

class ColumnSelectionStyle implements MouseSelectionStyle {
  private anchor: ColumnPos
  private base: EditorSelection

  constructor(
    private readonly view: EditorView,
    base: EditorSelection,
    anchor: ColumnPos
  ) {
    this.base = base
    this.anchor = anchor
  }

  update(update: ViewUpdate): void {
    if (!update.docChanged) return
    const line = update.startState.doc.line(this.anchor.line)
    const mapped = update.changes.mapPos(line.from)
    const next = update.state.doc.lineAt(mapped)
    this.anchor = { line: next.number, col: Math.min(this.anchor.col, next.length) }
    this.base = this.base.map(update.changes)
  }

  get(event: MouseEvent, _extend: boolean, multiple: boolean): EditorSelection {
    const current = posAt(this.view, event)
    if (!current) return this.base
    const ranges = rangesFor(this.view.state, this.anchor, current)
    if (ranges.length === 0) return this.base
    return EditorSelection.create(multiple ? ranges.concat(this.base.ranges) : ranges, 0)
  }
}

/** Alt（macOS 上还支持 Cmd）+ 左键拖拽 = 列选择 */
export function columnSelection(): Extension {
  return EditorView.mouseSelectionStyle.of((view, event) => {
    const modifier = event.altKey || (navigator.platform.startsWith('Mac') && event.metaKey)
    if (!modifier || event.button !== 0) return null
    const anchor = posAt(view, event)
    if (!anchor) return null
    return new ColumnSelectionStyle(view, view.state.selection, anchor)
  })
}
