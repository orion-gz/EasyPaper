// Keep navigation outside the scrolling message list so it stays within reach.
export function mountChatQuestionNav(messages) {
  if (!messages) return
  const container = document.createElement('div')
  container.className = 'chat-message-navigation'
  messages.before(container)
  container.append(messages)
  const nav = document.createElement('nav')
  nav.className = 'chat-question-nav'
  nav.setAttribute('aria-label', messages.closest('aside')?.getAttribute('aria-label') || 'AI assistant')
  container.append(nav)
  const tooltip = document.createElement('div')
  tooltip.id = `${messages.id}-question-tooltip`
  tooltip.className = 'chat-question-tooltip'
  tooltip.setAttribute('role', 'tooltip')
  tooltip.hidden = true
  container.append(tooltip)
  let tooltipButton = null
  let hideTimer = 0

  function hideTooltip() {
    clearTimeout(hideTimer)
    tooltip.hidden = true
    tooltipButton?.removeAttribute('aria-describedby')
    tooltipButton = null
  }

  function scheduleHideTooltip() {
    hideTimer = setTimeout(hideTooltip, 100)
  }

  function showTooltip(button) {
    hideTooltip()
    tooltipButton = button
    tooltip.textContent = button.getAttribute('aria-label')
    tooltip.hidden = false
    button.setAttribute('aria-describedby', tooltip.id)
    const bounds = container.getBoundingClientRect()
    const scale = bounds.height / container.offsetHeight || 1
    const buttonBounds = button.getBoundingClientRect()
    const center = (buttonBounds.top + buttonBounds.height / 2 - bounds.top) / scale
    tooltip.style.top = `${Math.max(8, Math.min(center - tooltip.offsetHeight / 2, container.clientHeight - tooltip.offsetHeight - 8))}px`
  }

  tooltip.addEventListener('mouseenter', () => clearTimeout(hideTimer))
  tooltip.addEventListener('mouseleave', scheduleHideTooltip)
  nav.addEventListener('scroll', hideTooltip, { passive: true })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !tooltip.hidden) {
      hideTooltip()
      event.stopPropagation()
    }
  })
  let questions = []
  let frame = 0

  function updateActive() {
    frame = 0
    if (!questions.length || !messages.clientHeight) return
    const top = messages.scrollTop + parseFloat(getComputedStyle(messages).paddingTop) + 4
    let active = 0
    questions.forEach((question, index) => {
      if (question.offsetTop <= top) active = index
    })
    Array.from(nav.children).forEach((button, index) => {
      if (index === active) button.setAttribute('aria-current', 'true')
      else button.removeAttribute('aria-current')
    })
  }

  function scheduleUpdate() {
    if (!frame) frame = requestAnimationFrame(updateActive)
  }

  const resizeObserver = new ResizeObserver(scheduleUpdate)
  resizeObserver.observe(messages)
  function rebuild() {
    const next = Array.from(messages.children).filter(el => el.matches('.chat-message.user'))
    if (next.length === questions.length && next.every((el, i) => el === questions[i])) return
    hideTooltip()
    questions = next
    nav.replaceChildren(...questions.map((question, index) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'chat-question-dot'
      const text = question.querySelector('.message-bubble')?.textContent?.trim() || ''
      button.setAttribute('aria-label', `${index + 1}. ${text}`)
      button.setAttribute('aria-controls', messages.id)
      button.addEventListener('mouseenter', () => showTooltip(button))
      button.addEventListener('mouseleave', scheduleHideTooltip)
      button.addEventListener('focus', () => showTooltip(button))
      button.addEventListener('blur', scheduleHideTooltip)
      button.addEventListener('click', () => {
        hideTooltip()
        // offsetTop and scrollTop share layout coordinates, including with CSS zoom.
        // Viewport rectangles are scaled and would overshoot the question.
        const top = question.offsetTop - parseFloat(getComputedStyle(messages).paddingTop)
        messages.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
      })
      return button
    }))
    nav.hidden = questions.length === 0
    scheduleUpdate()
  }
  const observer = new MutationObserver(rebuild)
  observer.observe(messages, { childList: true })
  messages.addEventListener('scroll', scheduleUpdate, { passive: true })
  nav.hidden = true
  rebuild()
}
