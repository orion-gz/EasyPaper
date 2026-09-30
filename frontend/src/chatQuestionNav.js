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
  let questions = []
  let frame = 0

  function updateActive() {
    frame = 0
    if (!questions.length || !messages.clientHeight) return
    const top = messages.getBoundingClientRect().top + 24
    let active = 0
    questions.forEach((question, index) => {
      if (question.getBoundingClientRect().top <= top) active = index
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
    questions = next
    nav.replaceChildren(...questions.map((question, index) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'chat-question-dot'
      const text = question.querySelector('.message-bubble')?.textContent?.trim() || ''
      button.title = `${index + 1}. ${text}`
      button.setAttribute('aria-label', button.title)
      button.setAttribute('aria-controls', messages.id)
      button.addEventListener('click', () => {
        const top = question.getBoundingClientRect().top - messages.getBoundingClientRect().top + messages.scrollTop - 20
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
