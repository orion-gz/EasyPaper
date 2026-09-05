import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from './helpers.js'

async function setupModelChangeScenario(page, translationMode) {
  const doc = {
    id: 'doc-model-change',
    filename: 'Model change.pdf',
    total_pages: 1,
    metadata: { title: 'Model change document' },
    translated_pages: [1],
  }
  let systemSettings = {
    ollama_host: 'http://localhost:11434',
    available_models: ['old-model', 'new-model'],
    default_ai_provider: 'ollama', default_ai_model: 'old-model',
    trans_provider: 'ollama', trans_model: 'old-model',
    chat_provider: 'ollama', chat_model: 'old-model',
    analysis_provider: 'ollama', analysis_model: 'old-model',
    library_provider: 'ollama', library_model: 'old-model',
    openai_api_key: '', gemini_api_key: '', claude_api_key: '', translation_prompt_template: '',
  }
  let clearRequests = 0
  const restartBodies = []

  await mockBaseRoutes(page, { documents: [doc] })
  await page.route('**/api/settings/system', async route => {
    if (route.request().method() === 'POST') {
      systemSettings = { ...systemSettings, ...route.request().postDataJSON() }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(systemSettings) })
  })
  await page.route('**/api/library/doc-model-change/pdf', route => route.fulfill({
    status: 200,
    contentType: 'application/pdf',
    body: SAMPLE_PDF_A,
  }))
  await page.route('**/api/translate/doc-model-change/clear-cache', route => {
    clearRequests += 1
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })
  await page.route('**/api/jobs/doc-model-change/restart', route => {
    restartBodies.push(route.request().postDataJSON())
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })

  await gotoApp(page)
  await page.evaluate(mode => {
    localStorage.setItem('easypaper_translation_mode', mode)
    location.hash = '#viewer?id=doc-model-change'
  }, translationMode)
  await expect(page.locator('#viewer-screen.active')).toBeVisible()

  await page.locator('#toolbar-kebab-btn').click()
  await page.locator('#viewer-trans-provider .provider-picker-btn').click()
  await page.locator('#viewer-trans-provider .picker-model-item', { hasText: 'new-model' }).click()

  return {
    restartBodies,
    getClearRequests: () => clearRequests,
  }
}

for (const translationMode of ['pane', 'scroll']) {
  test(`${translationMode} 번역 모드에서 모델 변경 시 기존 번역 페이지만 재번역한다`, async ({ page }) => {
    const scenario = await setupModelChangeScenario(page, translationMode)

    await expect(page.locator('.custom-confirm-modal-body')).toContainText('기존에 번역한 1개 페이지만')
    await expect(page.locator('.custom-confirm-modal-body')).toContainText('번역하지 않은 페이지는 자동으로 번역하지 않습니다')
    await page.locator('.custom-confirm-modal-wrapper .confirm-btn').click()

    await expect.poll(() => scenario.restartBodies.length).toBe(1)
    expect(scenario.getClearRequests()).toBe(1)
    expect(scenario.restartBodies[0].page_numbers).toEqual([1])
  })
}

test('업로드 시 번역 모드에서 모델 변경 시 문서 전체 재번역을 유지한다', async ({ page }) => {
  const scenario = await setupModelChangeScenario(page, 'auto')

  await expect(page.locator('.custom-confirm-modal-body')).toContainText('문서 전체를 새 모델로 다시 번역')
  await page.locator('.custom-confirm-modal-wrapper .confirm-btn').click()

  await expect.poll(() => scenario.restartBodies.length).toBe(1)
  expect(scenario.getClearRequests()).toBe(1)
  expect(scenario.restartBodies[0].page_numbers).toBeUndefined()
})
