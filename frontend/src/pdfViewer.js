import { projectSourceRects, sourceMappingMatchesRevision, mergePdfSentenceLineRects } from './pdfSentenceGeometry.js'
/**
 * PDF.js 기반 연속 스크롤 뷰어
 * - 모든 페이지를 세로로 쌓아 스크롤
 * - 텍스트 레이어로 드래그 선택 지원
 * - IntersectionObserver 기반 lazy 렌더링
 */

import { alignTextLayer, collectTextContent, recoveredTextContent } from './pdfTextLayer.js'
import { pdfResources } from './pdfResources.js'
import {
  drawCachedPageToCanvas,
  scheduleStoreRenderedPageCanvas,
  getCachedDocDimensions,
  setCachedDocDimensions,
  clearDocumentPageCache,
} from './pdfPageCache.js'
import { t } from './i18n.js'

import './pdfCompatibility.js'
import pdfWorkerUrl from './pdfWorker.js?worker&url'

let pdfjsLib = null
let pdfDoc = null
let currentDocId = null
let widestPageWidth = 0
let pageDimensions = new Map()
let pdfLoadingTask = null
let pdfTextUrl = null
const pdfTextRecoveryCache = new Map()
const pdfNativeTextContentCache = new Map()
const renderedTextLayers = new Map()
let currentScale = 1.5
let pageObserver = null
let pageVisibilityObserver = null
let visiblePageHeights = {}
let loadGeneration = 0
let disposeScrollView = () => {}
let suspended = false
let lastScrollView = null
// renderScrollView가 호출될 때마다(문서 전환, 줌 변경) 증가하는 세대 카운터.
// pdf-page-wrapper DOM 노드는 문서를 바꿔도 새로 만들지 않고 재사용하는데,
// 이전 문서/줌에 대한 _renderPage 호출이 비동기 대기 중일 때 사용자가 빠르게
// 다른 문서를 열면, 그 이전 렌더링이 뒤늦게 끝나면서 이미 새 문서용으로
// 재사용된 wrapper에 옛 canvas/textLayer를 덮어써버리는 경쟁 조건이 있었다.
// 각 _renderPage 호출이 시작 시점의 세대를 기억해뒀다가, DOM을 건드리기 전에
// 현재 세대와 비교해서 다르면(그 사이 새로 renderScrollView가 호출됐다면)
// 조용히 중단한다.
let renderGeneration = 0
let scrollSettleTimer = null
let activeScrolling = false
let scrollSettleListeners = new Set()

function markScrollingActive() {
  activeScrolling = true
  if (scrollSettleTimer !== null) clearTimeout(scrollSettleTimer)
  scrollSettleTimer = setTimeout(() => {
    scrollSettleTimer = null
    activeScrolling = false
    const listeners = [...scrollSettleListeners]
    scrollSettleListeners.clear()
    for (const fn of listeners) fn()
  }, 150)
}

function waitForScrollSettleOrImmediate(isUrgent, signal) {
  if (isUrgent || !activeScrolling) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => {
      scrollSettleListeners.delete(done)
      resolve()
    }
    scrollSettleListeners.add(done)
    signal?.addEventListener('abort', done, { once: true })
  })
}

// Desktop WebViews can lag behind browser releases. Use the matching
// compatibility builds for both the main module and its worker.
async function loadPDFJS() {
  if (pdfjsLib) return pdfjsLib
  pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  return pdfjsLib
}

export async function loadPDF(url, onProgress) {
  await loadPDFJS()
  const myGeneration = ++loadGeneration
  // WebKit은 파괴된 worker의 진행 중인 렌더를 즉시 reject할 수 있다.
  // 새 문서가 로드되기 시작한 시점부터 기존 렌더를 오래된 작업으로 표시해
  // 정상적인 취소가 페이지 오류나 콘솔 오류로 노출되지 않게 한다.
  renderGeneration++
  disposeScrollView()
  const previousLoadingTask = pdfLoadingTask
  const loadingTask = pdfjsLib.getDocument({ url, ...pdfResources })
  loadingTask.onProgress = progress => {
    if (myGeneration === loadGeneration) onProgress?.(progress)
  }
  pdfLoadingTask = loadingTask

  if (previousLoadingTask && previousLoadingTask !== loadingTask) {
    previousLoadingTask.destroy().catch(() => {})
  }

  let nextPdfDoc
  try {
    nextPdfDoc = await loadingTask.promise
  } catch (error) {
    if (myGeneration !== loadGeneration) return null
    throw error
  }
  if (myGeneration !== loadGeneration) {
    await loadingTask.destroy().catch(() => {})
    return null
  }
  renderGeneration++
  pdfDoc = nextPdfDoc
  widestPageWidth = 0
  const match = String(url).match(/\/api\/(?:pdf-file\/([^/?]+)|library\/([^/?]+)\/pdf)(?:\?|$)/)
  currentDocId = match ? (match[1] || match[2]) : null
  const cachedDims = currentDocId ? getCachedDocDimensions(currentDocId) : null
  pageDimensions = cachedDims || new Map()
  if (cachedDims && cachedDims.size > 0) {
    let maxW = 0
    for (const dim of cachedDims.values()) {
      if (dim.width > maxW) maxW = dim.width
    }
    widestPageWidth = maxW
  }
  pdfTextUrl = currentDocId ? `/api/pdf-text/${currentDocId}` : null
  pdfTextRecoveryCache.clear()
  pdfNativeTextContentCache.clear()
  figureCropCache.clear()
  return pdfDoc.numPages
}

// pageNum이 현재 화면에 렌더링되어 있지 않아도(가상 스크롤로 아직 마운트 전이거나
// 이미 스크롤을 벗어나 언마운트됐어도) 크롭할 수 있도록, DOM의 canvas에 의존하지
// 않고 pdfDoc에서 직접 해당 페이지를 오프스크린 캔버스로 렌더링해 크롭한다.
// 문서 어디서든 본문이 "Figure 1"을 언급하면 그 그림이 실제로는 다른 페이지에
// 있을 수 있기 때문에 필요하다. 같은 좌표를 반복 호버할 때 매번 다시 렌더링하지
// 않도록 결과를 캐싱한다(문서를 새로 열면 loadPDF에서 캐시를 비운다).
const figureCropCache = new Map()

