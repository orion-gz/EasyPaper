import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp } from './helpers.js'

async function mockUpdateEndpoints(page, { postUpdateShow, updateAvailable }) {
  await page.route('**/api/settings/update-check-config', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ interval: body.interval, last_checked_at: null }) })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ interval: 'weekly', last_checked_at: null }) })
  })
  await page.route('**/api/settings/update-check', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      ok: true, current_version: 'abc1234', current_version_date: '2026-07-15',
      latest_version: 'def5678', latest_version_date: '2026-07-21', update_available: updateAvailable,
      changelog: updateAvailable ? [
        { sha: 'def5678', subject: 'feat: 새 기능 추가' },
        { sha: 'aaa1111', subject: 'fix: 버그 수정' },
      ] : [],
    }),
  }))
  await page.route('**/api/settings/post-update-notice', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      show: postUpdateShow, version: 'abc1234', version_date: '2026-07-15',
      changelog: postUpdateShow ? [{ sha: 'aaa', subject: 'fix: 세션 토큰 서명 키 취약점 수정' }] : [],
    }),
  }))
}

test('방금 업데이트된 직후에는 완료 안내만 뜨고, 새 업데이트 확인 팝업과 겹치지 않는다', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [] })
  await mockUpdateEndpoints(page, { postUpdateShow: true, updateAvailable: true })
  await gotoApp(page, { navigateToLibrary: false })
  await page.waitForTimeout(1000)

  await expect(page.locator('#update-complete-modal')).not.toHaveClass(/hidden/)
  await expect(page.locator('#update-available-modal')).toHaveClass(/hidden/)
  await expect(page.locator('#update-complete-version-line')).toHaveText('버전 2026-07-15 · abc1234로 업데이트되었습니다.')

  await page.click('#update-complete-confirm-btn')
  await expect(page.locator('#update-complete-modal')).toHaveClass(/hidden/)
})

test('방금 업데이트되지 않았고 새 업데이트가 있으면 변경 로그 팝업이 뜬다', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [] })
  await mockUpdateEndpoints(page, { postUpdateShow: false, updateAvailable: true })
  await gotoApp(page, { navigateToLibrary: false })
  await page.waitForTimeout(1000)

  await expect(page.locator('#update-complete-modal')).toHaveClass(/hidden/)
  await expect(page.locator('#update-available-modal')).not.toHaveClass(/hidden/)
  await expect(page.locator('#update-available-version-line')).toHaveText('2026-07-15 · abc1234 → 2026-07-21 · def5678')
  await expect(page.locator('#update-available-changelog')).toContainText('feat: 새 기능 추가')
  await expect(page.locator('#update-available-changelog')).toContainText('fix: 버그 수정')

  await page.click('#update-available-later-btn')
  await expect(page.locator('#update-available-modal')).toHaveClass(/hidden/)
})

test('업데이트도 없고 방금 업데이트되지도 않았으면 아무 팝업도 뜨지 않는다', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [] })
  await mockUpdateEndpoints(page, { postUpdateShow: false, updateAvailable: false })
  await gotoApp(page, { navigateToLibrary: false })
  await page.waitForTimeout(1000)

  await expect(page.locator('#update-complete-modal')).toHaveClass(/hidden/)
  await expect(page.locator('#update-available-modal')).toHaveClass(/hidden/)
})

test('설정 화면에서 업데이트 확인 버튼을 누르면 새 업데이트가 있을 때만 변경 로그가 표시되고 실행 버튼이 활성화된다', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [] })
  await mockUpdateEndpoints(page, { postUpdateShow: false, updateAvailable: true })
  // 이 테스트는 설정 화면의 수동 확인/실행 버튼만 검증한다 - 자동 백그라운드
  // 확인 팝업이 함께 뜨면 설정 모달 클릭을 가로채므로 꺼둔다.
  await page.route('**/api/settings/update-check-config', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ interval: 'never', last_checked_at: null }),
  }))

  await gotoApp(page)
  await page.waitForTimeout(600)
  await page.click('#sidebar-settings-btn')
  await page.click('.tab-btn[data-tab="tab-info"]')
  await page.waitForTimeout(400)

  // 확인 전에는 실행 버튼이 비활성 상태여야 한다
  await expect(page.locator('#system-update-run-btn')).toBeDisabled()
  await expect(page.locator('#system-update-changelog-box')).toHaveClass(/hidden/)

  await page.click('#system-update-check-btn')
  await page.waitForTimeout(300)

  await expect(page.locator('#system-update-changelog-box')).not.toHaveClass(/hidden/)
  await expect(page.locator('#system-update-version-line')).toHaveText('2026-07-15 · abc1234 → 2026-07-21 · def5678')
  await expect(page.locator('#system-update-changelog')).toContainText('feat: 새 기능 추가')
  await expect(page.locator('#system-update-changelog')).toContainText('fix: 버그 수정')
  await expect(page.locator('#system-update-run-btn')).toBeEnabled()
  await expect(page.locator('#system-update-status')).toHaveText('새 업데이트가 있습니다.')
})

