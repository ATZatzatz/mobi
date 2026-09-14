/**
 * 查找 / 替换栏。
 *
 * 没用 CodeMirror 自带的面板：那个面板是英文的，样式也比较老旧。
 * 这里自己画一条横栏，但底下仍然用它的搜索状态与命令
 * （SearchQuery / setSearchQuery / findNext / replaceNext / replaceAll），
 * 这样正则、全词、循环查找这些行为跟编辑器内核保持一致，不用自己重写一套匹配逻辑。
 */
import {
  SearchQuery,
  findNext,
  findPrevious,
  replaceAll,
  replaceNext,
  setSearchQuery
} from '@codemirror/search'
import type { EditorView } from '@codemirror/view'
import { el } from './dom'
import { icon } from './icons'

export type FindMode = 'find' | 'replace'

export interface FindBar {
  open(mode: FindMode): void
  close(): void
  isOpen(): boolean
  /** 切换文稿后重新把当前查询应用到新文档上 */
  refresh(): void
}

const DEBOUNCE_MS = 120
const MAX_COUNT = 999

function queryToRegExp(query: SearchQuery): RegExp | null {
  const source = query.search
  if (!source) return null
  const body = query.regexp ? source : source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = query.wholeWord ? `\\b(?:${body})\\b` : body
  try {
    return new RegExp(pattern, query.caseSensitive ? 'g' : 'gi')
  } catch {
    return null
  }
}

function countMatches(text: string, query: SearchQuery): number {
  const regexp = queryToRegExp(query)
  if (!regexp) return 0
  let count = 0
  let match: RegExpExecArray | null
  while ((match = regexp.exec(text)) !== null) {
    count += 1
    if (count >= MAX_COUNT) break
    if (match[0].length === 0) regexp.lastIndex += 1
  }
  return count
}

export interface FindBarOptions {
  /** 勾选「在列表中搜索」时，把关键词同步给左栏列表搜索 */
  onListSearch?: (query: string | null, options: { caseSensitive: boolean }) => void
}

