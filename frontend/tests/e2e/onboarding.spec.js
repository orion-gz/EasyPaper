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
  await expect(page.locator('#onboarding-install')).not.toHaveClass(/hidden/)
  await expect(page.locator('#onboarding-install-intro')).toContainText('사용 가능한 AI 엔진이 감지되지 않았습니다.')

  await page.click('#onboarding-skip-btn')
  await expect(page.locator('#onboarding-modal')).toHaveClass(/hidden/)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('easypaper_onboarding_seen'))).toBe('1')

  await page.reload()
  await expect(page.locator('#onboarding-modal')).toHaveClass(/hidden/)
})
