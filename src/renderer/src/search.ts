/**
 * 文件列表里的搜索结果。
 *
 * 这里没有输入框——搜索的输入统一放在查找替换栏里（那个「在列表中搜索」勾选项），
 * 避免出现两个搜索框互相打架。本模块只负责：
 *   1. 显示「搜索中……」状态
 *   2. 把命中的文稿和命中行渲染到左栏
 *   3. 清空后把文件树放回来
 *
 * 替换永远只作用于当前打开的那篇文稿（在 find-bar / main.ts 里处理），
 * 这里从头到尾只做「看」，不碰任何文稿内容。
 */
import { api } from './api'
import { el } from './dom'
import { escapeHtml } from './preview'
import type { SearchHit } from '@shared/types'

export interface ListSearchTarget {
  rel: string
  line?: number
  column?: number
  length?: number
}

export interface ListSearchOptions {
  resultsHost: HTMLElement
  treeHost: HTMLElement
  onOpen: (target: ListSearchTarget) => void
  onError: (message: string) => void
}

export interface ListSearch {
  /** 传 null 表示清空、恢复文件树 */
  search(query: string | null, options?: { caseSensitive?: boolean }): void
  clear(): void
}

/** 「搜索中……」至少显示这么久，否则一瞬间就没了，用户根本看不见 */
const MIN_BUSY_MS = 260

function highlight(text: string, query: string, caseSensitive: boolean): string {
  const escaped = escapeHtml(text)
  if (!query) return escaped
  const safe = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    return escaped.replace(new RegExp(safe, caseSensitive ? 'g' : 'gi'), (match) => `<mark>${match}</mark>`)
  } catch {
    return escaped
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function createListSearch(options: ListSearchOptions): ListSearch {
  let seq = 0
  let active = false

  function showResults(show: boolean): void {
    active = show
    options.treeHost.hidden = show
    options.resultsHost.hidden = !show
  }

  function addTarget(button: HTMLButtonElement, target: ListSearchTarget): void {
    button.addEventListener('click', () => options.onOpen(target))
  }

  function renderHit(hit: SearchHit, query: string, caseSensitive: boolean): HTMLElement {
    const box = el('div', { class: 'sidebar-hit' })
    const head = el('button', { class: 'sidebar-hit-head', type: 'button', title: hit.rel })
    head.innerHTML = `<span class="sidebar-hit-path">${highlight(hit.rel, query, caseSensitive)}</span>`
    if (hit.kind === 'name') head.append(el('span', { class: 'sidebar-hit-tag', text: '名' }))
    addTarget(
      head,
      hit.lines[0]
        ? { rel: hit.rel, line: hit.lines[0].line, column: hit.lines[0].column, length: query.length }
        : { rel: hit.rel }
    )
    box.append(head)

    for (const line of hit.lines) {
      const lineButton = el('button', { class: 'sidebar-hit-line', type: 'button' })
      lineButton.append(
        el('span', { class: 'sidebar-hit-no', text: String(line.line) }),
        el('span', { class: 'sidebar-hit-text' })
      )
      const textEl = lineButton.querySelector('.sidebar-hit-text')
      if (textEl) textEl.innerHTML = highlight(line.text, query, caseSensitive)
      addTarget(lineButton, { rel: hit.rel, line: line.line, column: line.column, length: query.length })
      box.append(lineButton)
    }
    return box
  }

  async function run(query: string, caseSensitive: boolean): Promise<void> {
    seq += 1
    const mine = seq
    showResults(true)
    options.resultsHost.replaceChildren(
      el('div', { class: 'sidebar-hit-searching', text: '搜索中……' })
    )

    const [result] = await Promise.all([
      api.search({ query, scope: 'all', caseSensitive }),
      sleep(MIN_BUSY_MS)
    ])
    if (mine !== seq) return
    if (!result.ok) {
      options.resultsHost.replaceChildren(el('div', { class: 'sidebar-hit-empty', text: '搜索失败' }))
      options.onError(result.error)
      return
    }
    const { hits, scanned, elapsedMs, truncated } = result.data
    if (hits.length === 0) {
      options.resultsHost.replaceChildren(
        el('div', { class: 'sidebar-hit-empty', text: `${scanned} 篇里没有「${query}」` })
      )
      return
    }
    const lineCount = hits.reduce((sum, hit) => sum + hit.lines.length, 0)
    const container = el('div', { class: 'sidebar-hit-list' })
    container.append(
      el('div', {
        class: 'sidebar-hit-meta',
        text: `${hits.length} 篇${lineCount > 0 ? ` / ${lineCount} 处` : ''} · ${elapsedMs}ms${truncated ? ' · 已截断' : ''}`
      })
    )
    for (const hit of hits) container.append(renderHit(hit, query, caseSensitive))
    options.resultsHost.replaceChildren(container)
  }

  function clear(): void {
    seq += 1
    options.resultsHost.replaceChildren()
    showResults(false)
  }

  return {
    search(query, searchOptions) {
      const text = (query ?? '').trim()
      if (text.length === 0) {
        clear()
        return
      }
      void run(text, searchOptions?.caseSensitive === true)
    },
    clear
  }
}
