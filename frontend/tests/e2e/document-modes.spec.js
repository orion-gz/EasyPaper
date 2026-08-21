import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp } from './helpers.js'


test('워크스페이스 전환은 홈과 데이터 범위를 바꾸고 문서 종류 필터를 제공한다', async ({ page }) => {
  const documents = [
    { id: 'research-1', filename: 'paper.pdf', total_pages: 5, metadata: { title: 'Research Paper' }, translated_pages: [], document_mode: 'research', document_type: 'research_paper', created_at: '2026-01-01T00:00:00Z' },
    { id: 'manual-1', filename: 'manual.pdf', total_pages: 8, metadata: { title: 'Setup Manual' }, translated_pages: [], document_mode: 'general', document_type: 'manual', created_at: '2026-01-02T00:00:00Z' },
    { id: 'book-1', filename: 'book.pdf', total_pages: 120, metadata: { title: 'Example Book' }, translated_pages: [], document_mode: 'general', document_type: 'book', created_at: '2026-01-03T00:00:00Z' },
  ]
  await mockBaseRoutes(page, { documents })
  await page.route('**/api/settings/workspace', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ onboarding_version: 1, current_onboarding_version: 1, preferred_workspace_mode: 'research', document_type_options: {} }),
  }))
  await page.route('**/api/document-types', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ modes: [
      { value: 'research', types: [{ value: 'research_paper', mode: 'research', label: '연구 논문' }] },
      { value: 'general', types: [{ value: 'manual', mode: 'general', label: '매뉴얼' }, { value: 'book', mode: 'general', label: '책' }] },
    ] }),
  }))
  await page.route('**/api/library?*', route => {
    const mode = new URL(route.request().url()).searchParams.get('document_mode') || 'research'
    const filtered = documents.filter(doc => doc.document_mode === mode)
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documents: filtered, total: filtered.length }) })
  })

  await gotoApp(page)
  const sidebar = page.locator("#app-sidebar")
  await expect(sidebar.locator("[data-page=dashboard] .sidebar-nav-label")).toHaveText("연구 홈")
  await expect(sidebar.locator("[data-page=library] .sidebar-nav-label")).toHaveText("논문 라이브러리")
  await expect(sidebar.locator("[data-page=history] .sidebar-nav-label")).toHaveText("읽기 기록")
  await expect(sidebar.locator("[data-page=chats] .sidebar-nav-label")).toHaveText("논문 AI")
  await expect(sidebar.locator("[data-page=notes] .sidebar-nav-label")).toHaveText("논문 노트")
  await expect(page.getByText('Research Paper')).toBeVisible()
  await expect(page.getByText('Setup Manual')).not.toBeVisible()

  await page.locator('#workspace-mode-switch [data-workspace-mode="general"]').click()
  await expect(page.locator('#workspace-page-title')).toHaveText('문서 홈')
  await expect(sidebar.locator("[data-page=dashboard] .sidebar-nav-label")).toHaveText("문서 홈")
  await expect(sidebar.locator("[data-page=library] .sidebar-nav-label")).toHaveText("문서 라이브러리")
  await expect(sidebar.locator("[data-page=history] .sidebar-nav-label")).toHaveText("읽기 기록")
  await expect(sidebar.locator("[data-page=chats] .sidebar-nav-label")).toHaveText("문서 AI")
  await expect(sidebar.locator("[data-page=notes] .sidebar-nav-label")).toHaveText("문서 노트")
  await expect(page.locator('.sidebar-nav-item[data-page="graph"]')).not.toBeVisible()
  await expect(page.locator('.document-home')).toBeVisible()
  await expect(page.locator('.document-home-stat-grid')).toHaveCSS('display', 'grid')
  await expect(page.locator('.document-home-recent-row')).toHaveCount(2)
  await expect(page.locator('.document-home-recent-list')).toContainText('Setup Manual')
  await expect(page.locator('.document-home-recent-list')).toContainText('Example Book')
  expect(await page.locator('#page-dashboard').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await sidebar.locator("[data-page=history]").click()
  await expect(page.locator("#workspace-page-title")).toHaveText("읽기 기록")
  await expect(page.locator("#page-history")).toContainText("등록 문서")
  await expect(page.locator("#page-history")).toContainText("읽기 시간 상위 문서")
  await expect(page.locator("#page-history")).not.toContainText("논문")

  await sidebar.locator("[data-page=notes]").click()
  await expect(page.locator("#workspace-page-title")).toHaveText("문서 노트")
  await expect(page.locator("#page-notes")).toContainText("문서별 메모")
  await expect(page.locator("#page-notes")).toContainText("문서 목록")
  await expect(page.locator("#page-notes .notes-search-input")).toHaveAttribute("placeholder", "문서 검색...")
  await expect(page.locator("#page-notes")).not.toContainText("논문")

  await page.locator('.sidebar-nav-item[data-page="library"]').click()
  await expect(page.locator('#library-grid').getByText('Setup Manual')).toBeVisible()
  await expect(page.locator('#library-grid').getByText('Example Book')).toBeVisible()
  await expect(page.locator('#lib-compare-toggle-btn')).not.toBeVisible()
  await expect(page.locator('.category-filter-btn', { hasText: '매뉴얼' })).toBeVisible()

  await page.locator('#library-grid .document-type-chip.general', { hasText: '매뉴얼' }).click()
  await expect(page.locator('#library-grid').getByText('Setup Manual')).toBeVisible()
  await expect(page.locator('#library-grid').getByText('Example Book')).not.toBeVisible()
})


