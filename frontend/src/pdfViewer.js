/**
 * PDF.js 기반 연속 스크롤 뷰어
 * - 모든 페이지를 세로로 쌓아 스크롤
 * - 텍스트 레이어로 드래그 선택 지원
 * - IntersectionObserver 기반 lazy 렌더링
 */

const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs'
const WORKER_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs'

let pdfjsLib = null
let pdfDoc = null
let currentScale = 1.5
let pageObserver = null

async function loadPDFJS() {
  if (pdfjsLib) return pdfjsLib
  const mod = await import(/* @vite-ignore */ PDFJS_CDN)
  pdfjsLib = mod
  pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_CDN
  return pdfjsLib
}

export async function loadPDF(url) {
  await loadPDFJS()
  pdfDoc = await pdfjsLib.getDocument(url).promise
  return pdfDoc.numPages
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

  if (pageObserver) { pageObserver.disconnect(); pageObserver = null }

  const numPages = pdfDoc.numPages
  const rendered = new Set()

  let wrappers = container.querySelectorAll('.pdf-page-wrapper')

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

  // ─── IntersectionObserver ───────────────────────
  pageObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const pageNum = parseInt(entry.target.dataset.page)
      if (entry.isIntersecting) {
        if (!rendered.has(pageNum)) {
          rendered.add(pageNum)
          _renderPage(entry.target, pageNum)
        }
        onPageVisible?.(pageNum)
      }
    })
  }, {
    root: container,
    rootMargin: '600px 0px',  // 미리 600px 앞서 렌더링
    threshold: 0.01,
  })

  wrappers.forEach(w => pageObserver.observe(w))
}

async function _renderPage(wrapper, pageNum) {
  const inner = wrapper.querySelector('.pdf-page-inner')
  inner.innerHTML = ''

  try {
    const page = await pdfDoc.getPage(pageNum)
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

    // 텍스트 레이어 렌더링
    try {
      if (pdfjsLib.TextLayer) {
        // PDF.js 4.x
        try {
          const textContent = await page.getTextContent()
          const tl = new pdfjsLib.TextLayer({
            textContentSource: textContent,
            container: textLayerDiv,
            viewport,
          })
          await tl.render()
        } catch (err) {
          console.warn("TextLayer with getTextContent failed, trying streamTextContent fallback:", err)
          const tl = new pdfjsLib.TextLayer({
            textContentSource: page.streamTextContent(),
            container: textLayerDiv,
            viewport,
          })
          await tl.render()
        }
      } else if (pdfjsLib.renderTextLayer) {
        // PDF.js 3.x fallback
        const textContent = await page.getTextContent()
        await pdfjsLib.renderTextLayer({
          textContent,
          container: textLayerDiv,
          viewport,
          textDivs: [],
        }).promise
      }

      // 텍스트 레이어 렌더 완료 콜백 호출
      if (window.onTextLayerRendered) {
        window.onTextLayerRendered(textLayerDiv, pageNum)
      }
    } catch (e) {
      console.warn(`TextLayer p.${pageNum}:`, e.message)
    }

  } catch (e) {
    inner.innerHTML = `<div class="page-render-error">페이지 ${pageNum} 오류</div>`
    console.error(`Render p.${pageNum}:`, e)
  }
}

/** 특정 페이지 wrapper로 스크롤 */
export function scrollToPage(container, pageNum) {
  const el = container.querySelector(`[data-page="${pageNum}"]`)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** 줌 변경 후 전체 재렌더링 */
export async function reRenderAll(container, newZoom, callbacks) {
  currentScale = newZoom
  await renderScrollView(container, newZoom, callbacks)
}

export function setScale(s) { currentScale = s }
export function getScale()  { return currentScale }
export function getTotalPages() { return pdfDoc ? pdfDoc.numPages : 0 }
