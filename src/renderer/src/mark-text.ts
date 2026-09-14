/**
 * `【文字】` 标记语法：被方括号框起来的文字用指定颜色显示。
 *
 * 两边都要处理，和居中标题一个套路：
 * - markdown-it：产出 <span class="md-mark">，颜色走 CSS 变量
 * - CodeMirror 的 mark 装饰：源码视图里这些字也跟着变色，一眼能看出哪里标了
 *
 * 注意实现方式：**不能用 inline 规则**。markdown-it 的 text 规则会把整段普通文字
 * 一次吞掉，而 `【` 不在它的默认终止字符表里，inline 规则根本没机会被调用。
 * 所以在 inline 解析完成后，对 token 流做一次后处理，把含【】的文本 token 拆开。
 */
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import type { EditorState, Extension } from '@codemirror/state'
import type { MarkdownIt } from 'markdown-it'

/** 行内匹配：不跨行，长度限制一下避免误吃超长文本 */
const INLINE_PATTERN = /【[^】\n]{1,120}】/g
const SPLIT_PATTERN = /(【[^】\n]{1,120}】)/g
const WHOLE_PATTERN = /^【([^】\n]{1,120})】$/

/** 给 markdown-it 装上【】标记 */
export function cnMark(md: MarkdownIt): void {
  md.core.ruler.after('inline', 'cn_mark', (state) => {
    for (const token of state.tokens) {
      if (token.type !== 'inline' || !token.children) continue
      const children = token.children
      const next: typeof children = []
      for (const child of children) {
        if (child.type !== 'text' || !child.content.includes('【')) {
          next.push(child)
          continue
        }
        for (const part of child.content.split(SPLIT_PATTERN)) {
          if (!part) continue
          const matched = WHOLE_PATTERN.exec(part)
          if (matched) {
            const open = new state.Token('cn_mark_open', 'span', 1)
            open.attrSet('class', 'md-mark')
            next.push(open)
            const text = new state.Token('text', '', 0)
            text.content = matched[1] as string
            next.push(text)
            next.push(new state.Token('cn_mark_close', 'span', -1))
          } else {
            const text = new state.Token('text', '', 0)
            text.content = part
            next.push(text)
          }
        }
      }
      token.children = next
    }
    return true
  })
}

/* --------------------------- 编辑器侧 --------------------------- */

const markDeco = Decoration.mark({ class: 'cm-md-mark' })

function buildDecorations(state: EditorState, from: number, to: number): DecorationSet {
  const ranges: Array<{ from: number; to: number }> = []
  let pos = from
  while (pos <= to) {
    const line = state.doc.lineAt(pos)
    INLINE_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = INLINE_PATTERN.exec(line.text)) !== null) {
      // 只给方括号里面的文字上色，括号本身留作普通标记
      ranges.push({ from: line.from + match.index + 1, to: line.from + match.index + match[0].length - 1 })
    }
    pos = line.to + 1
  }
  return Decoration.set(
    ranges.map((r) => markDeco.range(r.from, r.to)),
    true
  )
}

/** 源码视图里让【】里的文字变色 */
export function cnMarkLines(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view.state, view.viewport.from, view.viewport.to)
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorations(update.state, update.view.viewport.from, update.view.viewport.to)
        }
      }
    },
    { decorations: (instance) => instance.decorations }
  )
}
