export function buildTextAnchor(text, start, end, metadata = {}) {
  return { ...metadata, start, end, exact: text.slice(start, end), prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(end, end + 32) }
}

export function resolveTextAnchor(text, anchor) {
  const expectedStart = Number(anchor.start); const expectedEnd = Number(anchor.end)
  if (text.slice(expectedStart, expectedEnd) === anchor.exact) return { start: expectedStart, end: expectedEnd }
  if (!anchor.exact) return null
  const matches = []; let cursor = text.indexOf(anchor.exact)
  while (cursor >= 0) { matches.push(cursor); cursor = text.indexOf(anchor.exact, cursor + 1) }
  const contextual = matches.find(start => text.slice(Math.max(0, start - (anchor.prefix || '').length), start) === (anchor.prefix || '') && text.slice(start + anchor.exact.length, start + anchor.exact.length + (anchor.suffix || '').length) === (anchor.suffix || ''))
  const start = contextual ?? matches[0]
  return start == null ? null : { start, end: start + anchor.exact.length }
}

function rangeOffsets(range, root) {
  if (!root.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== root) return null
  const before = document.createRange(); before.selectNodeContents(root); before.setEnd(range.startContainer, range.startOffset)
  const through = document.createRange(); through.selectNodeContents(root); through.setEnd(range.endContainer, range.endOffset)
  return { start: before.toString().length, end: through.toString().length }
}

function rangeFromOffsets(root, offsets) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let position = 0, startNode, endNode, startOffset = 0, endOffset = 0
  while (walker.nextNode()) {
    const node = walker.currentNode; const next = position + node.length
    if (!startNode && offsets.start >= position && offsets.start <= next) { startNode = node; startOffset = offsets.start - position }
    if (offsets.end >= position && offsets.end <= next) { endNode = node; endOffset = offsets.end - position; break }
    position = next
  }
  if (!startNode || !endNode) return null
  const range = document.createRange(); range.setStart(startNode, startOffset); range.setEnd(endNode, endOffset)
  return range
}

function markRange(range, annotation) {
  const span = document.createElement('span'); span.className = annotation.type === 'underline' ? 'article-underline' : 'article-highlight'
  span.style.setProperty('--annotation-color', annotation.color || (annotation.type === 'underline' ? '#ef4444' : '#eab308'))
  span.dataset.annotationId = annotation.id || ''
  try { range.surroundContents(span) } catch { const fragment = range.extractContents(); span.appendChild(fragment); range.insertNode(span) }
}

function selectionContext(root) {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  const start = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer
  const end = range.endContainer.nodeType === Node.TEXT_NODE ? range.endContainer.parentElement : range.endContainer
  const block = start?.closest?.('[data-block-id]')
  if (!block || block !== end?.closest?.('[data-block-id]')) return null
  const unit = block.closest('.article-unit'); const offsets = rangeOffsets(range, block)
  if (!unit || !offsets) return null
  return { range, block, unit, unitIndex: Number(unit.dataset.unitIndex), anchor: buildTextAnchor(block.textContent || '', offsets.start, offsets.end, { unit_id: unit.dataset.unitId, block_id: block.dataset.blockId }) }
}

function syncPanes(pair) {
  const panes = [...pair.querySelectorAll('.article-pane')]; let syncing = false
  panes.forEach((pane, index) => pane.addEventListener('scroll', () => {
    if (syncing) return; syncing = true
    const other = panes[1 - index]; const available = pane.scrollHeight - pane.clientHeight
    other.scrollTop = (available > 0 ? pane.scrollTop / available : 0) * Math.max(0, other.scrollHeight - other.clientHeight)
    requestAnimationFrame(() => { syncing = false })
  }))
}

function appendMemoCard(block, key, memo, renderMarkdown, onDeleteMemo) {
  const card = document.createElement('aside'); card.className = 'article-memo'; card.dataset.memoId = memo.id
  const content = document.createElement('div'); content.innerHTML = renderMarkdown(memo.content || '')
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Delete memo')
  remove.addEventListener('click', () => { onDeleteMemo(key, memo.id); card.remove() })
  card.append(content, remove); block.insertAdjacentElement('afterend', card)
}

function restoreResources(root, annotations, memos, renderMarkdown, onDeleteMemo) {
  for (const [key, items] of Object.entries(annotations || {})) {
    if (!key.startsWith('section_')) continue
    for (const annotation of items || []) {
      const anchor = annotation.anchor; const block = anchor && root.querySelector(`[data-block-id="${CSS.escape(anchor.block_id)}"]`)
      const offsets = block && resolveTextAnchor(block.textContent || '', anchor); const range = offsets && rangeFromOffsets(block, offsets)
      if (range) markRange(range, annotation)
    }
  }
  for (const [key, items] of Object.entries(memos || {})) {
    if (!key.startsWith('section_')) continue
    for (const memo of items || []) {
      const block = memo.anchor && root.querySelector(`[data-block-id="${CSS.escape(memo.anchor.block_id)}"]`)
      if (!block) continue
      appendMemoCard(block, key, memo, renderMarkdown, onDeleteMemo)
    }
  }
}

