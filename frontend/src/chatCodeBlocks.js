import { t } from './i18n.js'
// Called only after Markdown sanitization. Text is never interpolated into HTML.
export function decorateCodeBlocks(html) {
  const template = document.createElement('template'); template.innerHTML = html
  template.content.querySelectorAll('pre').forEach(pre => {
    const code = pre.querySelector('code')
    if (!code) return
    const wrapper = document.createElement('div'); wrapper.className = 'chat-code-block'
    const header = document.createElement('div'); header.className = 'chat-code-header'
    const language = document.createElement('span')
    language.textContent = [...code.classList].find(name => name.startsWith('language-'))?.slice(9) || t('chat:code.label')
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'chat-code-copy'; copy.textContent = t('chat:code.copy')
    header.append(language, copy); pre.replaceWith(wrapper); wrapper.append(header, pre)
  })
  return template.innerHTML
}
export function installCodeCopy(root) {
  root.addEventListener('click', async event => {
    const button = event.target.closest('.chat-code-copy')
    if (!button) return
    const code = button.closest('.chat-code-block')?.querySelector('pre code')
    if (!code) return
    button.disabled = true
    try { await navigator.clipboard.writeText(code.textContent); button.textContent = t('chat:code.copied') }
    catch { button.textContent = t('chat:code.failed') }
    finally { button.disabled = false }
  })
}
