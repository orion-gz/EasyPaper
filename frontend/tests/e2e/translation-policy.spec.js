import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from './helpers.js'

test('연구와 일반 문서 워크스페이스의 번역 모드를 따로 저장한다', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [] })
  await page.route('**/api/document-types', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ modes: [
      { value: 'research', types: [{ value: 'research_paper', mode: 'research', label: '연구 논문' }] },
      { value: 'general', types: [{ value: 'other', mode: 'general', label: '기타 문서' }] },
    ] }),
  }))
  await gotoApp(page)
  await page.evaluate(() => {
    localStorage.setItem('easypaper_translation_mode_research', 'pane')
    localStorage.setItem('easypaper_translation_mode_general', 'scroll')
  })

  await page.locator('#sidebar-settings-btn').click()
  await expect(page.locator('#setting-translation-mode')).toHaveValue('pane')
  await expect(page.locator('#setting-translation-mode-scope')).toHaveText('연구 모드에만 적용')
  await page.locator('#close-settings-btn').click()

  await page.locator('#workspace-mode-switch [data-workspace-mode="general"]').click()
  await page.locator('#sidebar-settings-btn').click()
  await expect(page.locator('#setting-translation-mode')).toHaveValue('scroll')
  await expect(page.locator('#setting-translation-mode-scope')).toHaveText('일반 문서 모드에만 적용')
  await page.locator('#setting-translation-mode').selectOption('auto')
  await page.locator('#close-settings-btn').click()

  await page.locator('#workspace-mode-switch [data-workspace-mode="research"]').click()
  await page.locator('#sidebar-settings-btn').click()
  await expect(page.locator('#setting-translation-mode')).toHaveValue('pane')
  expect(await page.evaluate(() => localStorage.getItem('easypaper_translation_mode_general'))).toBe('auto')
})

test('설정 화면이 현재 워크스페이스 모드의 값과 항목 구성을 보여준다', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [] })
  await gotoApp(page)
  await page.evaluate(() => {
    localStorage.setItem('easypaper_style', 'literal')
    localStorage.setItem('easypaper_ignore_table', 'false')
  })

  await page.locator('#sidebar-settings-btn').click()
  await expect(page.locator('#settings-mode-title')).toHaveText('연구 모드 설정')
  await expect(page.locator('#setting-trans-style')).toHaveValue('literal')
  await expect(page.locator('#setting-ignore-table')).not.toBeChecked()
  await expect(page.locator('#setting-disable-citation-overlay').locator('..')).toBeVisible()

  await page.locator('#close-settings-btn').click()
  await page.locator('#workspace-mode-switch [data-workspace-mode="general"]').click()
  await page.locator('#sidebar-settings-btn').click()
  await expect(page.locator('#settings-mode-title')).toHaveText('일반 문서 모드 설정')
  await expect(page.locator('#setting-trans-style')).toHaveValue('natural')
  await expect(page.locator('#setting-translation-mode')).toHaveValue('scroll')
  await expect(page.locator('#setting-ignore-table')).not.toBeChecked()
  await expect(page.locator('#setting-disable-citation-overlay').locator('..')).toBeHidden()
  await expect(page.locator('#settings-keywords-label')).toHaveText('고급 어휘 자동 생성')

  await page.locator('#setting-trans-style').selectOption('summary')
  await page.locator('#setting-ignore-table').locator('..').click()
  expect(await page.evaluate(() => localStorage.getItem('easypaper_ignore_table_general'))).toBe('true')

  await page.locator('#close-settings-btn').click()
  await page.locator('#workspace-mode-switch [data-workspace-mode="research"]').click()
  await page.locator('#sidebar-settings-btn').click()
  await expect(page.locator('#settings-mode-title')).toHaveText('연구 모드 설정')
  await expect(page.locator('#setting-trans-style')).toHaveValue('literal')
  await expect(page.locator('#setting-ignore-table')).not.toBeChecked()
})

test('번역 범위 선택에서 문서 전체 페이지 목록을 잡 API에 전달한다', async ({ page }) => {
  const doc = {
    id: 'doc-scope', filename: 'Scope.pdf', total_pages: 1,
    metadata: { title: 'Scoped translation' }, translated_pages: [],
  }
  let restartPayload = null

  await mockBaseRoutes(page, { documents: [doc] })
  await page.route('**/api/library/doc-scope/pdf', route => route.fulfill({
    status: 200, contentType: 'application/pdf', body: SAMPLE_PDF_A,
  }))
  await page.route('**/api/jobs/doc-scope/restart', route => {
    restartPayload = route.request().postDataJSON()
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ job: { status: 'running', total_pages: 1, target_pages: [1] } }),
    })
  })

  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=doc-scope' })
  await expect(page.locator('#viewer-screen')).toHaveClass(/active/)
  await page.locator('#toolbar-kebab-btn').click()
  await page.locator('#translation-scope-btn').click()
  await page.locator('.translation-scope-modal [data-scope="all"]').click()

  await expect.poll(() => restartPayload).not.toBeNull()
  expect(restartPayload.page_numbers).toEqual([1])
})

test('워크스페이스 모드별 테마와 강조색을 독립적으로 적용한다', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [] })
  await gotoApp(page)
  await page.evaluate(() => {
    localStorage.setItem('easypaper_theme_research', 'light')
    localStorage.setItem('easypaper_theme_general', 'dark')
    localStorage.setItem('easypaper_accent_color_research', '#e0677a')
    localStorage.setItem('easypaper_accent_color_general', '#1c9c6b')
  })
  await page.reload()

  await expect(page.locator('body')).toHaveClass(/light-theme/)
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-mid').trim())).toBe('#e0677a')

  await page.locator('#workspace-mode-switch [data-workspace-mode="general"]').click()
  await expect(page.locator('body')).not.toHaveClass(/light-theme/)
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-mid').trim())).toBe('#1c9c6b')

  await page.locator('#sidebar-theme-toggle-btn').click()
  expect(await page.evaluate(() => localStorage.getItem('easypaper_theme_general'))).toBe('light')
  await page.locator('#sidebar-settings-btn').click()
  await expect(page.locator('#settings-theme-scope')).toHaveText('일반 문서 모드에만 적용')
  await page.locator('.accent-swatch[data-hex="#5457b8"]').click()
  expect(await page.evaluate(() => localStorage.getItem('easypaper_accent_color_general'))).toBe('#5457b8')

  await page.locator('#close-settings-btn').click()
  await page.locator('#workspace-mode-switch [data-workspace-mode="research"]').click()
  await expect(page.locator('body')).toHaveClass(/light-theme/)
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-mid').trim())).toBe('#e0677a')
})
