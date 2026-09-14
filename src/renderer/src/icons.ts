/**
 * 内联 SVG 图标集。
 *
 * 不用 emoji，也不用图标字体：emoji 在不同系统上长得完全不一样，
 * 图标字体又要多一套加载与兜底逻辑。内联 SVG 是 currentColor 上色的，
 * 主题一换自动跟着变，体积也可以忽略。
 */
export type IconName =
  | 'folder-open'
  | 'file-plus'
  | 'folder-plus'
  | 'save'
  | 'export'
  | 'eye'
  | 'eye-off'
  | 'focus'
  | 'lines'
  | 'moon'
  | 'sun'
  | 'sliders'
  | 'sidebar'
  | 'panel-left'
  | 'panel-right'
  | 'panel-bottom'
  | 'expand-all'
  | 'collapse-all'
  | 'import'
  | 'search'
  | 'menu'
  | 'edit'
  | 'arrow-up'
  | 'arrow-down'
  | 'close'
  | 'win-min'
  | 'win-max'
  | 'win-restore'
  | 'win-close'
  | 'book'

const PATHS: Record<IconName, string> = {
  'folder-open':
    '<path d="M4 8V6.6A1.6 1.6 0 0 1 5.6 5h3.1a1.6 1.6 0 0 1 1.3.7L11 7.2h5.4A1.6 1.6 0 0 1 18 8.8v1.1"/><path d="M2.9 10.5h18.2l-1.7 8.1a1.6 1.6 0 0 1-1.6 1.3H6.2a1.6 1.6 0 0 1-1.6-1.3L2.9 10.5z"/>',
  'file-plus':
    '<path d="M13.6 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.4L13.6 3z"/><path d="M13.6 3v5.4H19"/><path d="M12 12.6v5M9.5 15.1h5"/>',
  'folder-plus':
    '<path d="M4 7.4A1.6 1.6 0 0 1 5.6 5.8h3.1a1.6 1.6 0 0 1 1.3.7l1 1.5h7A1.6 1.6 0 0 1 19.6 9.6v8.8A1.6 1.6 0 0 1 18 20H5.6A1.6 1.6 0 0 1 4 18.4V7.4z"/><path d="M11.8 11.6v5M9.3 14.1h5"/>',
  save: '<path d="M5.6 4h9.1L20 9.3V19a1 1 0 0 1-1 1H5.6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M8.6 4v5.6h6V4"/><path d="M8.2 14.6h7.6"/>',
  export:
    '<path d="M13.6 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.4L13.6 3z"/><path d="M13.6 3v5.4H19"/><path d="M12 11.4v5.2M9.9 14.5L12 16.6l2.1-2.1"/>',
  eye: '<path d="M2.6 12S6.1 6.6 12 6.6 21.4 12 21.4 12 17.9 17.4 12 17.4 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.8"/>',
  'eye-off':
    '<path d="M4 4l16 16"/><path d="M9.6 6.9A9.4 9.4 0 0 1 12 6.6c5.9 0 9.4 5.4 9.4 5.4a17 17 0 0 1-3.3 3.7"/><path d="M6.5 8.3A16.7 16.7 0 0 0 2.6 12S6.1 17.4 12 17.4a9.6 9.6 0 0 0 3.6-.7"/><path d="M10.2 10.3a2.8 2.8 0 0 0 3.6 3.6"/>',
  focus: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.6"/>',
  lines: '<path d="M9.5 6.6h10.5M9.5 12h10.5M9.5 17.4h10.5"/><path d="M4.6 6.6h.01M4.6 12h.01M4.6 17.4h.01"/>',
  moon: '<path d="M20 14.6A8.6 8.6 0 0 1 9.4 4a8.6 8.6 0 1 0 10.6 10.6z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/>',
  sliders:
    '<path d="M5 8.4h7.4M17.2 8.4H19M5 15.6h2M11.8 15.6H19"/><circle cx="14.6" cy="8.4" r="2.2"/><circle cx="9.2" cy="15.6" r="2.2"/>',
  sidebar: '<rect x="3.2" y="4.6" width="17.6" height="14.8" rx="1.8"/><path d="M9.6 4.6v14.8"/>',
  'panel-left': '<rect x="3.2" y="4.6" width="17.6" height="14.8" rx="1.8"/><path d="M9.8 4.6v14.8"/>',
  'panel-right': '<rect x="3.2" y="4.6" width="17.6" height="14.8" rx="1.8"/><path d="M14.2 4.6v14.8"/>',
  'panel-bottom': '<rect x="3.2" y="4.6" width="17.6" height="14.8" rx="1.8"/><path d="M3.2 15.2h17.6"/>',
  'expand-all': '<path d="M7.6 4.8l4.4 4.2 4.4-4.2"/><path d="M7.6 12l4.4 4.2 4.4-4.2"/>',
  'collapse-all': '<path d="M7.6 9.2L12 5l4.4 4.2"/><path d="M7.6 16.4L12 12.2l4.4 4.2"/>',
  import:
    '<path d="M12 3.6v10.2"/><path d="M8 10.2l4 3.8 4-3.8"/><path d="M4.5 16.4v2.4a1.6 1.6 0 0 0 1.6 1.6h11.8a1.6 1.6 0 0 0 1.6-1.6v-2.4"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.4"/><path d="M15.5 15.5L20.4 20.4"/>',
  menu: '<path d="M4.6 7h14.8M4.6 12h14.8M4.6 17h14.8"/>',
  edit: '<path d="M4.8 19.2h3.1l9.4-9.4a2.1 2.1 0 0 0 0-3l-1.3-1.3a2.1 2.1 0 0 0-3 0l-9.4 9.4v4.3z"/><path d="M13.4 6.8l3.2 3.2"/>',
  'arrow-up': '<path d="M12 19.4V5.2"/><path d="M6.6 10.6L12 5.2l5.4 5.4"/>',
  'arrow-down': '<path d="M12 4.6v14.2"/><path d="M17.4 13.4L12 18.8l-5.4-5.4"/>',
  close: '<path d="M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6"/>',
  'win-min': '<path d="M5 12.6h14"/>',
  'win-max': '<rect x="5.6" y="5.6" width="12.8" height="12.8" rx="1.6"/>',
  'win-restore': '<rect x="5.4" y="8.2" width="10.4" height="10.4" rx="1.4"/><path d="M8.6 8.2V6.6A1.2 1.2 0 0 1 9.8 5.4h7.2A1.2 1.2 0 0 1 18.2 6.6v7.2a1.2 1.2 0 0 1-1.2 1.2h-1.4"/>',
  'win-close': '<path d="M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/>',
  book: '<path d="M4 5.6A1.6 1.6 0 0 1 5.6 4H10a2 2 0 0 1 2 2v13.2a1.6 1.6 0 0 0-1.6-1.4H4V5.6z"/><path d="M20 5.6A1.6 1.6 0 0 0 18.4 4H14a2 2 0 0 0-2 2v13.2a1.6 1.6 0 0 1 1.6-1.4H20V5.6z"/>'
}

export function icon(name: IconName, size = 17): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.55')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.innerHTML = PATHS[name]
  return svg
}
