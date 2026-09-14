/** 一点点 DOM 糖，避免为了个 hello world 引入整个框架。 */

type Attrs = Record<string, string | number | boolean | undefined | null | EventListener>
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'type', 'textContent'])

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  children?: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue
      if (key === 'class') {
        node.className = String(value)
      } else if (key === 'text') {
        node.textContent = String(value)
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value)
      } else if (PROPS.has(key)) {
        ;(node as unknown as Record<string, unknown>)[key] = value
      } else if (value === true) {
        node.setAttribute(key, '')
      } else {
        node.setAttribute(key, String(value))
      }
    }
  }
  if (children) {
    for (const child of children) {
      if (child === null || child === undefined) continue
      node.append(typeof child === 'string' ? document.createTextNode(child) : child)
    }
  }
  return node
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`页面缺少元素 #${id}`)
  return node as T
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export type ToastKind = 'info' | 'success' | 'error'

export function toast(message: string, kind: ToastKind = 'info'): void {
  const host = document.getElementById('toast-host')
  if (!host) return
  const item = el('div', { class: `toast toast-${kind}`, text: message })
  host.append(item)
  const life = kind === 'error' ? 7000 : 3500
  window.setTimeout(() => {
    item.classList.add('toast-out')
    window.setTimeout(() => item.remove(), 260)
  }, life)
}

export function formatTime(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 给按钮加一点点反馈，避免重复点击导致重复请求 */
export async function withBusy<T>(button: HTMLButtonElement | null, task: () => Promise<T>): Promise<T> {
  if (button) button.disabled = true
  try {
    return await task()
  } finally {
    if (button) button.disabled = false
  }
}