test('좁은 화면에서도 문서 홈 카드가 화면 밖으로 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockBaseRoutes(page, { documents: [] })
  await page.route('**/api/settings/workspace', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ onboarding_version: 1, current_onboarding_version: 1, preferred_workspace_mode: 'research', document_type_options: {} }),
  }))
  await gotoApp(page)
  await page.locator('#workspace-mode-switch-compact [data-workspace-mode="general"]').click()

  await expect(page.locator('.document-home')).toBeVisible()
  await expect(page.locator('.document-home-empty')).toContainText('일반 문서가 없습니다.')
  expect(await page.locator('.document-home').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
})



test('서버 기능 플래그가 일반 문서 워크스페이스를 숨긴다', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [] })
  await page.route('**/api/document-types', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ rollout: { general_document_mode: false }, modes: [] }),
  }))
  await gotoApp(page)
  const generalSwitches = page.locator('[data-workspace-mode="general"]')
  await expect(generalSwitches).toHaveCount(2)
  await expect(generalSwitches.first()).toBeHidden()
  await expect(generalSwitches.last()).toBeHidden()
  await expect(page.locator('body')).toHaveAttribute('data-workspace-mode', 'research')
})


test('미처리 문서의 분류를 상세 패널에서 명시적으로 변경한다', async ({ page }) => {
  const document = { id: 'manual-1', filename: 'manual.pdf', total_pages: 8, metadata: { title: 'Setup Manual' }, translated_pages: [], document_mode: 'general', document_type: 'manual', created_at: '2026-01-02T00:00:00Z' }
  await mockBaseRoutes(page, { documents: [document] })
  await page.route('**/api/document-types', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ rollout: { general_document_mode: true }, modes: [
      { value: 'research', types: [{ value: 'research_paper', mode: 'research', label: '연구 논문' }] },
      { value: 'general', types: [{ value: 'manual', mode: 'general', label: '매뉴얼' }] },
    ] }),
  }))
  await page.route('**/api/library?*', route => {
    const mode = new URL(route.request().url()).searchParams.get('document_mode') || 'research'
    const docs = document.document_mode === mode ? [document] : []
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documents: docs, total: docs.length }) })
  })
  await page.route('**/api/library/manual-1/classification', async route => {
    const payload = route.request().postDataJSON()
    Object.assign(document, payload)
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(document) })
  })

  await gotoApp(page)
  await page.locator('[data-workspace-mode="general"]').first().click()
  await page.locator('.sidebar-nav-item[data-page="library"]').click()
  await page.locator('.doc-card', { hasText: 'Setup Manual' }).click()
  await page.click('#lib-detail-more-btn')
  await page.click('#lib-detail-classification-btn')
  await expect(page.locator('#document-type-modal')).not.toHaveClass(/hidden/)
  await page.click('#document-upload-switch-mode-btn')
  await page.locator('.document-type-option', { hasText: '연구 논문' }).click()
  await page.click('#document-type-confirm-btn')
  await page.locator('.custom-confirm-btn.confirm-btn').click()
  await expect(page.locator('body')).toHaveAttribute('data-workspace-mode', 'research')
  await expect(page.locator('#library-grid')).toContainText('Setup Manual')
})