export async function renderFigureCrop(pageNum, imgPercent) {
  if (!pdfDoc) return null
  const cacheKey = `${pageNum}:${imgPercent.left}:${imgPercent.top}:${imgPercent.width}:${imgPercent.height}`
  if (figureCropCache.has(cacheKey)) return figureCropCache.get(cacheKey)

  try {
    const page = await pdfDoc.getPage(pageNum)
    const viewport = page.getViewport({ scale: 2.5 })

    const pageCanvas = document.createElement('canvas')
    pageCanvas.width = Math.floor(viewport.width)
    pageCanvas.height = Math.floor(viewport.height)
    await page.render({ canvasContext: pageCanvas.getContext('2d'), viewport }).promise

    const leftPx   = (imgPercent.left   / 100) * pageCanvas.width
    const topPx    = (imgPercent.top    / 100) * pageCanvas.height
    const widthPx  = (imgPercent.width  / 100) * pageCanvas.width
    const heightPx = (imgPercent.height / 100) * pageCanvas.height

    const cropCanvas = document.createElement('canvas')
    cropCanvas.width = widthPx
    cropCanvas.height = heightPx
    cropCanvas.getContext('2d').drawImage(
      pageCanvas, leftPx, topPx, widthPx, heightPx, 0, 0, widthPx, heightPx
    )

    const dataUrl = cropCanvas.toDataURL('image/png')
    figureCropCache.set(cacheKey, dataUrl)
    return dataUrl
  } catch (e) {
    console.error(`Figure crop render failed p.${pageNum}:`, e)
    return null
  }
}

// A bounded, uncached snapshot: arbitrary user regions must not fill the figure cache.
export async function renderPinnedCapture(pageNum, region) {
  const source = pdfDoc
  if (!source) throw new Error('No PDF loaded')
  const page = await source.getPage(pageNum)
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(2.5, 4096 / base.width, 4096 / base.height,
    Math.sqrt(8_000_000 / (base.width * base.height)))
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  const crop = document.createElement('canvas')
  try {
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    if (source !== pdfDoc) throw new Error('Document changed')
    crop.width = Math.max(1, Math.round(region.width * canvas.width))
    crop.height = Math.max(1, Math.round(region.height * canvas.height))
    crop.getContext('2d').drawImage(canvas,
      region.left * canvas.width, region.top * canvas.height,
      region.width * canvas.width, region.height * canvas.height,
      0, 0, crop.width, crop.height)
    return await new Promise((resolve, reject) => crop.toBlob(blob =>
      blob ? resolve(blob) : reject(new Error('Capture encoding failed')), 'image/png'))
  } finally {
    canvas.width = canvas.height = 0
    crop.width = crop.height = 0
  }
}

/**
 * 연속 스크롤 뷰어 초기화
 * @param {HTMLElement} container  - 스크롤 컨테이너 (#pdf-scroll-container)
 * @param {number}      zoom       - 초기 배율
 * @param {Object}      callbacks
 *   onPageVisible(pageNum)  - 페이지가 뷰포트에 들어올 때마다 호출
 */
