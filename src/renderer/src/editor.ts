/**
 * CodeMirror 6 编辑器封装。
 *
 * 为什么是 CM6 而不是自己写 contenteditable：
 * 中文输入法（IME）、撤销栈、超长文档的视口渲染，这三件事自己写几乎必翻车。
 * CM6 是目前唯一把这些都做扎实的开源内核。
 *
 * 这个文件刻意不引入任何 UI 框架，编辑器实例只有一个，
 * 切换文件时复用同一个实例（setState），避免反复创建销毁带来的内存问题。
 */
import { Compartment, EditorState } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands'
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting
} from '@codemirror/language'
import { highlightSelectionMatches, search } from '@codemirror/search'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap
} from '@codemirror/autocomplete'
import { markdown } from '@codemirror/lang-markdown'
import { tags as t } from '@lezer/highlight'
import { centeredHeadingLines } from './centered-heading'
import { paragraphIndentLines } from './indent-lines'
import { cnMarkLines } from './mark-text'
import { columnSelection } from './column-selection'
import type { ThemeName } from '@shared/types'

const lineNumberCompartment = new Compartment()
const indentCompartment = new Compartment()
const themeCompartment = new Compartment()

/** 语法配色全部走 CSS 变量，这样切主题不用重建编辑器 */
const markdownHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700', color: 'var(--md-h1, #1f2328)' },
  { tag: t.heading2, fontWeight: '700', color: 'var(--md-h2, #1f2328)' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '600', color: 'var(--md-h3, #1f2328)' },
  { tag: t.strong, fontWeight: '700', color: 'var(--md-strong, #1f2328)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--md-link, #0a58ca)', textDecoration: 'underline' },
  { tag: t.url, color: 'var(--md-link, #0a58ca)' },
  { tag: t.monospace, color: 'var(--md-code, #b03060)' },
  { tag: t.quote, color: 'var(--md-quote, #6a737d)' },
  // 注意：不要给 t.list 上色。markdown 语法把 BulletList/... 整段都标成了 list，
  // 一旦设了颜色，列表文字会整行变灰。短横线本身是 ListMark（processingInstruction），
  // 由下面那条规则负责染成灰色，文字保持正常颜色。
  { tag: [t.processingInstruction, t.contentSeparator], color: 'var(--md-marker, #6a737d)' },
  { tag: t.comment, color: 'var(--md-comment, #6a737d)' }
])

const baseTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--editor-font-size, 16px)',
    backgroundColor: 'var(--editor-bg, #ffffff)',
    color: 'var(--editor-fg, #1f2328)'
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--editor-font, inherit)',
    lineHeight: 'var(--editor-line-height, 1.85)',
    overflow: 'auto'
  },
  '.cm-content': {
    maxWidth: 'var(--editor-content-width, 720px)',
    margin: '0 auto',
    padding: '11vh 0 46vh 0',
    letterSpacing: '0.012em',
    caretColor: 'var(--editor-caret, #2f2c29)'
  },
  '.cm-line': { padding: '0 40px' },
  '.cm-gutters': {
    backgroundColor: 'var(--editor-bg, #ffffff)',
    color: 'var(--editor-gutter-fg, #b0b6bd)',
    border: 'none'
  },
  '.cm-activeLine': { backgroundColor: 'var(--editor-active-line, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--editor-active-line, transparent)' },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--editor-caret, #1f2328)',
    borderLeftWidth: '2px'
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--editor-selection, #d7e4f5)'
  },
  '.cm-panels': {
    backgroundColor: 'var(--panel-bg, #f5f6f7)',
    color: 'var(--panel-fg, #1f2328)'
  },
  '.cm-panels input, .cm-panels button, .cm-panels label': { fontFamily: 'inherit', fontSize: '13px' },
  '.cm-searchMatch': { backgroundColor: 'var(--editor-search, #ffe08a)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--editor-search-active, #ffc53d)' }
})

function themeExtensions(theme: ThemeName): Extension {
  return [baseTheme, EditorView.darkTheme.of(theme === 'dark')]
}

export interface EditorOptions {
  parent: HTMLElement
  initialDoc: string
  theme: ThemeName
  showLineNumbers: boolean
  /** 首行缩进两格 */
  paragraphIndent?: boolean
  autoFocus?: boolean
  onChange: () => void
  onSaveShortcut: () => void
  /** Ctrl+F / Ctrl+H：打开自己的查找替换栏 */
  onFindShortcut: (mode: 'find' | 'replace') => void
  onCursorMove?: (line: number, totalLines: number) => void
}

export interface EditorHandle {
  readonly view: EditorView
  setDoc(text: string, options?: { preserveSelection?: boolean; preserveScrollRatio?: number }): void
  getDoc(): string
  focus(): void
  undo(): void
  redo(): void
  setLineNumbers(show: boolean): void
  /** 首行缩进两格（只作用于正文段落） */
  setParagraphIndent(on: boolean): void
  setTheme(theme: ThemeName): void
  /** 打字机模式：光标始终停在视口偏上的固定高度 */
  setTypewriter(on: boolean): void
  /** 把光标移到指定行、选中指定区间，并滚动到视口中间（搜索跳转用） */
  revealPosition(line: number, column: number, length: number): void
  scrollRatio(): number
  setScrollRatio(ratio: number): void
  destroy(): void
}

