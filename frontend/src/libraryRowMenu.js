import { t } from './i18n.js'
let activeMenu
export function enhanceLibraryRow(row) {
  const trigger = row.querySelector('.doc-card-kebab-btn')
  const menu = row.querySelector('.doc-card-kebab-menu')
  if (!trigger || !menu) return
  const edit = row.querySelector('.doc-edit-btn')
  if (edit) {
    edit.classList.add('doc-card-kebab-item')
    const label = document.createElement('span'); label.textContent = t('library:row.rename')
    edit.append(label); menu.prepend(edit)
  }
  trigger.type = 'button'; trigger.setAttribute('aria-label', t('library:row.actions'))
  trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-haspopup', 'menu')
  menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', t('library:row.actions'))
  const items = () => [...menu.querySelectorAll('button:not(:disabled)')]
  items().forEach(button => { button.type = 'button'; button.setAttribute('role', 'menuitem'); button.tabIndex = -1 })
  const close = (focus = false) => {
    menu.classList.add('hidden'); trigger.setAttribute('aria-expanded', 'false')
    if (activeMenu?.menu === menu) activeMenu = null
    if (focus && trigger.isConnected) trigger.focus()
  }
  const focusItem = last => {
    activeMenu?.close(); menu.classList.remove('hidden'); trigger.setAttribute('aria-expanded', 'true')
    activeMenu = { menu, trigger, close }; const buttons = items(); buttons[last ? buttons.length - 1 : 0]?.focus()
  }
  // Existing row handlers toggle the menu before this listener runs.
  trigger.addEventListener('click', () => {
    if (!menu.classList.contains('hidden')) focusItem(false)
    else close()
  })
  trigger.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation(); focusItem(event.key === 'ArrowUp')
  })
  menu.addEventListener('keydown', event => {
    const buttons = items(); const index = buttons.indexOf(document.activeElement)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
    if (event.key === 'Tab') { close(true); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  })
  menu.addEventListener('click', event => { if (event.target.closest('button')) close() })
}
document.addEventListener('click', event => {
  if (activeMenu && !activeMenu.menu.contains(event.target) && !activeMenu.trigger.contains(event.target)) activeMenu.close()
})