export async function renderScrollView(container, zoom, { onPageVisible, preserveCanvas = false } = {}) {
  lastScrollView = { container, zoom, onPageVisible }
  if (!pdfDoc || suspended) return
  disposeScrollView(preserveCanvas)
  currentScale = zoom
  renderedTextLayers.clear()
  renderGeneration++
  const myGeneration = renderGeneration

  if (pageObserver) { pageObserver.disconnect(); pageObserver = null }

  const numPages = pdfDoc.numPages
  const jobs = new Map()
  const nearby = new Set()
  const queue = new Map()
  let active = 0
  let pumpTimer = null
  let reconcileFrame = null
  let renderTargets = []
  let resizeObserver
  let currentPage = 1
  let renderPriorityPage = 1
  let lastNotifiedPage = null
  const isCurrent = () => myGeneration === renderGeneration

  function release(job, preserveCanvas = false) {
    job.cancelled = true
    job.controller.abort()
    job.renderTask?.cancel()
    job.textLayer?.cancel()
    // Release PDF.js operator/image caches as well as the DOM canvas.
    // cleanup() defers while a render is active; retry when cancellation settles.
    job.page?.cleanup()
    renderedTextLayers.delete(job.pageNum)
    // Keep the measured footprint so evicting a page cannot move the scrollbar.
    const inner = job.wrapper.querySelector('.pdf-page-inner')
    if (inner) {
      window.onTextLayerReleased?.(inner.querySelector('.textLayer'), job.pageNum)
      const retained = preserveCanvas ? inner.querySelector('canvas[data-rendered]') : null
      inner.querySelectorAll('canvas').forEach(canvas => {
        if (canvas !== retained) { canvas.width = 0; canvas.height = 0 }
      })
      inner.replaceChildren(...(retained ? [retained] : []))
    }
    jobs.delete(job.pageNum)
  }

  const isLargeDocument = numPages > 48
  const preRenderRadius = isLargeDocument ? 15 : numPages
  const maxRetainedPages = isLargeDocument ? 250 : numPages
  const eagerRenderAll = !isLargeDocument
  let initialPageReadyResolve = null
  const initialPageReadyPromise = new Promise(resolve => {
    initialPageReadyResolve = resolve
  })
  const markInitialPageReady = () => {
    if (initialPageReadyResolve) {
      const resolve = initialPageReadyResolve
      initialPageReadyResolve = null
      resolve()
    }
  }
  setTimeout(markInitialPageReady, 1500)

  function releaseTextLayerOnly(job) {
    if (!job || !job.textLayerMounted) return
    job.textLayer?.cancel()
    job.textLayer = null
    job.textLayerMounted = false
    renderedTextLayers.delete(job.pageNum)
    const inner = job.wrapper.querySelector('.pdf-page-inner')
    if (inner) {
      const tl = inner.querySelector('.textLayer')
      if (tl) {
        window.onTextLayerReleased?.(tl, job.pageNum)
        tl.replaceChildren()
        delete tl.dataset.segmented
      }
      inner.querySelector('.pdf-highlight-overlay')?.remove()
      inner.querySelector('.pdf-image-overlay-layer')?.remove()
      inner.querySelector('.pdf-citation-overlay-layer')?.remove()
      inner.querySelector('.pdf-figure-ref-overlay-layer')?.remove()
    }
  }

  function downgradeCanvasTo1x(job) {
    if (!job || !job.hiResRendered || !job.viewport) return
    const inner = job.wrapper.querySelector('.pdf-page-inner')
    const currentCanvas = inner?.querySelector('canvas[data-rendered]')
    if (!currentCanvas) return
    const w1x = Math.floor(job.viewport.width)
    const h1x = Math.floor(job.viewport.height)
    if (currentCanvas.width <= w1x && currentCanvas.height <= h1x) {
      job.hiResRendered = false
      job.needsHiResUpgrade = (job.dpr || 1) > 1.15
      return
    }
    try {
      const downscaled = document.createElement('canvas')
      downscaled.width = w1x
      downscaled.height = h1x
      downscaled.style.width = `${job.viewport.width}px`
      downscaled.style.height = `${job.viewport.height}px`
      downscaled.dataset.rendered = 'true'
      const ctx = downscaled.getContext('2d')
      if (ctx) {
        ctx.drawImage(currentCanvas, 0, 0, w1x, h1x)
        inner.replaceChild(downscaled, currentCanvas)
        currentCanvas.width = 0
        currentCanvas.height = 0
        job.hiResRendered = false
        job.needsHiResUpgrade = (job.dpr || 1) > 1.15
      }
    } catch {}
  }

  function trimPages() {
    const selection = window.getSelection()
    if (isLargeDocument) {
      // Only cancel in-flight canvas renders if the user jumped far away (beyond the
      // ±15 page pre-render window), so background pre-rendering around the current page
      // completes without interruption!
      for (const job of jobs.values()) {
        if (!job.canvasRendered && Math.abs(job.pageNum - renderPriorityPage) > preRenderRadius) {
          release(job)
        }
      }
      // In textbook-sized documents, strip heavy textLayer/overlay DOM (thousands of spans)
      // from pages that are more than 3 pages away from the current reading position,
      // and downgrade off-screen Retina (2x) canvases to 1x to save 75% VRAM while keeping
      // the rendered <canvas> bitmap alive across the session (up to 250 pages)!
      for (const job of jobs.values()) {
        if (!job.done) continue
        const dist = Math.abs(job.pageNum - renderPriorityPage)
        if (job.hiResRendered && dist > 2) {
          downgradeCanvasTo1x(job)
        }
        if (!job.textLayerMounted || dist <= 3) continue
        if (job.wrapper.contains(document.activeElement)) continue
        if (selection?.rangeCount && !selection.isCollapsed && selection.getRangeAt(0).intersectsNode(job.wrapper)) continue
        const hasMemos = Boolean(job.wrapper.querySelector('.floating-memo'))
        if (hasMemos) continue
        releaseTextLayerOnly(job)
      }
    }
    if (eagerRenderAll) return
    const candidates = [...jobs.values()]
      .filter(job => Math.abs(job.pageNum - renderPriorityPage) > preRenderRadius && !nearby.has(job.pageNum) && !job.wrapper.contains(document.activeElement) && !(
        selection?.rangeCount && !selection.isCollapsed
        && selection.getRangeAt(0).intersectsNode(job.wrapper)
      ))
      .sort((a, b) => Math.abs(b.pageNum - renderPriorityPage) - Math.abs(a.pageNum - renderPriorityPage))
    for (const job of candidates) {
      if (jobs.size <= maxRetainedPages && job.done) continue
      release(job)
    }
  }

  function scheduleRender() {
    if (pumpTimer !== null || !isCurrent()) return
    // Yield between pages, leaving input/scroll events a chance to run.
    const maxConcurrent = isLargeDocument ? 3 : 2
    pumpTimer = setTimeout(() => {
      pumpTimer = null
      if (!isCurrent()) return
      while (active < maxConcurrent && queue.size) {
        const pageNum = [...queue.keys()].sort((a, b) => {
          const aNear = nearby.has(a) ? 0 : 1
          const bNear = nearby.has(b) ? 0 : 1
          if (aNear !== bNear) return aNear - bNear
          const da = Math.abs(a - renderPriorityPage)
          const db = Math.abs(b - renderPriorityPage)
          if (da !== db) return da - db
          // Prefer forward reading direction (+1 before -1)
          return (a >= renderPriorityPage ? 0 : 1) - (b >= renderPriorityPage ? 0 : 1)
        })[0]
        const wrapper = queue.get(pageNum)
        queue.delete(pageNum)
        const withinPreRenderWindow = Math.abs(pageNum - renderPriorityPage) <= preRenderRadius
        if ((!eagerRenderAll && !nearby.has(pageNum) && !withinPreRenderWindow) || jobs.has(pageNum)) continue
        const job = { wrapper, pageNum, controller: new AbortController(), cancelled: false, done: false, textLayerMounted: false }
        jobs.set(pageNum, job)
        active++
        _renderPage(wrapper, pageNum, myGeneration, job, {
          isLargeDocument,
          isPriorityPage: () => Math.abs(pageNum - renderPriorityPage) <= 3,
          isImmediateVisiblePage: () => Math.abs(pageNum - renderPriorityPage) <= 1,
          onCanvasReady: () => {
            if (Math.abs(pageNum - renderPriorityPage) <= 1) markInitialPageReady()
          },
        }).finally(() => {
          active--
          job.done = true
          if (job.cancelled) job.page?.cleanup()
          if (!isCurrent()) return
          trimPages()
          if (queue.size) scheduleRender()
        })
      }
    }, 0)
  }

  // Intersection notifications can lag behind instant jumps and fit/zoom layout
  // changes (especially in WebKit). Reconcile from current geometry as well.
  // Binary search keeps long PDFs from measuring every page on each scroll.
  function reconcileRenderWindow() {
    reconcileFrame = null
    if (!isCurrent() || !renderTargets.length) return
    const viewport = container.getBoundingClientRect()
    if (!viewport.height) return
    const top = viewport.top - 2400
    const bottom = viewport.bottom + 2400
    let low = 0
    let high = renderTargets.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (renderTargets[middle].getBoundingClientRect().bottom < top) low = middle + 1
      else high = middle
    }
    const next = new Set()
    let firstVisible = null
    for (let index = low; index < renderTargets.length; index++) {
      const target = renderTargets[index]
      const rect = target.getBoundingClientRect()
      if (rect.top > bottom) break
      if (firstVisible === null && rect.bottom > viewport.top && rect.top < viewport.bottom) firstVisible = Number(target.dataset.page)
      const pageNum = Number(target.dataset.page)
      next.add(pageNum)
      if (!jobs.has(pageNum)) {
        const wrapperEl = target.matches('.pdf-page-wrapper') ? target : target.querySelector('.pdf-page-wrapper')
        if (wrapperEl && !wrapperEl.querySelector('canvas[data-rendered]')) {
          wrapperEl.querySelector('.pdf-page-inner')?.replaceChildren()
        }
        queue.set(pageNum, wrapperEl)
      } else if (isLargeDocument) {
        const existingJob = jobs.get(pageNum)
        const distFromVisible = Math.abs(pageNum - (firstVisible ?? currentPage))
        if (existingJob && existingJob.done && distFromVisible <= 3) {
          if (distFromVisible <= 1 && existingJob.needsHiResUpgrade && !existingJob.upgradingHiRes) {
            existingJob.upgradingHiRes = true
            _upgradeDeferredHiResCanvas(existingJob, myGeneration).finally(() => {
              existingJob.upgradingHiRes = false
            })
          }
          if (!existingJob.textLayerMounted && !existingJob.mountingTextLayer) {
            existingJob.mountingTextLayer = true
            _mountDeferredTextLayer(existingJob, myGeneration).finally(() => {
              existingJob.mountingTextLayer = false
            })
          }
        }
      }
    }
    renderPriorityPage = firstVisible ?? currentPage
    nearby.clear()
    next.forEach(pageNum => nearby.add(pageNum))
    if (eagerRenderAll) {
      for (let i = 0; i < renderTargets.length; i++) {
        const target = renderTargets[i]
        const pageNum = Number(target.dataset.page)
        if (!jobs.has(pageNum) && !queue.has(pageNum)) {
          queue.set(pageNum, target.matches('.pdf-page-wrapper') ? target : target.querySelector('.pdf-page-wrapper'))
        }
      }
    } else {
      // Pre-render ±preRenderRadius (±15 pages) outward from renderPriorityPage so
      // scrolling up or down through a textbook finds pages already rendered!
      const minPage = Math.max(1, renderPriorityPage - preRenderRadius)
      const maxPage = Math.min(numPages, renderPriorityPage + preRenderRadius)
      for (let pageNum = minPage; pageNum <= maxPage; pageNum++) {
        nearby.add(pageNum)
        if (!jobs.has(pageNum) && !queue.has(pageNum)) {
          const target = renderTargets[pageNum - 1]
          if (target) {
            queue.set(pageNum, target.matches('.pdf-page-wrapper') ? target : target.querySelector('.pdf-page-wrapper'))
          }
        }
      }
      for (const pageNum of queue.keys()) {
        if (!nearby.has(pageNum) && Math.abs(pageNum - renderPriorityPage) > preRenderRadius) {
          queue.delete(pageNum)
        }
      }
    }
    trimPages()
    scheduleRender()
  }
  function requestReconcile() {
    markScrollingActive()
    if (reconcileFrame === null && isCurrent()) reconcileFrame = requestAnimationFrame(reconcileRenderWindow)
  }

  disposeScrollView = (preserveCanvas = false) => {
    pageObserver?.disconnect()
    pageVisibilityObserver?.disconnect()
    clearTimeout(pumpTimer)
    cancelAnimationFrame(reconcileFrame)
    container.removeEventListener('scroll', requestReconcile)
    resizeObserver?.disconnect()
    queue.clear()
    for (const job of jobs.values()) release(job, preserveCanvas)
    // Also release retained pages that have not entered the new render queue.
    if (!preserveCanvas) {
      container.querySelectorAll('.pdf-page-inner canvas').forEach(canvas => {
        canvas.width = 0
        canvas.height = 0
        canvas.remove()
      })
    }
  }

  // Reserve each page's real dimensions before restoring a saved position.
  // If localStorage already has page 1's dimensions for this document, compute all
  // viewports synchronously in 0ms without awaiting any PDF.js worker getPage() calls!
  // On first-ever open of a large document (>32 pages), measure only page 1 immediately
  // so first screen paint is not delayed by 8 sequential worker round-trips.
  const renderingDoc = pdfDoc
  let viewports
  try {
    const dimensions = pageDimensions
    viewports = []
    let dimensionsChanged = false
    const hasCachedPrimaryDim = dimensions.has(1)
    const sampleLimit = hasCachedPrimaryDim
      ? 0
      : (numPages > 32 ? 1 : numPages)
    for (let start = 1; start <= sampleLimit; start += 16) {
      if (!isCurrent()) return
      let requested = false
      const batch = await Promise.all(Array.from({ length: Math.min(16, sampleLimit - start + 1) }, async (_, index) => {
        const pageNum = start + index
        if (!dimensions.has(pageNum)) {
          requested = true
          const page = await renderingDoc.getPage(pageNum)
          const { width, height } = page.getViewport({ scale: 1 })
          dimensions.set(pageNum, { width, height })
          dimensionsChanged = true
        }
        const { width, height } = dimensions.get(pageNum)
        return { width: width * zoom, height: height * zoom }
      }))
      viewports.push(...batch)
      if (requested && start + 16 <= sampleLimit) await new Promise(resolve => setTimeout(resolve, 0))
    }
    if (numPages > sampleLimit) {
      const fallbackDim = dimensions.get(1) || { width: 595, height: 841 }
      for (let pageNum = sampleLimit + 1; pageNum <= numPages; pageNum++) {
        const dim = dimensions.get(pageNum) || fallbackDim
        viewports.push({ width: dim.width * zoom, height: dim.height * zoom })
      }
    }
    if (dimensionsChanged && currentDocId) {
      setCachedDocDimensions(currentDocId, dimensions)
    }
  } catch (error) {
    if (!isCurrent()) return
    throw error
  }
  if (!isCurrent()) return

  widestPageWidth = viewports.reduce((maximum, viewport) => Math.max(maximum, viewport.width / zoom), 0)
  let wrappers = container.querySelectorAll('.pdf-page-wrapper')

  const wrapperShapeMatches = wrappers.length === numPages
    && Array.from(wrappers).every((wrapper, index) => Number(wrapper.dataset.page) === index + 1)
  if (!wrapperShapeMatches) {
    container.querySelectorAll('.pdf-page-wrapper').forEach(wrapper => wrapper.remove())
    wrappers = container.querySelectorAll('.pdf-page-wrapper')
  }

  if (wrappers.length === 0) {
    // ─── placeholder 생성 (기존에 없는 경우만) ───────────────────────────
    for (let i = 1; i <= numPages; i++) {
      const wrapper = document.createElement('div')
      wrapper.className = 'pdf-page-wrapper'
      wrapper.dataset.page = i

      const inner = document.createElement('div')
      inner.className = 'pdf-page-inner'
      wrapper.appendChild(inner)
      container.appendChild(wrapper)
    }
    wrappers = container.querySelectorAll('.pdf-page-wrapper')
  }

  wrappers.forEach((wrapper, index) => {
    const { width, height } = viewports[index]
    wrapper.style.minHeight = `${height}px`
    const inner = wrapper.querySelector('.pdf-page-inner')
    const retained = preserveCanvas ? inner.querySelector('canvas[data-rendered]') : null
    inner.replaceChildren(...(retained ? [retained] : []))
    if (retained) {
      retained.style.width = `${width}px`
      retained.style.height = `${height}px`
    }
    inner.style.boxSizing = 'content-box'
    inner.style.width = `${width}px`
    inner.style.height = `${height}px`
    const transBlock = wrapper.parentElement?.querySelector('.trans-page-block')
    if (transBlock) transBlock.style.height = `${Math.floor(height)}px`
  })

  if (pageVisibilityObserver) { pageVisibilityObserver.disconnect(); pageVisibilityObserver = null }
  visiblePageHeights = {}

  // ─── IntersectionObserver (페이지 렌더링용: 미리 2400px 앞서 로딩) ───
  pageObserver = new IntersectionObserver((entries) => {
    if (!isCurrent()) return
    entries.forEach(entry => {
      const pageNum = parseInt(entry.target.dataset.page)
      if (entry.isIntersecting) {
        nearby.add(pageNum)
        if (!jobs.has(pageNum)) queue.set(pageNum, entry.target.matches('.pdf-page-wrapper') ? entry.target : entry.target.querySelector('.pdf-page-wrapper'))
      } else {
        nearby.delete(pageNum)
        if (!eagerRenderAll) {
          queue.delete(pageNum)
        }
      }
    })
    reconcileRenderWindow()
  }, {
    root: container,
    rootMargin: '2400px 0px',
    threshold: 0.01,
  })

  // ─── IntersectionObserver (현재 보고 있는 페이지 추적용: 마진 없이 실시간 감지) ───
  pageVisibilityObserver = new IntersectionObserver((entries) => {
    if (!isCurrent()) return
    entries.forEach(entry => {
      const pageNum = parseInt(entry.target.dataset.page)
      if (entry.isIntersecting) {
        visiblePageHeights[pageNum] = entry.intersectionRect.height
      } else {
        delete visiblePageHeights[pageNum]
      }
    })

    // Track the first page entering from the top of the reader. A taller next
    // page can occupy more pixels than a short page even while the short page
    // remains anchored at the top (for example, mixed-size PDFs).
    const viewportTop = container.getBoundingClientRect().top
    let currentPageNum = -1
    let currentPageTop = Infinity
    for (const page of Object.keys(visiblePageHeights)) {
      const pageNum = Number(page)
      const element = renderTargets[pageNum - 1]
      if (!element) continue
      const rect = element.getBoundingClientRect()
      if (rect.bottom <= viewportTop || rect.top >= currentPageTop) continue
      currentPageTop = rect.top
      currentPageNum = pageNum
    }

    if (currentPageNum !== -1 && currentPageNum !== lastNotifiedPage) {
      currentPage = currentPageNum
      lastNotifiedPage = currentPageNum
      onPageVisible?.(currentPageNum)
    }
  }, {
    root: container,
    rootMargin: '0px 0px',
    threshold: [0.0, 0.25, 0.5],
  })

  renderTargets = Array.from(wrappers, wrapper => wrapper.closest('.page-pair') || wrapper)
  container.addEventListener('scroll', requestReconcile, { passive: true })
  resizeObserver = new ResizeObserver(requestReconcile)
  resizeObserver.observe(container)
  requestReconcile()
  wrappers.forEach(w => {
    // Margin memos may extend below or beside the PDF itself. Keep the page
    // alive while any part of its reading row is in the render window.
    pageObserver.observe(w.closest('.page-pair') || w)
    pageVisibilityObserver.observe(w.closest('.page-pair') || w)
  })
  await initialPageReadyPromise
}