export async function mountArticleViewer(options) {
  const { container, doc, manifest, sanitize, getTranslation, translationOptions, loadAnnotations, saveAnnotations, loadMemos, saveMemos, renderMarkdown, labels, onCurrentUnit, onOutline, onCapture } = options
  const root = document.createElement('article'); root.className = 'article-viewer'; root.style.setProperty('--article-zoom', '1')
  const toolbar = document.createElement('div'); toolbar.className = 'article-toolbar'
  toolbar.innerHTML = `<div class="article-tabs" role="tablist"><button type="button" class="active" data-tab="snapshot">${labels.snapshot}</button><button type="button" data-tab="original">${labels.original}</button></div><label class="article-search"><span>${labels.search}</span><input type="search" autocomplete="off"></label><button type="button" data-zoom="out" aria-label="${labels.zoomOut}">−</button><button type="button" data-zoom="in" aria-label="${labels.zoomIn}">+</button><button type="button" data-capture>${labels.capture}</button><a class="btn btn-secondary" target="_blank" rel="noopener noreferrer">${labels.openOriginal}</a>`
  toolbar.querySelector('a').href = manifest.source_url
  const snapshot = document.createElement('div'); snapshot.className = 'article-snapshot'
  const original = document.createElement('div'); original.className = 'article-original-site hidden'
  if (manifest.embed_allowed && new URL(manifest.source_url).protocol === 'https:') {
    const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts allow-forms allow-popups'; frame.referrerPolicy = 'no-referrer'; frame.title = labels.original; frame.src = manifest.source_url
    const fallback = document.createElement('p'); fallback.className = 'hidden'; fallback.textContent = labels.embedFailed
    const timer = setTimeout(() => fallback.classList.remove('hidden'), 8000); frame.addEventListener('load', () => clearTimeout(timer), { once: true }); original.append(frame, fallback)
  } else { const notice = document.createElement('p'); notice.textContent = labels.embedBlocked; original.appendChild(notice) }
  root.append(toolbar, snapshot, original)
  const blocks = new Map((manifest.blocks || []).map(block => [block.id, block]))
  for (const unit of manifest.units || []) {
    const pair = document.createElement('section'); pair.className = 'article-unit'; pair.id = unit.id; pair.dataset.unitId = unit.id; pair.dataset.unitIndex = unit.index
    const title = document.createElement('h2'); title.className = 'article-unit-title'; title.textContent = `${unit.index}. ${unit.title}`
    const source = document.createElement('div'); source.className = 'article-pane article-original'; source.innerHTML = sanitize(unit.block_ids.map(id => blocks.get(id)?.html || '').join(''))
    source.querySelectorAll('img[src^="assets/"]').forEach(image => { image.src = `/api/library/${encodeURIComponent(doc.id)}/article/${image.getAttribute('src')}` })
    const translation = document.createElement('div'); translation.className = 'article-pane article-translation'; translation.dataset.unitIndex = unit.index
    const cached = await getTranslation(unit.index); translation.textContent = cached?.translation || labels.translationPending
    pair.append(title, source, translation); snapshot.appendChild(pair); syncPanes(pair)
  }
  container.replaceChildren(root); onOutline(manifest.toc || [])
  const deleteMemo = (key, id) => { const all = loadMemos(); all[key] = (all[key] || []).filter(item => item.id !== id); saveMemos(all) }
  restoreResources(root, loadAnnotations(), loadMemos(), renderMarkdown, deleteMemo)

  const referencePreview = document.createElement('div'); referencePreview.className = 'article-reference-preview hidden'; document.body.appendChild(referencePreview)
  root.addEventListener('mouseover', event => {
    const link = event.target.closest('a[href]'); if (!link) return
    let parsed; try { parsed = new URL(link.href, manifest.source_url) } catch { return }
    if (parsed.hash) {
      const target = root.querySelector(`#${CSS.escape(parsed.hash.slice(1))}`)
      if (target) { referencePreview.replaceChildren(target.cloneNode(true)); referencePreview.classList.remove('hidden'); referencePreview.style.left = `${Math.min(event.clientX + 12, window.innerWidth - 380)}px`; referencePreview.style.top = `${Math.min(event.clientY + 12, window.innerHeight - 260)}px` }
    }
  })
  root.addEventListener('mouseout', event => { if (event.target.closest('a[href]')) referencePreview.classList.add('hidden') })
  root.addEventListener('click', event => { const link = event.target.closest('a[href]'); if (link && !link.hash) { link.target = '_blank'; link.rel = 'noopener noreferrer' } })

  const selectionTools = document.createElement('div'); selectionTools.className = 'article-selection-tools hidden'
  selectionTools.innerHTML = `<button type="button" data-action="highlight">${labels.highlight}</button><button type="button" data-action="underline">${labels.underline}</button><button type="button" data-action="memo">${labels.memo}</button>`; document.body.appendChild(selectionTools)
  root.addEventListener('mouseup', event => {
    event.stopPropagation()
    setTimeout(() => { const context = selectionContext(root); if (!context) { selectionTools.classList.add('hidden'); return }; selectionTools.classList.remove('hidden'); selectionTools.style.left = `${event.clientX}px`; selectionTools.style.top = `${event.clientY + 8}px` }, 0)
  })
  selectionTools.addEventListener('mousedown', event => event.preventDefault())
  selectionTools.addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action; const context = selectionContext(root); if (!action || !context) return
    const key = `section_${context.unitIndex}`
    if (action === 'memo') {
      const content = window.prompt(labels.memoPrompt)
      if (content?.trim()) {
        const all = loadMemos(); all[key] ||= []
        const memo = { id: crypto.randomUUID(), content: content.trim(), sentenceText: context.anchor.exact, anchor: context.anchor, createdAt: new Date().toISOString() }
        all[key].push(memo); saveMemos(all); appendMemoCard(context.block, key, memo, renderMarkdown, deleteMemo)
      }
    } else {
      const all = loadAnnotations(); all[key] ||= []; const annotation = { id: crypto.randomUUID(), type: action, text: context.anchor.exact, color: action === 'highlight' ? '#eab308' : '#ef4444', anchor: context.anchor, createdAt: new Date().toISOString() }; all[key].push(annotation); saveAnnotations(all); markRange(context.range, annotation)
    }
    selectionTools.classList.add('hidden'); window.getSelection()?.removeAllRanges()
  })

  let zoom = 1
  toolbar.addEventListener('click', event => {
    const tab = event.target.closest('[data-tab]')?.dataset.tab
    if (tab) { toolbar.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab)); snapshot.classList.toggle('hidden', tab !== 'snapshot'); original.classList.toggle('hidden', tab !== 'original') }
    const direction = event.target.closest('[data-zoom]')?.dataset.zoom
    if (direction) { zoom = Math.min(1.8, Math.max(.7, zoom + (direction === 'in' ? .1 : -.1))); root.style.setProperty('--article-zoom', String(zoom)) }
    if (event.target.closest('[data-capture]')) {
      const unit = root.querySelector(`.article-unit[data-unit-index="${currentUnit}"]`) || root.querySelector('.article-unit')
      if (unit) import('html2canvas').then(({ default: html2canvas }) => html2canvas(unit, { backgroundColor: '#ffffff', useCORS: true, scale: Math.min(2, window.devicePixelRatio || 1) })).then(canvas => onCapture(canvas.toDataURL('image/png'), currentUnit)).catch(() => {})
    }
  })
  toolbar.querySelector('input').addEventListener('input', event => {
    const query = event.target.value.trim().toLocaleLowerCase(); root.querySelectorAll('.article-search-hit').forEach(node => node.classList.remove('article-search-hit'))
    if (!query) return
    root.querySelectorAll('[data-block-id]').forEach(block => { if ((block.textContent || '').toLocaleLowerCase().includes(query)) block.classList.add('article-search-hit') }); root.querySelector('.article-search-hit')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
  let currentUnit = 1
  const observer = new IntersectionObserver(entries => { const visible = entries.filter(entry => entry.isIntersecting).sort((a,b) => b.intersectionRatio-a.intersectionRatio)[0]; if (visible) { currentUnit = Number(visible.target.dataset.unitIndex); onCurrentUnit(currentUnit) } }, { root: container, threshold: [.25,.5,.75] })
  root.querySelectorAll('.article-unit').forEach(unit => observer.observe(unit))
  const timer = setInterval(async () => { for (const pane of root.querySelectorAll('.article-translation')) { const data = await getTranslation(Number(pane.dataset.unitIndex)); if (data?.translation && pane.textContent !== data.translation) pane.textContent = data.translation } }, 3000)
  return { root, destroy() { clearInterval(timer); observer.disconnect(); selectionTools.remove(); referencePreview.remove() } }
}
