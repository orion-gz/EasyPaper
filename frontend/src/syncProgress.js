import { t } from './i18n.js'

const active = new Set()

export function setSyncProgress(key, running) {
  if (running) active.add(key)
  else active.delete(key)
  if (typeof document === 'undefined') return
  const sidebar = document.getElementById('app-sidebar')
  if (!sidebar) return
  let node = sidebar.querySelector('[data-sync-progress]')
  if (!node && active.size) {
    node = document.createElement('div')
    node.dataset.syncProgress = ''
    node.style.cssText = 'padding:12px;min-width:0'
    const progress = document.createElement('progress')
    progress.style.cssText = 'width:100%;height:6px;accent-color:var(--accent)'
    node.append(progress)
    sidebar.append(node)
  }
  if (node) {
    node.hidden = active.size === 0
    node.querySelector('progress').setAttribute('aria-label', t('viewer:sync.inProgress'))
    node.title = t('viewer:sync.inProgress')
  }
}
