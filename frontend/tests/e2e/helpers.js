import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const SAMPLE_PDF_A = fs.readFileSync(path.join(__dirname, 'fixtures/sample-a.pdf'))
export const SAMPLE_PDF_B = fs.readFileSync(path.join(__dirname, 'fixtures/sample-b.pdf'))
export const SAMPLE_PDF_CITATION = fs.readFileSync(path.join(__dirname, 'fixtures/sample-citation.pdf'))

/**
 * 로그인 이후의 기본 화면(라이브러리)까지 도달하는 데 필요한 최소한의
 * /api/** 목(mock) 응답을 등록한다. 개별 테스트는 이 기반 위에
 * page.route()를 추가로 덮어써서 시나리오별 응답을 얹는다.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} [overrides] - { documents, onRoute } 등 확장 옵션
 */
export async function mockBaseRoutes(page, { documents = [] } = {}) {
  await page.route('**/api/**', async route => {
    const url = route.request().url()

    if (url.includes('/api/auth/check')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'authenticated', username: 'admin' }) })
    }
    if (url.includes('/api/settings/system')) {
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          ollama_host: 'http://localhost:11434', available_models: [],
          default_ai_provider: 'ollama', default_ai_model: '',
          trans_provider: 'ollama', trans_model: '', chat_provider: 'ollama', chat_model: '',
          analysis_provider: 'ollama', analysis_model: '', library_provider: 'ollama', library_model: '',
          openai_api_key: '', gemini_api_key: '', claude_api_key: '', translation_prompt_template: '',
        }),
      })
    }
    if (url.includes('/api/availability')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ antigravity: false, claude_code: false, codex: false }) })
    }
    if (url.includes('/api/settings/update-check-config')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ interval: 'never', last_checked_at: null }) })
    }
    if (url.includes('/api/settings/post-update-notice')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ show: false, version: 'test0000', version_date: '2026-01-01', changelog: [] }) })
    }
    if (url.includes('/api/library/folders')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ folders: [] }) })
    }
    if (url.includes('/api/library/trash')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documents: [], total: 0 }) })
    }
    if (url.includes('/api/library') && !url.includes('/pdf') && !url.includes('/images') && !url.includes('/history')) {
      const idMatch = url.match(/\/api\/library\/([^/?]+)$/)
      if (idMatch) {
        const doc = documents.find(d => d.id === idMatch[1])
        if (doc) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doc) })
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: '문서를 찾을 수 없습니다.' }) })
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documents, total: documents.length }) })
    }
    if (url.match(/\/api\/library\/[^/]+\/images/)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ images: [] }) })
    }
    if (url.match(/\/api\/chat\/[^/]+\/history/)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ history: [] }) })
    }
    if (url.includes('/outline')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ outline: [] }) })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) })
  })
}

/** 로그인 상태로 앱을 열고(온보딩은 건너뜀) 라이브러리 화면이 뜰 때까지 기다린다. */
export async function gotoApp(page) {
  await page.goto('/index.html')
  await page.evaluate(() => localStorage.setItem('easypaper_onboarding_seen', '1'))
  await page.reload()
  await page.waitForTimeout(600)
}
