import { t } from './i18n.js'
let activeMenu
let sequence = 0

export function enhanceLibraryRow(row) {
  const trigger = row.querySelector('.doc-card-kebab-btn')
  const menu = row.querySelector('.doc-card-kebab-menu')
  if (!trigger || !menu) return
  const home = menu.parentElement
  const edit = row.querySelector('.doc-edit-btn')
  if (edit) {
    edit.classList.add('doc-card-kebab-item')
    const label = document.createElement('span'); label.textContent = t('library:row.rename')
    edit.append(label); menu.prepend(edit)
  }
  menu.classList.add('library-row-action-menu')
  menu.id = `library-row-menu-${++sequence}`
  trigger.type = 'button'; trigger.setAttribute('aria-label', t('library:row.actions'))
  trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-haspopup', 'menu')
  trigger.setAttribute('aria-controls', menu.id)
  menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', t('library:row.actions'))
  const items = () => [...menu.querySelectorAll('button:not(:disabled)')]
  items().forEach(button => { button.type = 'button'; button.setAttribute('role', 'menuitem'); button.tabIndex = -1 })
  let observer
  const close = (focus = false) => {
    observer?.disconnect()
    menu.classList.add('hidden'); trigger.setAttribute('aria-expanded', 'false')
    home.append(menu)
    if (activeMenu?.menu === menu) activeMenu = null
    if (focus && trigger.isConnected) trigger.focus()
  }
  const open = last => {
    activeMenu?.close()
    document.querySelectorAll('.doc-card-kebab-menu').forEach(other => {
      other.classList.add('hidden')
      other.parentElement.querySelector('.doc-card-kebab-btn')?.setAttribute('aria-expanded', 'false')
    })
    document.body.append(menu); menu.classList.remove('hidden'); trigger.setAttribute('aria-expanded', 'true')
    const rect = trigger.getBoundingClientRect()
    const size = menu.getBoundingClientRect()
    const left = Math.max(8, Math.min(rect.right - size.width, window.innerWidth - size.width - 8))
    const below = rect.bottom + 6
    const top = below + size.height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - size.height - 6)
    menu.style.left = `${left}px`; menu.style.top = `${top}px`
    activeMenu = { menu, trigger, close }
    observer = new MutationObserver(() => { if (!trigger.isConnected) close() })
    observer.observe(document.body, { childList: true, subtree: true })
    const buttons = items(); buttons[last ? buttons.length - 1 : 0]?.focus({ preventScroll: true })
  }
  trigger.addEventListener('click', event => {
    event.stopPropagation()
    if (activeMenu?.menu === menu) close()
    else open(false)
  })
  trigger.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation(); open(event.key === 'ArrowUp')
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
  // Existing actions stop propagation; capture then close after their handler.
  menu.addEventListener('click', event => {
    if (event.target.closest('button')) queueMicrotask(() => close())
  }, true)
}
document.addEventListener('pointerdown', event => {
  if (activeMenu && !activeMenu.menu.contains(event.target) && !activeMenu.trigger.contains(event.target)) activeMenu.close()
}, true)
document.addEventListener('scroll', event => {
  if (activeMenu && !activeMenu.menu.contains(event.target)) activeMenu.close()
}, true)
window.addEventListener('resize', () => activeMenu?.close())
