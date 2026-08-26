import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from './helpers.js'

test('stored locale is applied on the unauthenticated login screen', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('easypaper_ui_locale', 'en'))
  await mockBaseRoutes(page)
  await page.route('**/api/auth/check', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ detail: '인증이 필요합니다.' }) }))
  await page.goto('/index.html')
  await expect(page.locator('#login-screen')).toHaveClass(/active/)
  await expect(page.locator('#login-ui-locale')).toHaveValue('en')
  await expect(page.locator('#login-form button[type="submit"]')).toHaveText('Sign in')
  const localeBox = await page.locator('.login-language-selector').boundingBox()
  const themeBox = await page.locator('#global-theme-toggle-btn').boundingBox()
  expect(localeBox).not.toBeNull()
  expect(themeBox).not.toBeNull()
  expect(Math.abs(localeBox.y - themeBox.y)).toBeLessThanOrEqual(1)
  expect(localeBox.x + localeBox.width).toBeLessThan(themeBox.x)
  await expect.poll(() => visibleKoreanUi(page)).toEqual([])
})

test('server locale wins and navigation renders in English', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('easypaper_ui_locale', 'ko'))
  await mockBaseRoutes(page, { languageSettings: { ui_locale: 'en', default_source_language: 'auto', target_language: 'fr' } })
  await page.goto('/index.html')
  await expect(page.locator('#library-screen')).toHaveClass(/active/)
  await expect(page.locator('.sidebar-nav-item[data-page="library"] .sidebar-nav-label')).toHaveText('Paper library')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
})

test('locale selector updates onboarding immediately without reload', async ({ page }) => {
  await mockBaseRoutes(page, { workspaceSettings: { onboarding_version: 0 }, languageSettings: { ui_locale: 'ko', default_source_language: 'auto', target_language: 'ko' } })
  await page.goto('/index.html')
  await expect(page.locator('#onboarding-modal')).not.toHaveClass(/hidden/)
  await expect(page.locator('#onboarding-purpose h3')).toHaveText('EasyPaper를 어떤 용도로 사용하시나요?')
  await page.selectOption('#onboarding-ui-locale', 'en')
  await expect(page.locator('#onboarding-purpose h3')).toHaveText('How will you use EasyPaper?')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
})

async function visibleKoreanUi(page) {
  return page.evaluate(() => {
    const excluded = '[dir="auto"], [data-i18n-skip], .pdf-page, .translation-content, .chat-message-content, .memo-content'
    const visible = element => {
      const style = getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
    }
    const findings = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const parent = node.parentElement
      const value = node.nodeValue.replace(/\s+/g, ' ').trim()
      if (parent && visible(parent) && !parent.closest(excluded) && /[가-힣]/.test(value) && value !== '한국어') findings.push(value)
    }
    for (const element of document.querySelectorAll('[title], [placeholder], [aria-label]')) {
      if (!visible(element) || element.closest(excluded)) continue
      for (const attribute of ['title', 'placeholder', 'aria-label']) {
        const value = element.getAttribute(attribute) || ''
        if (/[가-힣]/.test(value)) findings.push(attribute + ': ' + value)
      }
    }
    return [...new Set(findings)]
  })
}

test('English locale has no visible Korean UI across workspace routes', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [], languageSettings: { ui_locale: 'en', default_source_language: 'auto', target_language: 'en' } })
  await page.goto('/index.html')
  for (const pageId of ['library', 'dashboard', 'history', 'chats', 'notes', 'graph']) {
    await page.click(`.sidebar-nav-item[data-page="${pageId}"]`)
    await expect(page.locator(`#page-${pageId}`)).toHaveClass(/active/)
    await expect.poll(() => visibleKoreanUi(page)).toEqual([])
    if (pageId === 'library') {
      await page.click('#lib-upload-btn')
      await expect.poll(() => visibleKoreanUi(page)).toEqual([])
    }
  }
  await page.click('#sidebar-settings-btn')
  await expect(page.locator('#settings-modal')).not.toHaveClass(/hidden/)
  await expect.poll(() => visibleKoreanUi(page)).toEqual([])
})


test('English locale has no visible Korean UI in the PDF viewer', async ({ page }) => {
  const doc = { id: 'doc-i18n-viewer', filename: 'Viewer.pdf', total_pages: 1, source_language: 'en', detected_source_language: 'en', preferred_target_language: 'fr', metadata: { title: 'Viewer document' }, translated_pages: [] }
  await mockBaseRoutes(page, { documents: [doc], languageSettings: { ui_locale: 'en', default_source_language: 'auto', target_language: 'fr' } })
  await page.route('**/api/library/doc-i18n-viewer/pdf', route => route.fulfill({ status: 200, contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=doc-i18n-viewer' })
  await expect(page.locator('#viewer-screen')).toHaveClass(/active/)
  await expect(page.locator('#viewer-scroll-container')).toBeVisible()
  await expect.poll(() => visibleKoreanUi(page)).toEqual([])
  await page.click('#chat-toggle-btn')
  await expect(page.locator('#chat-sidebar')).not.toHaveClass(/hidden/)
  await expect.poll(() => visibleKoreanUi(page)).toEqual([])
  await page.evaluate(() => {
    document.querySelector('#primer-modal').classList.remove('hidden')
    document.querySelector('#primer-loading').classList.add('hidden')
    document.querySelector('#primer-body').classList.remove('hidden')
  })
  await expect(page.locator('#primer-modal')).not.toHaveClass(/hidden/)
  await expect.poll(() => visibleKoreanUi(page)).toEqual([])
})

test('Korean locale renders every workspace route in Korean', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('easypaper_ui_locale', 'en'))
  await mockBaseRoutes(page, { documents: [], languageSettings: { ui_locale: 'ko', default_source_language: 'auto', target_language: 'ko' } })
  await page.goto('/index.html')
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko')
  await expect(page.locator('.sidebar-nav-item[data-page="library"] .sidebar-nav-label')).toHaveText('논문 라이브러리')
  for (const pageId of ['library', 'dashboard', 'history', 'chats', 'notes', 'graph']) {
    await page.click(`.sidebar-nav-item[data-page="${pageId}"]`)
    const screen = page.locator(`#page-${pageId}`)
    await expect(screen).toHaveClass(/active/)
    await expect(screen).toContainText(/[가-힣]/)
  }
  await page.click('#sidebar-settings-btn')
  await expect(page.locator('#settings-modal')).toContainText('설정')
})
