/**
 * 命令菜单。
 *
 * 一个按钮 + 一份命令清单：点顶栏的「菜单」按钮打开，按 Ctrl+K 也打开。
 * 刻意**不做搜索**——命令一共十几条，分组看比打字快；搜索留给以后的命令面板。
 *
 * 为什么不用系统原生菜单栏：那是系统画的，不跟主题和界面缩放走，
 * 而且按 Alt 唤出会和编辑区的 Alt 拖拽竖选打架（之前修过这个 bug）。
 */
import { COMMANDS } from '@shared/commands'
import type { CommandDef } from '@shared/commands'
import { el } from './dom'

export interface CommandMenu {
  open(): void
  close(): void
  toggle(): void
  isOpen(): boolean
}

export function createCommandMenu(anchor: HTMLElement, onRun: (id: string) => void): CommandMenu {
  let panel: HTMLElement | null = null
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

  function build(): void {
    const list = el('div', { class: 'command-menu-list' })
    let lastGroup = ''
    for (const command of COMMANDS) {
      if (command.group !== lastGroup) {
        lastGroup = command.group
        list.append(el('div', { class: 'command-menu-group', text: command.group }))
      }
      const button = el(
        'button',
        { class: 'command-menu-item', type: 'button', 'data-command': command.id, onclick: () => run(command.id) },
        [
          el('span', { class: 'command-menu-label', text: command.label }),
          command.accel ? el('span', { class: 'command-menu-accel', text: command.accel }) : null
        ]
      )
      list.append(button)
      items.push({ button, command })
    }

    panel = el('div', { class: 'command-menu', tabindex: '-1', hidden: true }, [list])
    panel.addEventListener('mousedown', (event) => event.stopPropagation())
    panel.addEventListener('keydown', (event) => {
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
    document.body.append(panel)
  }

  function close(): void {
    if (!open || !panel) return
    open = false
    panel.hidden = true
    document.removeEventListener('mousedown', onOutside, true)
  }

  function onOutside(event: MouseEvent): void {
    if (!panel || panel.contains(event.target as Node)) return
    close()
  }

  function openMenu(): void {
    if (!panel) build()
    if (!panel) return
    open = true
    panel.hidden = false

    // 贴着菜单按钮展开。按钮每次重渲染都会换掉，所以这里现查一次；
    // 查不到就退回顶栏（否则会贴到窗口最左边缘，和按钮差一个内边距）
    const button = anchor.querySelector('button')
    const rect = (button ?? anchor).getBoundingClientRect()
    panel.style.left = `${Math.round(rect.left)}px`
    panel.style.top = `${Math.round(rect.bottom + 6)}px`

    setActive(0)
    panel.focus()
    document.addEventListener('mousedown', onOutside, true)
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
