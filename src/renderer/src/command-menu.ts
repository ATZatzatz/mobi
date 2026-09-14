/**
 * 命令菜单。
 *
 * 一个按钮 + 一份命令清单。点顶栏的「菜单」按钮打开，按 Ctrl+K 也打开同一个面板
 * （所以它同时是菜单和命令面板：不输入就是分组菜单，输入就是模糊搜索）。
 *
 * 为什么不用系统原生菜单栏：那是系统画的，不跟主题和界面缩放走，
 * 而且按 Alt 唤出会和编辑区的 Alt 拖拽竖选打架（之前修过这个 bug）。
 */
import { COMMANDS } from '@shared/commands'
import type { CommandDef } from '@shared/commands'
import { el } from './dom'
import { icon } from './icons'

export interface CommandMenu {
  open(): void
  close(): void
  toggle(): void
  isOpen(): boolean
}

export function createCommandMenu(anchor: HTMLElement, onRun: (id: string) => void): CommandMenu {
  let panel: HTMLElement | null = null
  let input: HTMLInputElement | null = null
  let listEl: HTMLElement | null = null
  let items: Array<{ button: HTMLButtonElement; command: CommandDef }> = []
  let active = -1
  let open = false

  function setActive(next: number): void {
    if (items.length === 0) {
      active = -1
      return
    }
    active = (next + items.length) % items.length
    items.forEach((item, index) => item.button.classList.toggle('active', index === active))
    items[active]?.button.scrollIntoView({ block: 'nearest' })
  }

  function run(id: string): void {
    close()
    onRun(id)
  }

  function render(filter: string): void {
    if (!listEl) return
    const needle = filter.trim().toLowerCase()
    const matched = needle
      ? COMMANDS.filter((command) => command.label.toLowerCase().includes(needle))
      : COMMANDS

    listEl.replaceChildren()
    items = []
    let lastGroup = ''
    let firstInGroup = true

    for (const command of matched) {
      if (command.group !== lastGroup) {
        lastGroup = command.group
        // 搜索状态下不再显示分组标题，结果列表更紧凑
        if (!needle) listEl.append(el('div', { class: 'command-menu-group', text: command.group }))
        else if (!firstInGroup) listEl.append(el('div', { class: 'command-menu-sep' }))
      }
      firstInGroup = false

      const button = el(
        'button',
        { class: 'command-menu-item', type: 'button', 'data-command': command.id, onclick: () => run(command.id) },
        [
          el('span', { class: 'command-menu-label', text: command.label }),
          command.accel ? el('span', { class: 'command-menu-accel', text: command.accel }) : null
        ]
      )
      listEl.append(button)
      items.push({ button, command })
    }

    if (items.length === 0) {
      listEl.append(el('div', { class: 'command-menu-empty', text: '没有匹配的命令' }))
    }
    setActive(0)
  }

  function build(): void {
    input = el('input', {
      class: 'command-menu-input',
      type: 'text',
      placeholder: '输入命令…',
      spellcheck: 'false'
    }) as HTMLInputElement
    input.addEventListener('input', () => render(input?.value ?? ''))
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive(active + 1)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive(active - 1)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        const pick = items[active]
        if (pick) run(pick.command.id)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
      event.stopPropagation()
    })

    listEl = el('div', { class: 'command-menu-list' })
    panel = el('div', { class: 'command-menu', hidden: true }, [
      el('div', { class: 'command-menu-head' }, [el('span', { class: 'command-menu-icon' }, [icon('menu', 14)]), input]),
      listEl
    ])
    panel.addEventListener('mousedown', (event) => event.stopPropagation())
    document.body.append(panel)
  }

  function close(): void {
    if (!open || !panel) return
    open = false
    panel.hidden = true
    document.removeEventListener('mousedown', onOutside, true)
    document.removeEventListener('keydown', onGlobalKey, true)
  }

  function onOutside(event: MouseEvent): void {
    if (!panel || panel.contains(event.target as Node)) return
    if (anchor.contains(event.target as Node)) return
    close()
  }

  function onGlobalKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }

  function openMenu(): void {
    if (!panel) build()
    if (!panel || !input) return
    open = true
    panel.hidden = false

    // 贴着菜单按钮下方展开
    const rect = anchor.getBoundingClientRect()
    panel.style.left = `${Math.round(rect.left)}px`
    panel.style.top = `${Math.round(rect.bottom + 6)}px`

    input.value = ''
    render('')
    input.focus()
    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('keydown', onGlobalKey, true)
  }

  return {
    open: openMenu,

    close,

    toggle() {
      if (open) close()
      else openMenu()
    },

    isOpen() {
      return open
    }
  }
}