export function createFindBar(
  host: HTMLElement,
  getView: () => EditorView | null,
  barOptions: FindBarOptions = {}
): FindBar {
  let open = false
  let timer: number | null = null
  let caseSensitive = false
  let regexp = false
  let wholeWord = false
  let inList = false

  const searchInput = el('input', {
    class: 'find-input',
    type: 'text',
    placeholder: '查找',
    spellcheck: 'false'
  })
  const replaceInput = el('input', {
    class: 'find-input',
    type: 'text',
    placeholder: '替换为',
    spellcheck: 'false'
  })
  const countEl = el('span', { class: 'find-count' })

  function currentQuery(): SearchQuery {
    return new SearchQuery({
      search: searchInput.value,
      replace: replaceInput.value,
      caseSensitive,
      regexp,
      wholeWord
    })
  }

  function updateCount(): void {
    const view = getView()
    if (!searchInput.value || !view) {
      countEl.textContent = ''
      return
    }
    const total = countMatches(view.state.doc.toString(), currentQuery())
    countEl.textContent = total === 0 ? '无结果' : total >= MAX_COUNT ? `${MAX_COUNT}+ 处` : `共 ${total} 处`
  }

  function applyQuery(options: { jump?: boolean } = {}): void {
    const view = getView()
    if (!view) return
    const query = currentQuery()
    view.dispatch({ effects: setSearchQuery.of(query) })
    updateCount()
    pushListSearch()
    if (options.jump && query.search.length > 0) findNext(view)
  }

  /** 把当前关键词同步给左栏列表搜索（没勾选就清空列表） */
  function pushListSearch(): void {
    if (!barOptions.onListSearch) return
    barOptions.onListSearch(inList ? searchInput.value : null, { caseSensitive })
  }

  function schedule(): void {
    if (timer !== null) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      applyQuery()
    }, DEBOUNCE_MS)
  }

  function button(label: string, title: string, run: () => void, className = 'find-btn'): HTMLButtonElement {
    return el('button', { class: className, type: 'button', title, text: label, onclick: run })
  }

  function iconButton(name: 'arrow-up' | 'arrow-down' | 'close', title: string, run: () => void): HTMLButtonElement {
    return el('button', { class: 'find-btn find-icon-btn', type: 'button', title, onclick: run }, [icon(name, 15)])
  }

  function toggle(label: string, title: string, isOn: () => boolean, flip: () => void): HTMLButtonElement {
    const node = el('button', {
      class: 'find-toggle',
      type: 'button',
      title,
      text: label,
      onclick: () => {
        flip()
        node.classList.toggle('active', isOn())
        applyQuery({ jump: true })
      }
    })
    return node
  }

  const prevButton = iconButton('arrow-up', '上一个（Shift+Enter）', () => {
    const view = getView()
    if (view) findPrevious(view)
  })
  const nextButton = iconButton('arrow-down', '下一个（Enter）', () => {
    const view = getView()
    if (view) findNext(view)
  })
  const caseToggle = toggle('Aa', '区分大小写', () => caseSensitive, () => {
    caseSensitive = !caseSensitive
  })
  const regexpToggle = toggle('.*', '正则表达式', () => regexp, () => {
    regexp = !regexp
  })
  const wordToggle = toggle('全词', '全词匹配', () => wholeWord, () => {
    wholeWord = !wholeWord
  })
  const listCheckbox = el('input', { type: 'checkbox' })
  listCheckbox.checked = false
  const listToggle = el('label', { class: 'find-list-toggle', title: '勾选后，搜索的同时在左栏文件列表里筛出包含该文字的文稿' }, [
    listCheckbox,
    el('span', { text: '在列表中搜索' })
  ])
  listCheckbox.addEventListener('change', () => {
    inList = listCheckbox.checked
    pushListSearch()
  })

  const clearButton = iconButton('close', '清空关键词', () => {
    searchInput.value = ''
    replaceInput.value = ''
    applyQuery()
    searchInput.focus()
  })

  const findRow = el('div', { class: 'find-row' }, [
    searchInput,
    countEl,
    prevButton,
    nextButton,
    caseToggle,
    regexpToggle,
    wordToggle,
    listToggle,
    clearButton
  ])

  const replaceRow = el('div', { class: 'find-row find-replace-row', hidden: true }, [
    replaceInput,
    button('替换', '替换当前匹配', () => {
      const view = getView()
      if (!view) return
      replaceNext(view)
      applyQuery()
    }),
    button('全部替换', '替换文档里的全部匹配', () => {
      const view = getView()
      if (!view) return
      replaceAll(view)
      applyQuery()
    })
  ])

  // 查找栏现在常驻在右栏的「工具」页里（由标签页控制显隐），自己不隐藏
  const bar = el('div', { class: 'find-bar' }, [findRow, replaceRow])
  host.append(bar)

  searchInput.addEventListener('input', schedule)
  replaceInput.addEventListener('input', () => {
    // 只更新替换文本，不跳转
    const view = getView()
    if (view) view.dispatch({ effects: setSearchQuery.of(currentQuery()) })
  })
  for (const input of [searchInput, replaceInput]) {
    input.addEventListener('keydown', (event) => {
      // 焦点已经在查找框里时，Ctrl+F / Ctrl+H 也要能用
      // （菜单加速器虽然也会触发，但这里兜一层，快捷键才不至于看焦点脸色）
      if ((event.ctrlKey || event.metaKey) && (event.key === 'h' || event.key === 'H')) {
        event.preventDefault()
        replaceRow.hidden = false
        replaceInput.focus()
        replaceInput.select()
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        const view = getView()
        if (!view) return
        if (event.shiftKey) findPrevious(view)
        else findNext(view)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
      event.stopPropagation()
    })
  }

  function close(): void {
    if (!open) return
    open = false
    barOptions.onListSearch?.(null, { caseSensitive })
    getView()?.focus()
  }

  return {
    open(mode) {
      open = true
      replaceRow.hidden = mode !== 'replace'
      const target = mode === 'replace' ? replaceInput : searchInput
      target.focus()
      target.select()
      // 打开时把当前查询同步到文档上，命中的地方会立刻高亮
      applyQuery()
    },

    close,

    isOpen() {
      return open
    },

    refresh() {
      if (open) applyQuery()
    }
  }
}