test('설정 화면에서 업데이트 확인 결과 이미 최신 버전이면 실행 버튼이 계속 비활성 상태로 남는다', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [] })
  await mockUpdateEndpoints(page, { postUpdateShow: false, updateAvailable: false })

  await gotoApp(page)
  await page.waitForTimeout(600)
  await page.click('#sidebar-settings-btn')
  await page.click('.tab-btn[data-tab="tab-info"]')
  await page.waitForTimeout(400)

  await page.click('#system-update-check-btn')
  await page.waitForTimeout(300)

  await expect(page.locator('#system-update-status')).toHaveText('이미 최신 버전입니다.')
  await expect(page.locator('#system-update-run-btn')).toBeDisabled()
  await expect(page.locator('#system-update-changelog-box')).toHaveClass(/hidden/)
})

test('업데이트 실행 후 확인을 다시 누르지 않고는 실행 버튼을 다시 활성화할 수 없다', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [] })
  await mockUpdateEndpoints(page, { postUpdateShow: false, updateAvailable: true })
  await page.route('**/api/settings/update-check-config', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ interval: 'never', last_checked_at: null }),
  }))

  await gotoApp(page)
  await page.waitForTimeout(600)
  await page.click('#sidebar-settings-btn')
  await page.click('.tab-btn[data-tab="tab-info"]')
  await page.waitForTimeout(400)

  await page.click('#system-update-check-btn')
  await page.waitForTimeout(300)
  await expect(page.locator('#system-update-run-btn')).toBeEnabled()

  // 다시 확인을 누르면(예: 그 사이 최신 버전이 됐다고 가정) 실행 버튼이 다시 비활성화된다
  await mockUpdateEndpoints(page, { postUpdateShow: false, updateAvailable: false })
  await page.click('#system-update-check-btn')
  await page.waitForTimeout(300)
  await expect(page.locator('#system-update-run-btn')).toBeDisabled()
})

test('설정 화면에서 업데이트 확인 주기를 변경하면 저장된다', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [] })
  await mockUpdateEndpoints(page, { postUpdateShow: false, updateAvailable: false })

  let savedInterval = null
  await page.route('**/api/settings/update-check-config', async route => {
    if (route.request().method() === 'POST') {
      savedInterval = route.request().postDataJSON().interval
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ interval: savedInterval, last_checked_at: null }) })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ interval: 'weekly', last_checked_at: null }) })
  })

  await gotoApp(page)
  await page.waitForTimeout(600)
  await page.click('#sidebar-settings-btn')
  await page.click('.tab-btn[data-tab="tab-info"]')
  await page.waitForTimeout(400)

  await expect(page.locator('#setting-update-check-interval')).toHaveValue('weekly')
  await page.selectOption('#setting-update-check-interval', 'never')
  await page.waitForTimeout(300)

  expect(savedInterval).toBe('never')
})

test('현재 버전 텍스트를 클릭하면 CHANGELOG.md 전체 내용을 보여주는 팝업이 뜬다', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [] })
  await mockUpdateEndpoints(page, { postUpdateShow: false, updateAvailable: false })
  await page.route('**/api/settings/changelog', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ content: '# Changelog\n\n## 2026-07-22\n\n- feat: 새 기능 추가 (#110)\n- fix: 버그 수정 (#111)\n' }),
  }))

  await gotoApp(page)
  await page.waitForTimeout(600)
  await page.click('#sidebar-settings-btn')
  await page.click('.tab-btn[data-tab="tab-info"]')
  await page.waitForTimeout(400)

  await expect(page.locator('#full-changelog-modal')).toHaveClass(/hidden/)
  await page.click('#current-version-label')
  await expect(page.locator('#full-changelog-modal')).not.toHaveClass(/hidden/)

  await expect(page.locator('#full-changelog-content h2').first()).toHaveText('2026-07-22')
  await expect(page.locator('#full-changelog-content')).toContainText('새 기능 추가')
  await expect(page.locator('#full-changelog-content')).toContainText('버그 수정')

  await page.click('#full-changelog-close-btn')
  await expect(page.locator('#full-changelog-modal')).toHaveClass(/hidden/)
})
