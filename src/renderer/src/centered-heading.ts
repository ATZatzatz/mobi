/**
 * 居中标题语法：`#@ 标题`。
 *
 * `#@` = 居中一级标题，`##@` = 居中二级标题，`###@` 以此类推（最多六级）。
 * 这是一条自定义语法，标准 Markdown 不认，所以两边都要自己处理：
 *
 * 1. 渲染（预览 + 导出 PDF）：给 markdown-it 加一条块级规则，产出带 md-center 类的标题；
 * 2. 编辑器：用行装饰让这一行在源码视图里也居中显示，并把 #@ 标记染成灰色。
 *
 * 代码块里的 `#@` 不会被误伤：编辑器只按「行首」匹配，markdown-it 的块规则也只在块级
 * 解析阶段生效，围栏代码块内部根本不会走到这条规则。
 */
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import type { MarkdownIt, StateBlock } from 'markdown-it'

/** 行首的 #@ / ##@ …（后面必须跟空白，避免把 #@abc 当成标题） */
const LINE_PATTERN = /^\s{0,3}(#{1,6}@)(?=[ \t])/
/** 整行的解析用（和上面保持一致，但要求能取到内容） */
const RULE_PATTERN = /^(#{1,6})@[ \t]+(.*?)[ \t]*$/

/* --------------------------- markdown-it 侧 --------------------------- */

function centeredHeadingRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  const pos = state.bMarks[startLine] + state.tShift[startLine]
  const max = state.eMarks[startLine]
  // 缩进 4 格以上按代码块处理，交给别的规则
  if (state.sCount[startLine] - state.blkIndent >= 4) return false

  const text = state.src.slice(pos, max)
  const match = RULE_PATTERN.exec(text)
  if (!match) return false
  if (silent) return true

  const level = (match[1] as string).length
  // 允许像标准 ATX 标题那样用结尾的 # 收尾
  const content = (match[2] as string).replace(/\s+#+\s*$/, '').trim()

  const open = state.push('heading_open', `h${level}`, 1)
  open.attrSet('class', 'md-center')
  open.map = [startLine, startLine + 1]

  const inline = state.push('inline', '', 0)
  inline.content = content
  inline.map = [startLine, startLine + 1]
  inline.children = []

  state.push('heading_close', `h${level}`, -1)
  state.line = startLine + 1
  return true
}

/** 给 markdown-it 装上居中标题支持 */
export function centeredHeading(md: MarkdownIt): void {
  md.block.ruler.before('heading', 'centered_heading', centeredHeadingRule, {
    alt: ['paragraph', 'reference', 'blockquote']
  })
}

/* --------------------------- 编辑器侧 --------------------------- */

const centeredLine = Decoration.line({ class: 'cm-centered-heading' })
const centeredMark = Decoration.mark({ class: 'cm-center-mark' })

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: Array<{ from: number; to: number; value: Decoration }> = []
  for (const { from, to } of view.visibleRanges) {
    let pos = from
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos)
      const match = LINE_PATTERN.exec(line.text)
      if (match) {
        ranges.push({ from: line.from, to: line.from, value: centeredLine })
        ranges.push({ from: line.from, to: line.from + (match[1] as string).length, value: centeredMark })
      }
      pos = line.to + 1
    }
  }
  // sort = true：行装饰和标记装饰混在一起，交给 CodeMirror 排序更稳
  return Decoration.set(
    ranges.map((r) => r.value.range(r.from, r.to)),
    true
  )
}

/** 让 `#@ 标题` 这一行在编辑器里也居中，并把标记染灰 */
export function centeredHeadingLines(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view)
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorations(update.view)
        }
      }
    },
    { decorations: (instance) => instance.decorations }
  )
}
