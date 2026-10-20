// Request state is independent from the reused citation dialog DOM.
export function createReferenceAnalysisController({ fetchResult, analyze, onChange, delay = 500 }) {
  let generation = 0
  let timer = null
  let items = []
  let context = null
  let autoReady = false
  let autoRunning = false
  const current = token => token === generation
  const emit = () => onChange(items)

  async function run(item, force = false) {
    const token = generation
    const requestedContext = context
    if (!item || item.state === 'loading' || item.state === 'checking') return
    item.state = 'loading'
    emit()
    try {
      const result = await analyze(requestedContext, item.key, force)
      if (!current(token)) return
      item.result = result
      item.state = result.status
    } catch {
      if (!current(token)) return
      item.state = 'error'
    }
    if (current(token)) emit()
  }

  async function pump(token) {
    if (!current(token) || !autoReady || autoRunning) return
    autoRunning = true
    try {
      while (current(token)) {
        const item = items.find(entry => entry.state === 'not_analyzed')
        if (!item) break
        await run(item)
      }
    } finally {
      if (current(token)) autoRunning = false
    }
  }

  function close() {
    generation++
    clearTimeout(timer)
    timer = null
    autoReady = false
    autoRunning = false
  }

  function open(nextContext, references, automatic) {
    close()
    context = nextContext
    items = references.map(ref => ({ key: ref.key, state: 'checking', result: null }))
    const token = generation
    emit()
    if (automatic) timer = setTimeout(() => { autoReady = true; void pump(token) }, delay)
    for (const item of items) {
      Promise.resolve().then(() => fetchResult(nextContext, item.key)).then(result => {
        if (!current(token)) return
        item.result = result.status === 'not_analyzed' ? null : result
        item.state = result.status
      }).catch(() => {
        if (current(token)) item.state = 'error'
      }).finally(() => {
        if (!current(token)) return
        emit()
        void pump(token)
      })
    }
  }

  return { open, close, run: key => {
    const item = items.find(entry => entry.key === key)
    return run(item, Boolean(item?.result))
  } }
}

export function renderReferenceAnalysis(container, items, { t, run, reposition }) {
  // Keep existing cards and action buttons so async updates do not steal keyboard focus.
  for (const item of items) {
    let card = [...container.children].find(node => node.dataset.refKey === item.key)
    if (!card) {
      card = document.createElement('section')
      card.className = 'reference-analysis-card'
      card.dataset.refKey = item.key
      const heading = document.createElement('strong')
      heading.textContent = `[${item.key}]`
      const body = document.createElement('div')
      body.className = 'reference-analysis-body'
      body.setAttribute('aria-live', 'polite')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'citation-tooltip-action-btn'
      button.addEventListener('click', () => void run(item.key))
      card.append(heading, body, button)
      container.append(card)
    }
    const body = card.querySelector('.reference-analysis-body')
    const button = card.lastElementChild
    button.disabled = ['checking', 'loading'].includes(item.state)
    button.textContent = item.state === 'error' ? t('viewer:referenceAnalysis.retry')
      : item.result ? t('viewer:referenceAnalysis.regenerate') : t('viewer:referenceAnalysis.analyze')
    // Preserve evidence links when another card updates.
    const signature = JSON.stringify([item.state, item.result])
    if (card.dataset.signature === signature) continue
    card.dataset.signature = signature
    body.replaceChildren()
    const add = (text, tag = 'p') => {
      const node = document.createElement(tag)
      node.textContent = text
      body.append(node)
      return node
    }
    if (item.state === 'checking') add(t('viewer:referenceAnalysis.checking'))
    else if (item.state === 'loading') add(t('viewer:referenceAnalysis.loading'))
    else if (item.state === 'error') add(t('viewer:referenceAnalysis.error'))
    else if (item.result) {
      const result = item.result
      add(result.score == null ? t('viewer:referenceAnalysis.insufficient')
        : t('viewer:referenceAnalysis.score', { score: result.score }), 'strong')
      if (result.citation_reason) add(result.citation_reason)
      add(t('viewer:referenceAnalysis.disclaimer'), 'small')
    }
  }
  reposition()
}