export function createEditor(options: EditorOptions): EditorHandle {
  const {
    parent,
    initialDoc,
    theme,
    showLineNumbers,
    autoFocus = false,
    onChange,
    onSaveShortcut,
    onFindShortcut,
    onCursorMove
  } = options

  /** 打字机模式开关。放在闭包里，避免为了一个布尔值重建整个编辑器。 */
  let typewriter = false
  const TYPEWRITER_RATIO = 0.42

  /** 把光标所在行顶到视口的固定比例位置 */
  const keepCursorLine = (view: EditorView): void => {
    if (!typewriter) return
    const head = view.state.selection.main.head
    const coords = view.coordsAtPos(head)
    if (!coords) return
    const scroller = view.scrollDOM
    const box = scroller.getBoundingClientRect()
    if (box.height <= 0) return
    const target = box.top + box.height * TYPEWRITER_RATIO
    const delta = coords.top - target
    if (Math.abs(delta) > 2) scroller.scrollTop += delta
  }

  const extensions = (
    showLineNumbersInitial: boolean,
    themeInitial: ThemeName,
    indentInitial: boolean
  ): Extension[] => [
    indentCompartment.of(indentInitial ? paragraphIndentLines() : []),
    lineNumberCompartment.of(showLineNumbersInitial ? [lineNumbers(), highlightActiveLineGutter()] : []),
    themeCompartment.of(themeExtensions(themeInitial)),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(markdownHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ activateOnTyping: false }),
    // Alt + 拖拽 = 竖着选（自己的实现，垂直拖拽也能看见选区）
    columnSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    EditorView.lineWrapping,
    markdown(),
    // `#@ 标题` 在源码视图里也居中显示
    centeredHeadingLines(),
    // 【标记】的文字跟着变色
    cnMarkLines(),
    placeholder('开始写吧…'),
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => { onSaveShortcut(); return true } },
      { key: 'Mod-f', preventDefault: true, run: () => { onFindShortcut('find'); return true } },
      { key: 'Mod-h', preventDefault: true, run: () => { onFindShortcut('replace'); return true } },
      indentWithTab,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...completionKeymap
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange()
      if (update.selectionSet || update.docChanged) {
        if (onCursorMove) {
          const head = update.state.selection.main.head
          const line = update.state.doc.lineAt(head)
          onCursorMove(line.number, update.state.doc.lines)
        }
        // 打字机模式要在这一帧的布局之后才能拿到准确坐标
        requestAnimationFrame(() => keepCursorLine(update.view))
      }
    })
  ]

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: initialDoc,
      extensions: extensions(showLineNumbers, theme, options.paragraphIndent === true)
    })
  })

  if (autoFocus) view.focus()

  return {
    view,

    setDoc(text, opts) {
      const previous = view.state
      const ratio = opts?.preserveScrollRatio
      const anchor = Math.min(previous.selection.main.anchor, text.length)
      const head = Math.min(previous.selection.main.head, text.length)
      view.setState(
        EditorState.create({
          doc: text,
          selection: opts?.preserveSelection ? { anchor, head } : { anchor: 0, head: 0 },
          extensions: extensions(showLineNumbers, theme, options.paragraphIndent === true)
        })
      )
      if (ratio !== undefined) {
        // 等布局完成再恢复位置
        requestAnimationFrame(() => {
          const scroller = view.scrollDOM
          const max = scroller.scrollHeight - scroller.clientHeight
          if (max > 0) scroller.scrollTop = max * ratio
        })
      }
    },

    getDoc() {
      return view.state.doc.toString()
    },

    focus() {
      view.focus()
    },

    undo() {
      undo(view)
    },

    redo() {
      redo(view)
    },

    setParagraphIndent(on) {
      view.dispatch({ effects: indentCompartment.reconfigure(on ? paragraphIndentLines() : []) })
    },

    setLineNumbers(show) {
      view.dispatch({
        effects: lineNumberCompartment.reconfigure(show ? [lineNumbers(), highlightActiveLineGutter()] : [])
      })
    },

    setTheme(next) {
      view.dispatch({ effects: themeCompartment.reconfigure(themeExtensions(next)) })
    },

    setTypewriter(on) {
      typewriter = on
      if (on) requestAnimationFrame(() => keepCursorLine(view))
    },

    revealPosition(line, column, length) {
      const doc = view.state.doc
      const safeLine = Math.min(Math.max(1, Math.round(line)), doc.lines)
      const info = doc.line(safeLine)
      const from = info.from + Math.min(Math.max(0, column), info.length)
      const to = Math.max(from, Math.min(from + Math.max(0, length), info.to))
      view.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: 'center' })
      })
      view.focus()
    },

    scrollRatio() {
      const scroller = view.scrollDOM
      const max = scroller.scrollHeight - scroller.clientHeight
      return max <= 0 ? 0 : scroller.scrollTop / max
    },

    setScrollRatio(ratio) {
      const scroller = view.scrollDOM
      const max = scroller.scrollHeight - scroller.clientHeight
      if (max > 0) scroller.scrollTop = max * Math.min(1, Math.max(0, ratio))
    },

    destroy() {
      view.destroy()
    }
  }
}
