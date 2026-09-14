/**
 * 命令清单（单一事实来源）。
 *
 * 菜单、命令面板、原生菜单的快捷键都要从这里来，否则三处各写一份必然会漂移
 * （比如加了「导出合并 PDF」只更新了右键菜单，菜单里没有）。
 *
 * 这里只放**一级动作**：需要选参数的动作（导出选项、备份位置）菜单项只负责打开入口，
 * 不在菜单里展开表单。
 */

export interface CommandDef {
  /** 和 MenuAction 对齐；渲染层特有的动作（如 import-files）在这里单独定义 */
  id: string
  label: string
  /** 只用于显示，真正的快捷键注册在原生菜单里 */
  accel?: string
  /** 分组标题 */
  group: string
}

export const COMMANDS: CommandDef[] = [
  { id: 'new-file', label: '新建文稿', accel: 'Ctrl+N', group: '文稿' },
  { id: 'new-folder', label: '新建文件夹', accel: 'Ctrl+Shift+N', group: '文稿' },
  { id: 'import-files', label: '导入 Markdown 文件…', group: '文稿' },
  { id: 'open-vault', label: '打开文件夹…', accel: 'Ctrl+O', group: '文档库' },
  { id: 'backup', label: '备份整个文档库…', group: '文档库' },
  { id: 'save', label: '保存', accel: 'Ctrl+S', group: '保存与导出' },
  { id: 'export-pdf', label: '导出 PDF…', accel: 'Ctrl+P', group: '保存与导出' },
  { id: 'find', label: '查找', accel: 'Ctrl+F', group: '查找' },
  { id: 'replace', label: '查找并替换', accel: 'Ctrl+H', group: '查找' },
  { id: 'search', label: '搜索文稿', accel: 'Ctrl+Shift+F', group: '查找' },
  { id: 'toggle-preview', label: '编辑 ⇄ 预览', accel: 'Ctrl+Shift+P', group: '视图' },
  { id: 'toggle-focus', label: '专注模式', accel: 'F11', group: '视图' },
  { id: 'open-settings', label: '设置…', accel: 'Ctrl+,', group: '设置' }
]
