/**
 * PDF.js 기반 연속 스크롤 뷰어
 * - 모든 페이지를 세로로 쌓아 스크롤
 * - 텍스트 레이어로 드래그 선택 지원
 * - IntersectionObserver 기반 lazy 렌더링
 */

import { alignTextLayer, collectTextContent } from './pdfTextLayer.js'

import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

let pdfjsLib = null
let pdfDoc = null
let pdfLoadingTask = null
const renderedTextLayers = new Map()
let currentScale = 1.5
let pageObserver = null
let pageVisibilityObserver = null
let visiblePageHeights = {}
let loadGeneration = 0
// renderScrollView가 호출될 때마다(문서 전환, 줌 변경) 증가하는 세대 카운터.
// pdf-page-wrapper DOM 노드는 문서를 바꿔도 새로 만들지 않고 재사용하는데,
// 이전 문서/줌에 대한 _renderPage 호출이 비동기 대기 중일 때 사용자가 빠르게
// 다른 문서를 열면, 그 이전 렌더링이 뒤늦게 끝나면서 이미 새 문서용으로
// 재사용된 wrapper에 옛 canvas/textLayer를 덮어써버리는 경쟁 조건이 있었다.
// 각 _renderPage 호출이 시작 시점의 세대를 기억해뒀다가, DOM을 건드리기 전에
// 현재 세대와 비교해서 다르면(그 사이 새로 renderScrollView가 호출됐다면)
// 조용히 중단한다.
let renderGeneration = 0

async function loadPDFJS() {
  if (pdfjsLib) return pdfjsLib
  pdfjsLib = await import('pdfjs-dist/build/pdf.mjs')
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  return pdfjsLib
}

export async function loadPDF(url) {
  await loadPDFJS()
  const myGeneration = ++loadGeneration
  // WebKit은 파괴된 worker의 진행 중인 렌더를 즉시 reject할 수 있다.
  // 새 문서가 로드되기 시작한 시점부터 기존 렌더를 오래된 작업으로 표시해
  // 정상적인 취소가 페이지 오류나 콘솔 오류로 노출되지 않게 한다.
  renderGeneration++
  const previousLoadingTask = pdfLoadingTask
  const loadingTask = pdfjsLib.getDocument({ url })
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

/**
 * 연속 스크롤 뷰어 초기화
 * @param {HTMLElement} container  - 스크롤 컨테이너 (#pdf-scroll-container)
 * @param {number}      zoom       - 초기 배율
 * @param {Object}      callbacks
 *   onPageVisible(pageNum)  - 페이지가 뷰포트에 들어올 때마다 호출
 */
export async function renderScrollView(container, zoom, { onPageVisible } = {}) {
  if (!pdfDoc) return
  currentScale = zoom
  renderedTextLayers.clear()
  renderGeneration++
  const myGeneration = renderGeneration

  if (pageObserver) { pageObserver.disconnect(); pageObserver = null }

  const numPages = pdfDoc.numPages
  const rendered = new Set()

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
      // 실제 렌더 전까지 대략적인 높이로 자리 확보
      wrapper.style.minHeight = `${Math.round(841 * currentScale)}px`

      const inner = document.createElement('div')
      inner.className = 'pdf-page-inner'
      wrapper.appendChild(inner)
      container.appendChild(wrapper)
    }
    wrappers = container.querySelectorAll('.pdf-page-wrapper')
  } else {
    // 기존에 존재하면 minHeight 업데이트 및 내부 렌더링 초기화
    wrappers.forEach(w => {
      const height = Math.round(841 * currentScale)
      w.style.minHeight = `${height}px`
      const inner = w.querySelector('.pdf-page-inner')
      if (inner) inner.innerHTML = ''

      // 번역 블록 높이 동기화
      const transBlock = w.parentElement?.querySelector('.trans-page-block')
      if (transBlock) {
        transBlock.style.height = `${height}px`
      }
    })
  }

  if (pageVisibilityObserver) { pageVisibilityObserver.disconnect(); pageVisibilityObserver = null }
  visiblePageHeights = {}

  // ─── IntersectionObserver (페이지 렌더링용: 미리 600px 앞서 로딩) ───
  pageObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const pageNum = parseInt(entry.target.dataset.page)
      if (entry.isIntersecting) {
        if (!rendered.has(pageNum)) {
          rendered.add(pageNum)
          _renderPage(entry.target, pageNum, myGeneration)
        }
      }
    })
  }, {
    root: container,
    rootMargin: '600px 0px',  // 미리 600px 앞서 렌더링
    threshold: 0.01,
  })

  // ─── IntersectionObserver (현재 보고 있는 페이지 추적용: 마진 없이 실시간 감지) ───
  pageVisibilityObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const pageNum = parseInt(entry.target.dataset.page)
      if (entry.isIntersecting) {
        visiblePageHeights[pageNum] = entry.intersectionRect.height
      } else {
        delete visiblePageHeights[pageNum]
      }
    })

    // 가장 많이 노출되고 있는 페이지 산출
    let maxPageNum = -1
    let maxHeight = -1
    for (const [page, height] of Object.entries(visiblePageHeights)) {
      if (height > maxHeight) {
        maxHeight = height
        maxPageNum = parseInt(page)
      }
    }

    if (maxPageNum !== -1) {
      onPageVisible?.(maxPageNum)
      // 비동기 다음 페이지 프리렌더링 (Canvas 로딩 속도 최적화)
      setTimeout(() => {
        triggerRender(maxPageNum + 1)
      }, 150)
    }
  }, {
    root: container,
    rootMargin: '0px 0px',
    threshold: [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0], // 정밀한 노출 비율 판정
  })

  function triggerRender(pNum) {
    if (pNum >= 1 && pNum <= numPages && !rendered.has(pNum)) {
      const targetWrapper = container.querySelector(`.pdf-page-wrapper[data-page="${pNum}"]`)
      if (targetWrapper) {
        rendered.add(pNum)
        _renderPage(targetWrapper, pNum, myGeneration)
      }
    }
  }

  wrappers.forEach(w => {
    pageObserver.observe(w)
    pageVisibilityObserver.observe(w)
  })
}

