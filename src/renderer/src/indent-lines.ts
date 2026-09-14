/**
 * 编辑区里的「首行缩进」。
 *
 * 只给正文段落加缩进，标题、列表、引用、代码、表格这些不加 —— 否则 "- 列表项"
 * 也会跟着缩，看起来像格式错乱。
 * 代码块是用缩进或围栏写的，也一并排除。
 */
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

const indentLine = Decoration.line({ class: 'cm-indent-line' })

/** 看起来不是正文段落的行：标题 / 引用 / 列表 / 围栏 / 表格 / 缩进代码 */
const NOT_PARAGRAPH = /^\s*(#{1,6}\s|@|>|[-*+]\s|\d+[.)]\s|```|~~~|\||\s{4})/

function isParagraph(text: string): boolean {
  if (text.trim().length === 0) return false
  return !NOT_PARAGRAPH.test(text)
}

function build(view: EditorView): DecorationSet {
  const ranges: Array<{ from: number; to: number }> = []
  for (const { from, to } of view.visibleRanges) {
    let pos = from
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos)
      if (isParagraph(line.text)) ranges.push({ from: line.from, to: line.from })
      pos = line.to + 1
    }
  }
  return Decoration.set(
    ranges.map((r) => indentLine.range(r.from, r.to)),
    true
  )
}

export function paragraphIndentLines(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = build(view)
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = build(update.view)
        }
      }
    },
    { decorations: (instance) => instance.decorations }
  )
}
