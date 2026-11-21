import { test, expect } from '@playwright/test'
import { mockBaseRoutes } from './helpers.js'

test('첫 방문에서 온보딩을 열고 건너뛴 상태를 기억한다', async ({ page }) => {
  await mockBaseRoutes(page, {
    documents: [],
    workspaceSettings: { onboarding_version: 0 },
  })

  await page.goto('/index.html')
  await expect(page.locator('#onboarding-modal')).not.toHaveClass(/hidden/)
  await page.locator('[data-purpose-mode="research"]').click()
  await page.click('#onboarding-purpose-next-btn')
  const guide = page.locator('#onboarding-guide')
  await expect(guide.locator('.onboarding-card')).toHaveCount(3)
  await guide.locator('.onboarding-card').nth(1).click()
  await expect(guide.locator('input[type=url]')).toBeVisible()
  await expect(guide.locator('input[type=password]')).toBeVisible()
  await guide.locator('#onboarding-back-btn').click()
  await expect(guide.locator('.onboarding-card')).toHaveCount(3)

  await page.click('#onboarding-skip-btn')
  await expect(page.locator('#onboarding-modal')).toHaveClass(/hidden/)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('easypaper_onboarding_seen'))).toBe('1')

  await page.reload()
  await expect(page.locator('#onboarding-modal')).toHaveClass(/hidden/)
})

test('원격 모델을 시험하고 번역 설정에만 적용한다', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [], workspaceSettings: { onboarding_version: 0 } })
  let saved
  await page.route('**/api/settings/translation-model', route => {
    saved = route.request().postDataJSON()
    return route.fulfill({ json: { saved: true } })
  })
  await page.route('**/api/settings/discover-models', route => route.fulfill({ json: { models: ['team-model'] } }))
  await page.route('**/api/settings/translation-preview', route => {
    expect(route.request().postDataJSON().server.url).toBe('https://models.example.org/v1')
    return route.fulfill({ json: { translation: 'Example translation' } })
  })
  await page.route('**/api/inference/servers', route => route.fulfill({ json: { id: 'test-server' } }))
  await page.goto('/index.html')
  await page.locator('[data-purpose-mode="research"]').click()
  await page.click('#onboarding-purpose-next-btn')
  await page.locator('#onboarding-fields button').nth(1).click()
  await page.locator('#onboarding-fields select').selectOption('vllm')
  await page.locator('#onboarding-fields input[type=url]').fill('https://models.example.org/v1')
  const action = page.locator('#onboarding-action')
  await action.click()
  await expect(page.locator('#onboarding-fields select')).toHaveValue('team-model')
  await action.click()
  await expect(page.locator('#onboarding-feedback')).toHaveText('Example translation')
  await action.click()
  await expect(page.locator('#onboarding-fields')).toHaveText('team-model')
  expect(saved).toEqual({ provider: 'openai', model: 'team-model', server_id: 'test-server' })
})

async function openLocalTools(page) {
  await page.goto('/index.html')
  await page.locator('[data-purpose-mode="research"]').click()
  await page.click('#onboarding-purpose-next-btn')
  await page.locator('#onboarding-fields button').first().click()
}

test('설치된 CLI의 로그인을 다시 확인하고 모델을 선택한다', async ({ page }) => {
  await mockBaseRoutes(page, { workspaceSettings: { onboarding_version: 0 } })
  await page.route('**/api/availability', route => route.fulfill({ json: { codex: true } }))
  await page.route('**/api/settings/ollama-status', route => route.fulfill({ json: { installed: false } }))
  let connected = false
  await page.route('**/api/settings/cli-login/codex', route => route.fulfill({ json: { connected } }))
  await openLocalTools(page)
  await page.locator('#onboarding-fields button').filter({ hasText: 'Codex' }).click()
  await expect(page.locator('#onboarding-fields code')).toHaveText('codex login')
  connected = true
  await page.click('#onboarding-action')
  await expect(page.locator('#onboarding-fields select option').first()).toBeAttached()
})

test('vLLM 설치 실패 시 다른 서버에 연결할 수 있다', async ({ page }) => {
  await mockBaseRoutes(page, { workspaceSettings: { onboarding_version: 0 } })
  await page.route('**/api/settings/ollama-status', route => route.fulfill({ json: { installed: false } }))
  await page.route('**/api/settings/vllm', route => {
    const status = route.request().method() === 'POST' ? 'failed' : 'idle'
    return route.fulfill({ json: { status, models: ['test-model'], log: ['NVIDIA GPU required'] } })
  })
  await openLocalTools(page)
  await page.locator('#onboarding-fields button').filter({ hasText: 'vLLM' }).click()
  await page.click('#onboarding-action')
  await expect(page.locator('#onboarding-feedback')).toHaveText('NVIDIA GPU required')
  await page.locator('#onboarding-fields button').last().click()
  await expect(page.locator('#onboarding-fields input[type=url]')).toBeVisible()
})

test('Ollama가 설치되어 있으면 설치를 건너뛰고 첫 문서를 연다', async ({ page }) => {
  await mockBaseRoutes(page, { workspaceSettings: { onboarding_version: 0 } })
  await page.route('**/api/settings/system', route => route.fulfill({ json: {
    ollama_host: 'http://localhost:11434', available_models: ['local-model'], trans_provider: 'ollama', trans_model: 'local-model',
  } }))
  await page.route('**/api/settings/ollama-status', route => route.fulfill({ json: { installed: true, running: true } }))
  await page.route('**/api/settings/translation-preview', route => route.fulfill({ json: { translation: 'OK' } }))
  await page.route('**/api/settings/translation-model', route => route.fulfill({ json: { saved: true } }))
  await openLocalTools(page)
  await page.locator('#onboarding-fields button').filter({ hasText: 'Ollama' }).click()
  await expect(page.locator('#onboarding-fields select').first()).toHaveValue('local-model')
  await page.click('#onboarding-action')
  await expect(page.locator('#onboarding-feedback')).toHaveText('OK')
  await page.click('#onboarding-action')
  await expect(page.locator('#onboarding-fields')).toHaveText('local-model')
  const chooser = page.waitForEvent('filechooser')
  await page.click('#onboarding-action')
  expect((await chooser).isMultiple()).toBeTruthy()
})