async function _mountDeferredTextLayer(job, generation) {
  const stale = () => generation !== renderGeneration || job.cancelled
  if (stale() || job.textLayerMounted || !job.page || !job.viewport || !job.textLayerDiv) return
  const { pageNum, page, viewport, textLayerDiv, wrapper } = job
  const inner = wrapper.querySelector('.pdf-page-inner')
  if (!inner) return
  const textUrl = pdfTextUrl
  try {
    let textContent
    let recovery
    if (textUrl) {
      if (pdfTextRecoveryCache.has(pageNum)) {
        recovery = pdfTextRecoveryCache.get(pageNum)
      } else {
        try {
          const response = await fetch(`${textUrl}/${pageNum}?nonblocking=true`, { signal: job.controller.signal })
          if (!response.ok) throw new Error(`PDF text recovery: HTTP ${response.status}`)
          recovery = await response.json()
          if (recovery && !recovery.pending) {
            pdfTextRecoveryCache.set(pageNum, recovery)
          }
        } catch (error) {
          if (stale()) return
          console.warn(`PDF text recovery p.${pageNum}; using native text:`, error)
          textLayerDiv.dataset.recoveryError = 'parser_unavailable'
        }
        if (stale()) return
      }
    }
    textLayerDiv.dataset.sourceRevision = recovery?.layout?.layout_revision || recovery?.layout?.source_revision || ''
    if (recovery?.layout?.needs_review) {
      const notice = document.createElement('div')
      notice.className = 'pdf-text-recovery-notice'
      notice.setAttribute('role', 'status')
      notice.textContent = t('errors:pdf_reading_order_review')
      inner.appendChild(notice)
    }
    if (recovery?.recovery) {
      textContent = recoveredTextContent(recovery.spans || [], viewport)
      textLayerDiv.dataset.recovery = recovery.recovery
      if (recovery.error) {
        textLayerDiv.dataset.recoveryError = recovery.error
        const notice = document.createElement('div')
        notice.className = 'pdf-text-recovery-notice'
        notice.setAttribute('role', 'status')
        notice.textContent = t(`errors:${recovery.error}`)
        inner.appendChild(notice)
      }
    } else if (pdfNativeTextContentCache.has(pageNum)) {
      textContent = pdfNativeTextContentCache.get(pageNum)
    } else {
      try {
        textContent = await page.getTextContent()
      } catch (error) {
        console.warn('getTextContent failed, trying streamTextContent:', error)
        textContent = await collectTextContent(page.streamTextContent())
      }
      if (textContent) pdfNativeTextContentCache.set(pageNum, textContent)
    }
    if (stale()) return
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport,
    })
    job.textLayer = textLayer
    await textLayer.render()
    textLayerDiv.style.width = `${viewport.rawDims.pageWidth * viewport.scale * viewport.userUnit}px`
    textLayerDiv.style.height = `${viewport.rawDims.pageHeight * viewport.scale * viewport.userUnit}px`
    if (stale()) return
    alignTextLayer(textLayer, textContent, viewport, textLayerDiv)
    job.textLayerMounted = true
    renderedTextLayers.set(pageNum, { textLayer, textContent, viewport, container: textLayerDiv, generation })

    if (!stale() && window.onTextLayerRendered) {
      window.onTextLayerRendered(textLayerDiv, pageNum)
    }
  } catch (e) {
    if (stale()) return
    console.warn(`TextLayer p.${pageNum}:`, e.message)
  }
}

