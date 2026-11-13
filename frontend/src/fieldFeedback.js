import './styles/field-feedback.css'
// Preserve existing help text while associating an inline validation message.
let sequence = 0
const messages = new WeakMap()
export function setFieldFeedback(input, message = '') {
  let node = messages.get(input)
  if (!node && message) {
    node = document.createElement('span'); node.className = 'field-feedback'
    node.id = `field-feedback-${++sequence}`; node.setAttribute('aria-live', 'polite')
    input.insertAdjacentElement('afterend', node); messages.set(input, node)
    input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), node.id].filter(Boolean).join(' '))
  }
  if (node) { node.textContent = message; node.hidden = !message }
  if (message) input.setAttribute('aria-invalid', 'true')
  else input.removeAttribute('aria-invalid')
}
export function installFieldFeedback(root) {
  if (!root) return
  root.addEventListener('invalid', event => setFieldFeedback(event.target, event.target.validationMessage), true)
  root.addEventListener('input', event => {
    if (messages.has(event.target)) setFieldFeedback(event.target, event.target.validity?.valid ? '' : event.target.validationMessage)
  })
  root.addEventListener('change', event => {
    if (messages.has(event.target)) setFieldFeedback(event.target, event.target.validity?.valid ? '' : event.target.validationMessage)
  })
}
