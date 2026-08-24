import { test, expect } from '@playwright/test'
import { mockBaseRoutes } from './helpers.js'

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