async function _upgradeDeferredHiResCanvas(job, generation) {
  const stale = () => generation !== renderGeneration || job.cancelled
  if (stale() || !job.needsHiResUpgrade || !job.renderCanvasAtScale || !job.dpr) return
  const inner = job.wrapper?.querySelector('.pdf-page-inner')
  if (!inner) return
  try {
    const hiResCanvas = document.createElement('canvas')
    const hiOk = await job.renderCanvasAtScale(hiResCanvas, job.dpr)
    if (!hiOk || stale()) {
      hiResCanvas.width = 0
      hiResCanvas.height = 0
      return
    }
    hiResCanvas.dataset.rendered = 'true'
    const currentCanvas = inner.querySelector('canvas[data-rendered]')
    if (currentCanvas && currentCanvas.parentNode === inner) {
      inner.replaceChild(hiResCanvas, currentCanvas)
      currentCanvas.width = 0
      currentCanvas.height = 0
    }
    job.needsHiResUpgrade = false
    job.hiResRendered = true
  } catch {}
}

async function _renderPage(wrapper, pageNum, generation, job, { isLargeDocument = false, isPriorityPage = () => true, isImmediateVisiblePage = () => true, onCanvasReady } = {}) {
  const stale = () => generation !== renderGeneration || job.cancelled
  if (stale()) return
  const inner = wrapper.querySelector('.pdf-page-inner')
  const docId = currentDocId
  // Paint offscreen; the previous bitmap remains visible until replacement.
  try {
    const dpr = window.devicePixelRatio || 1
    const useTwoStagePreview = isLargeDocument && dpr > 1.15
    const firstPassRatio = useTwoStagePreview ? 1 : dpr
    const cachedDim = pageDimensions.get(pageNum) || pageDimensions.get(1)
    let earlyCacheRendered = false
    let canvas = null
    let textLayerDiv = null

    // Fast path: if we know the page dimensions and have a cached bitmap in L1/IndexedDB,
    // draw and mount the cached canvas BEFORE awaiting pdfDoc.getPage(pageNum) from the worker!
    if (docId && cachedDim) {
      const estWidth = cachedDim.width * currentScale
      const estHeight = cachedDim.height * currentScale
      const targetPixelW = Math.floor(estWidth * firstPassRatio)
      const targetPixelH = Math.floor(estHeight * firstPassRatio)
      const fastCanvas = document.createElement('canvas')
      fastCanvas.style.width = `${estWidth}px`
      fastCanvas.style.height = `${estHeight}px`
      const hit = await drawCachedPageToCanvas(docId, pageNum, fastCanvas, targetPixelW, targetPixelH)
      if (stale()) {
        fastCanvas.width = 0
        fastCanvas.height = 0
        return
      }
      if (hit) {
        earlyCacheRendered = true
        canvas = fastCanvas
        textLayerDiv = document.createElement('div')
        textLayerDiv.className = 'textLayer'
        textLayerDiv.style.width = `${estWidth}px`
        textLayerDiv.style.height = `${estHeight}px`
        textLayerDiv.style.setProperty('--scale-factor', currentScale)
        textLayerDiv.style.setProperty('--user-unit', 1)
        job.textLayerDiv = textLayerDiv

        inner.style.width = `${estWidth}px`
        inner.style.height = `${estHeight}px`
        wrapper.style.minHeight = ''
        const transBlock = wrapper.parentElement?.querySelector('.trans-page-block')
        if (transBlock) transBlock.style.height = `${Math.floor(estHeight)}px`

        canvas.dataset.rendered = 'true'
        job.canvasRendered = true
        job.dpr = dpr
        job.needsHiResUpgrade = useTwoStagePreview
        job.hiResRendered = !useTwoStagePreview && dpr > 1.15
        window.onTextLayerReleased?.(inner.querySelector('.textLayer'), pageNum)
        inner.querySelectorAll('canvas').forEach(previous => { previous.width = 0; previous.height = 0 })
        inner.replaceChildren(canvas, textLayerDiv)
        onCanvasReady?.()
      }
    }

    const page = await pdfDoc.getPage(pageNum)
    if (stale()) return
    job.page = page
    const baseViewport = page.getViewport({ scale: 1 })
    const prevDim = pageDimensions.get(pageNum)
    const dimMismatch = !prevDim
      || Math.abs(prevDim.width - baseViewport.width) > 0.5
      || Math.abs(prevDim.height - baseViewport.height) > 0.5
    if (dimMismatch) {
      pageDimensions.set(pageNum, { width: baseViewport.width, height: baseViewport.height })
      if (docId) setCachedDocDimensions(docId, pageDimensions)
    }
    const viewport = page.getViewport({ scale: currentScale })
    job.viewport = viewport

    if (earlyCacheRendered && dimMismatch) {
      // Page dimensions differed from fallback page 1 dimension; sync layout & re-render at exact viewport
      earlyCacheRendered = false
    }

    if (!earlyCacheRendered) {
      // 캔버스
      canvas = document.createElement('canvas')
      canvas.width  = Math.floor(viewport.width  * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width  = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`

      // 텍스트 레이어 (드래그 선택)
      textLayerDiv = document.createElement('div')
      textLayerDiv.className = 'textLayer'
      textLayerDiv.style.width  = `${viewport.width}px`
      textLayerDiv.style.height = `${viewport.height}px`
      textLayerDiv.style.setProperty('--scale-factor', viewport.scale)
      textLayerDiv.style.setProperty('--user-unit', viewport.userUnit)
      job.textLayerDiv = textLayerDiv

      inner.style.width = `${viewport.width}px`
      inner.style.height = `${viewport.height}px`
      wrapper.style.minHeight = ''

      // 번역 블록의 높이를 실제 렌더링된 PDF 높이와 동기화
      const transBlock = wrapper.parentElement?.querySelector('.trans-page-block')
      if (transBlock) {
        transBlock.style.height = `${Math.floor(viewport.height)}px`
      }
    } else if (textLayerDiv) {
      textLayerDiv.style.setProperty('--scale-factor', viewport.scale)
      textLayerDiv.style.setProperty('--user-unit', viewport.userUnit)
    }

    // 캔버스 렌더링: 전공서적 등 대형 문서에서는 1x 해상도(픽셀 수 1/4, 약 4배 빠른 속도)로
    // 먼저 즉시 화면에 띄워 빈 페이지 대기 시간을 없애고, 스크롤이 멈춘 뒤 현재 보고 있는
    // 페이지일 때만 Retina(dpr) 고해상도로 조용히 업그레이드한다 (네이티브 PDF 뷰어 2단계 타일링 원리).
    const renderCanvasAtScale = async (targetCanvas, pixelRatio) => {
      const targetW = Math.floor(viewport.width * pixelRatio)
      const targetH = Math.floor(viewport.height * pixelRatio)
      targetCanvas.width = targetW
      targetCanvas.height = targetH
      targetCanvas.style.width = `${viewport.width}px`
      targetCanvas.style.height = `${viewport.height}px`

      if (docId) {
        const cachedHit = await drawCachedPageToCanvas(docId, pageNum, targetCanvas, targetW, targetH)
        if (stale()) return false
        if (cachedHit) return true
      }

      let renderedOffscreen = false
      if (typeof OffscreenCanvas === 'function') {
        try {
          const offscreen = new OffscreenCanvas(targetW, targetH)
          const offCtx = offscreen.getContext('2d')
          if (offCtx) {
            offCtx.scale(pixelRatio, pixelRatio)
            job.renderTask = page.render({ canvasContext: offCtx, viewport })
            await job.renderTask.promise
            if (stale()) return false
            const bitmap = offscreen.transferToImageBitmap()
            const ctx = targetCanvas.getContext('2d')
            if (ctx) {
              ctx.drawImage(bitmap, 0, 0)
              bitmap.close?.()
              renderedOffscreen = true
            } else {
              bitmap.close?.()
            }
          }
        } catch {
          renderedOffscreen = false
        }
      }
      if (!renderedOffscreen) {
        const ctx = targetCanvas.getContext('2d')
        ctx.scale(pixelRatio, pixelRatio)
        job.renderTask = page.render({ canvasContext: ctx, viewport })
        await job.renderTask.promise
      }
      if (stale()) return false
      if (docId) {
        scheduleStoreRenderedPageCanvas(docId, pageNum, targetCanvas, targetW, targetH)
      }
      return true
    }

    job.renderCanvasAtScale = renderCanvasAtScale
    job.dpr = dpr
    job.needsHiResUpgrade = useTwoStagePreview
    if (!earlyCacheRendered) {
      const firstOk = await renderCanvasAtScale(canvas, firstPassRatio)
      if (!firstOk || stale()) { canvas.width = 0; canvas.height = 0; return }

      canvas.dataset.rendered = 'true'
      job.canvasRendered = true
      job.hiResRendered = !useTwoStagePreview && dpr > 1.15
      window.onTextLayerReleased?.(inner.querySelector('.textLayer'), pageNum)
      inner.querySelectorAll('canvas').forEach(previous => { previous.width = 0; previous.height = 0 })
      inner.replaceChildren(canvas, textLayerDiv)
      onCanvasReady?.()
    }

    // 전공서적 등 대형 문서(>48p)에서는 ±15페이지 전체는 1x 해상도로 초고속 프리렌더링만 해두고,
    // 스크롤이 멈춘 뒤 현재 실제로 눈앞에 보이는 페이지(±1p)만 Retina(dpr) 고해상도 업그레이드하고
    // 주변 페이지(±3p)에만 텍스트 레이어를 마운트한다.
    if (isLargeDocument) {
      await waitForScrollSettleOrImmediate(false, job.controller.signal)
      if (stale() || !isPriorityPage()) return
      if (useTwoStagePreview && isImmediateVisiblePage()) {
        await _upgradeDeferredHiResCanvas(job, generation)
        if (stale()) return
      }
    }
    await _mountDeferredTextLayer(job, generation)

  } catch (e) {
    if (stale()) return
    if (!inner.querySelector('canvas[data-rendered]')) {
      inner.innerHTML = `<div class="page-render-error">페이지 ${pageNum} 오류</div>`
    }
    console.error(`Render p.${pageNum}:`, e)
  }
}

/** Re-measure native text after UI/browser zoom without replacing selection nodes. */
export function refreshTextLayerGeometry(onUpdated) {
  for (const [pageNum, layer] of renderedTextLayers) {
    if (layer.generation !== renderGeneration || !layer.container.isConnected) {
      renderedTextLayers.delete(pageNum)
      continue
    }
    alignTextLayer(layer.textLayer, layer.textContent, layer.viewport, layer.container)
    onUpdated?.(layer.container, pageNum)
  }
}

/** 특정 페이지 wrapper로 스크롤 */
export function scrollToPage(container, pageNum, { instant = false } = {}) {
  const el = container.querySelector(`[data-page="${pageNum}"]`)
  if (el) el.scrollIntoView({ behavior: instant ? 'instant' : 'smooth', block: 'start' })
}

/** 줌 변경 후 전체 재렌더링 */
export async function reRenderAll(container, newZoom, callbacks) {
  currentScale = newZoom
  await renderScrollView(container, newZoom, { ...callbacks, preserveCanvas: true })
}

export function clearPdfTextRecoveryCache(docId = null) {
  pdfTextRecoveryCache.clear()
  if (docId) {
    void clearDocumentPageCache(docId)
  }
}

export function setScale(s) { currentScale = s }
export function getScale()  { return currentScale }
export function getTotalPages() { return pdfDoc ? pdfDoc.numPages : 0 }

/** PDF.js 목차(Outline) 비동기 추출 함수 */
export async function getPDFOutline() {
  if (!pdfDoc) return null
  try {
    const outline = await pdfDoc.getOutline()
    if (!outline || outline.length === 0) return null

    async function resolveItems(items) {
      const resolved = []
      for (const item of items) {
        let pageNum = null
        if (item.dest) {
          try {
            let destObj = item.dest
            if (typeof destObj === 'string') {
              destObj = await pdfDoc.getDestination(destObj)
            }
            if (Array.isArray(destObj) && destObj.length > 0) {
              const ref = destObj[0]
              if (ref && typeof ref === 'object') {
                const pageIndex = await pdfDoc.getPageIndex(ref)
                pageNum = pageIndex + 1
              } else if (typeof ref === 'number') {
                pageNum = ref + 1
              }
            }
          } catch (e) {
            console.warn("Failed to resolve destination for outline item:", item.title, e)
          }
        }
        const subItems = (item.items && item.items.length > 0) ? await resolveItems(item.items) : []
        resolved.push({
          title: item.title,
          pageNum: pageNum,
          items: subItems
        })
      }
      return resolved
    }

    return await resolveItems(outline)
  } catch (err) {
    console.error("Error loading PDF outline:", err)
    return null
  }
}

export function sourceMappingRects(pageNum, mapping, { mergeLines = false } = {}) {
  const layer = renderedTextLayers.get(Number(pageNum))
  if (!layer || !sourceMappingMatchesRevision(mapping, layer.container.dataset.sourceRevision)) return []
  const rects = projectSourceRects(mapping, layer.viewport)
  return mergeLines ? mergePdfSentenceLineRects(rects) : rects
}


export function suspendPDFRendering() {
  suspended = true
  renderGeneration++
  disposeScrollView()
  renderedTextLayers.clear()
  figureCropCache.clear()
}
export async function resumePDFRendering() {
  if (!suspended) return
  suspended = false
  if (!lastScrollView) return
  const { container, zoom, onPageVisible } = lastScrollView
  const top = container.scrollTop
  const resuming = renderScrollView(container, zoom, { onPageVisible })
  const token = renderGeneration
  await resuming
  if (token !== renderGeneration || suspended) return
  container.scrollTop = top
}
export async function renderPDFThumbnail(pageNum, canvas) {
  if (!pdfDoc || suspended) return
  const source = pdfDoc
  const page = await source.getPage(pageNum)
  if (source !== pdfDoc || suspended || !canvas.isConnected) return
  const viewport = page.getViewport({ scale: 110 / page.getViewport({ scale: 1 }).width })
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
}

// Read text independently of lazy canvas rendering for workspace find.
export async function getPDFPageText(pageNumber, signal) {
  const document = pdfDoc
  if (!document) return ''
  const rendered = renderedTextLayers.get(pageNumber)?.textContent
  if (rendered) return rendered.items.map(item => item.str + (item.hasEOL ? ' ' : '')).join('')
  if (pdfTextUrl) {
    try {
      const response = await fetch(`${pdfTextUrl}/${pageNumber}?nonblocking=true`, { signal })
      if (response.ok) {
        const recovered = await response.json()
        if (recovered.recovery && recovered.spans?.length) return recovered.spans.map(span => span.text + (span.hasEOL ? ' ' : '')).join('')
      }
    } catch (error) { if (signal?.aborted) throw error }
  }
  const page = await document.getPage(pageNumber)
  const content = await page.getTextContent()
  return content.items.map(item => item.str + (item.hasEOL ? ' ' : '')).join('')
}
export async function getPDFPageWidth(pageNumber = 1) {
  if (!pdfDoc) return null
  return widestPageWidth || (await pdfDoc.getPage(pageNumber)).getViewport({ scale: 1 }).width
}