async function _renderPage(wrapper, pageNum, generation) {
  if (generation !== renderGeneration) return
  const inner = wrapper.querySelector('.pdf-page-inner')
  inner.innerHTML = ''

  try {
    const page = await pdfDoc.getPage(pageNum)
    if (generation !== renderGeneration) return
    const viewport = page.getViewport({ scale: currentScale })
    const dpr = window.devicePixelRatio || 1

    // 캔버스
    const canvas = document.createElement('canvas')
    canvas.width  = Math.floor(viewport.width  * dpr)
    canvas.height = Math.floor(viewport.height * dpr)
    canvas.style.width  = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`

    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)

    // 텍스트 레이어 (드래그 선택)
    const textLayerDiv = document.createElement('div')
    textLayerDiv.className = 'textLayer'
    textLayerDiv.style.width  = `${viewport.width}px`
    textLayerDiv.style.height = `${viewport.height}px`
    textLayerDiv.style.setProperty('--scale-factor', viewport.scale)
    textLayerDiv.style.setProperty('--user-unit', viewport.userUnit)

    inner.appendChild(canvas)
    inner.appendChild(textLayerDiv)
    wrapper.style.minHeight = ''

    // 번역 블록의 높이를 실제 렌더링된 PDF 높이와 동기화
    const transBlock = wrapper.parentElement?.querySelector('.trans-page-block')
    if (transBlock) {
      transBlock.style.height = `${Math.floor(viewport.height)}px`
    }

    // 캔버스 렌더링 (먼저 실행)
    await page.render({ canvasContext: ctx, viewport }).promise
    if (generation !== renderGeneration) return

    // 텍스트 레이어 렌더링
    try {
      let textContent
      try {
        textContent = await page.getTextContent()
      } catch (error) {
        console.warn('getTextContent failed, trying streamTextContent:', error)
        textContent = await collectTextContent(page.streamTextContent())
      }
      if (generation !== renderGeneration) return
      const textLayer = new pdfjsLib.TextLayer({
        textContentSource: textContent,
        container: textLayerDiv,
        viewport,
      })
      await textLayer.render()
      // Our canvas keeps fractional CSS dimensions rather than PDFViewer's
      // rounded page sizes. Restore exact, unrotated layer dimensions after
      // TextLayer sets its viewer-specific round()/--scale-round-* expressions.
      textLayerDiv.style.width = `${viewport.rawDims.pageWidth * viewport.scale * viewport.userUnit}px`
      textLayerDiv.style.height = `${viewport.rawDims.pageHeight * viewport.scale * viewport.userUnit}px`
      if (generation !== renderGeneration) return
      alignTextLayer(textLayer, textContent, viewport)
      renderedTextLayers.set(pageNum, { textLayer, textContent, viewport, container: textLayerDiv, generation })

      // 텍스트 레이어 렌더 완료 콜백 호출
      if (generation === renderGeneration && window.onTextLayerRendered) {
        window.onTextLayerRendered(textLayerDiv, pageNum)
      }
    } catch (e) {
      console.warn(`TextLayer p.${pageNum}:`, e.message)
    }

  } catch (e) {
    if (generation !== renderGeneration) return
    inner.innerHTML = `<div class="page-render-error">페이지 ${pageNum} 오류</div>`
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
    alignTextLayer(layer.textLayer, layer.textContent, layer.viewport)
    onUpdated?.(layer.container, pageNum)
  }
}

/** 특정 페이지 wrapper로 스크롤 */
export function scrollToPage(container, pageNum, { instant = false } = {}) {
  const el = container.querySelector(`[data-page="${pageNum}"]`)
  if (el) el.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'start' })
}

/** 줌 변경 후 전체 재렌더링 */
export async function reRenderAll(container, newZoom, callbacks) {
  currentScale = newZoom
  await renderScrollView(container, newZoom, callbacks)
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
