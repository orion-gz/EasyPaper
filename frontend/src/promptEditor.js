import { previewTranslationPrompt } from './api.js'
import './promptEditor.css'

const presets = {
  terms: 'Include the original term in parentheses after translated technical terms.',
  abbreviations: 'Expand abbreviations on first use.',
  equations: 'Keep mathematical notation exactly as written.',
  citations: 'Preserve citation markers and author-year references as written.',
  units: 'Keep numerical values and measurement units unchanged.',
  consistent: 'Use the same translation for repeated technical terms.',
  hedging: 'Preserve distinctions between tentative findings and established claims.',
  references: 'Retain figure and table numbers in cross-references.',
  paragraphs: 'Preserve the paragraph breaks of the source text.'
}
const tokens = {
  text: 'TEXT', target: 'TARGET_LANGUAGE_NAME', language: 'LANG_INSTRUCTION',
  style: 'STYLE_INSTRUCTION', rules: 'RULES_TEXT', context: 'CONTEXT_PART'
}

export function createPromptEditor(root, t, save, options) {
  const el = key => root.querySelector(`[data-role="${key}"]`)
  const labels = {
    add: () => t('settings:prompt.add'),
    simple: () => t('settings:prompt.simple'),
    advanced: () => t('settings:prompt.advanced'),
    terms: () => t('settings:prompt.terms'),
    abbreviations: () => t('settings:prompt.abbreviations'),
    equations: () => t('settings:prompt.equations'),
    citations: () => t('settings:prompt.citations'),
    units: () => t('settings:prompt.units'),
    consistent: () => t('settings:prompt.consistent'),
    hedging: () => t('settings:prompt.hedging'),
    references: () => t('settings:prompt.references'),
    paragraphs: () => t('settings:prompt.paragraphs'),
    update: () => t('settings:prompt.update'),
    remove: () => t('settings:prompt.remove'),
    text: () => t('settings:prompt.text'),
    target: () => t('settings:prompt.target'),
    language: () => t('settings:prompt.language'),
    style: () => t('settings:prompt.style'),
    rules: () => t('settings:prompt.rules'),
    context: () => t('settings:prompt.context'),
    missing: () => t('settings:prompt.missing'),
  }
  const label = key => labels[key]()
  let base, draft, saved, editing = -1, revision = 0
  const button = (parent, title, click, pressed) => {
    const node = document.createElement('button')
    node.type = 'button'
    node.textContent = title
    if (pressed !== undefined) node.setAttribute('aria-pressed', String(pressed))
    node.onclick = click
    parent.append(node)
    return node
  }
  function simpleTemplate() {
    const lines = [...Object.keys(presets).filter(id => draft.selected.includes(id)).map(id => presets[id]), ...draft.custom]
    return base.replace('{{RULES_TEXT}}', () => ['{{RULES_TEXT}}', ...lines.map(line => '- ' + line)].join('\n'))
  }
  const template = () => draft.mode === 'advanced' ? draft.advanced : simpleTemplate()
  function invalidate() {
    revision++
    el('result').hidden = true
    el('status').textContent = ''
  }
  function render() {
    invalidate()
    for (const key of ['modes', 'tokens', 'presets', 'custom']) el(key).replaceChildren()
    for (const mode of ['simple', 'advanced']) {
      button(el('modes'), label(mode), () => {
        if (mode === 'advanced' && draft.advanced === null) draft.advanced = simpleTemplate()
        draft.mode = mode
        render()
      }, draft.mode === mode)
      el(mode).hidden = draft.mode !== mode
    }
    for (const id of Object.keys(presets)) {
      const active = draft.selected.includes(id)
      const preset = button(el('presets'), label(id), () => {
        draft.selected = draft.selected.includes(id) ? draft.selected.filter(key => key !== id) : [...draft.selected, id]
        invalidate()
        preset.setAttribute('aria-pressed', String(draft.selected.includes(id)))
      }, active)
    }
    draft.custom.forEach((value, index) => {
      const chip = document.createElement('span')
      el('custom').append(chip)
      const edit = button(chip, value, () => {
        editing = index
        el('input').value = value
        el('input').focus()
        el('add').textContent = label('update')
      })
      edit.title = label('update')
      button(chip, '', () => {
        draft.custom.splice(index, 1)
        resetInput()
        render()
      }).setAttribute('aria-label', label('remove') + ' ' + value)
    })
    const field = el('template')
    field.value = draft.advanced ?? ''
    for (const [key, token] of Object.entries(tokens)) {
      button(el('tokens'), label(key), () => {
        field.setRangeText('{{' + token + '}}', field.selectionStart, field.selectionEnd, 'end')
        field.focus()
        field.oninput()
      })
    }
  }
  function resetInput() {
    editing = -1
    el('input').value = ''
    el('add').textContent = label('add')
  }
  el('add').onclick = () => {
    const value = el('input').value.trim()
    if (!value) return
    if (editing === -1) draft.custom.push(value)
    else draft.custom[editing] = value
    resetInput()
    render()
  }
  el('input').onkeydown = event => {
    if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      el('add').click()
    }
  }
  el('template').oninput = () => {
    draft.advanced = el('template').value
    invalidate()
  }
  el('preview').onclick = async () => {
    const version = ++revision
    try {
      const result = await previewTranslationPrompt({ ...options(), template: template() })
      if (revision !== version) return
      el('result').textContent = result.prompt
      el('result').hidden = false
    } catch (err) {
      if (revision === version) el('status').textContent = err.message
    }
  }
  el('apply').onclick = async () => {
    if (!template().includes('{{TEXT}}')) {
      el('status').textContent = label('missing')
      el('template').focus()
      return
    }
    const payload = { translation_prompt_template: template(), translation_prompt_editor: JSON.stringify(draft) }
    root.disabled = true
    try {
      if (await save(payload)) saved = JSON.stringify(Object.values(payload))
    } finally {
      root.disabled = false
    }
  }
  return {
    load(sys) {
      const actual = sys.translation_prompt_template || sys.default_prompt_template
      const signature = JSON.stringify([actual, sys.translation_prompt_editor || ''])
      root.disabled = !sys.default_prompt_template || !!sys.read_only
      if (!sys.default_prompt_template || signature === saved) return
      base = sys.default_prompt_template
      saved = signature
      try {
        draft = JSON.parse(sys.translation_prompt_editor)
        if (!['simple', 'advanced'].includes(draft.mode) || !Array.isArray(draft.selected) ||
            !Array.isArray(draft.custom) || !draft.custom.every(x => typeof x === 'string') ||
            (draft.advanced !== null && typeof draft.advanced !== 'string') || template() !== actual) throw Error()
      } catch {
        draft = { mode: actual === base ? 'simple' : 'advanced', advanced: actual === base ? null : actual,
          selected: [], custom: [] }
      }
      resetInput()
      render()
    }
  }
}
