import { t } from './i18n.js'
// Nested native disclosures preserve keyboard and screen-reader semantics.
export function renderOutlineTree(container, items, navigate) {
  const root = document.createElement('nav'); root.className = 'outline-tree'
  root.setAttribute('aria-label', t('viewer:outline.navigation'))
  const select = button => {
    root.querySelectorAll('[aria-current]').forEach(item => item.removeAttribute('aria-current'))
    button.setAttribute('aria-current', 'location')
  }
  function render(parent, nodes) {
    const list = document.createElement('ul'); parent.append(list)
    for (const item of nodes) {
      const entry = document.createElement('li'); list.append(entry)
      const hasChildren = item.items?.length > 0
      const details = hasChildren ? document.createElement('details') : null
      const line = document.createElement(hasChildren ? 'summary' : 'div')
      line.className = 'outline-tree-line'
      const title = document.createElement('span'); title.className = 'outline-tree-title'; title.textContent = item.title; title.title = item.title
      line.append(title)
      if (item.pageNum) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'outline-item outline-page-link'
        button.textContent = String(item.pageNum); button.setAttribute('aria-label', `${item.title} — ${t('viewer:goToPage', { page: item.pageNum })}`)
        button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); select(button); navigate(item.pageNum) })
        line.append(button)
        if (!hasChildren) { title.addEventListener('click', () => button.click()); title.style.cursor = 'pointer' }
      }
      if (details) { details.open = true; details.append(line); entry.append(details); render(details, item.items) }
      else entry.append(line)
    }
  }
  render(root, items)
  root.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const controls = [...root.querySelectorAll('summary, button')].filter(node => node.getClientRects().length)
    const index = controls.indexOf(document.activeElement)
    if (index < 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : Math.max(0, Math.min(controls.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
    controls[next]?.focus()
  })
  container.append(root)
}
