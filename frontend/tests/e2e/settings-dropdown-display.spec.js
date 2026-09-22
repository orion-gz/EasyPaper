import { test, expect } from '@playwright/test'
import { gotoApp, mockBaseRoutes } from './helpers.js'

async function expectSettingsLabels(page) {
  const selects = page.locator('#settings-modal select')
  await expect(selects).toHaveCount(10)
  for (const select of await selects.all()) {
    await expect.poll(() => select.evaluate(el =>
      document.getElementById(`${el.id}-picker-value`).textContent === (el.selectedOptions[0]?.textContent || '')
    )).toBe(true)
  }
}

test('모든 설정 dropdown이 저장값 복원과 모드 전환 후 실제 선택값을 표시한다', async ({ page }) => {
  test.setTimeout(90_000)
  await mockBaseRoutes(page, {
    languageSettings: { ui_locale: 'en', default_source_language: 'ja', target_language: 'fr' },
  })
  await page.addInitScript(() => {
    localStorage.setItem('easypaper_ui_scale', '0.8')
    localStorage.setItem('easypaper_default_zoom', '2.0')
    localStorage.setItem('easypaper_toolbar_position', 'right')
    localStorage.setItem('easypaper_style', 'literal')
    localStorage.setItem('easypaper_translation_mode', 'pane')
    localStorage.setItem('easypaper_tauri_update_check_interval', 'never')
  })
  await gotoApp(page)
  await page.locator('#sidebar-settings-btn').click()
  await expect(page.locator('#setting-toolbar-position')).toHaveValue('right')
  await expect(page.locator('#setting-trans-style')).toHaveValue('literal')
  await expect(page.locator('#setting-tauri-update-check-interval')).toHaveValue('never')
  await expect(page.locator('#setting-update-check-interval')).toHaveValue('never')
  await expectSettingsLabels(page)

  // Exercise the visible button/popover, including selecting the existing value.
  for (const category of ['general', 'translation', 'viewer', 'data-system']) {
    await page.locator(`#settings-nav-${category}`).click()
    for (const picker of await page.locator('#settings-modal .custom-select-picker:visible').all()) {
      const button = picker.locator('.provider-picker-btn')
      await button.click()
      const selected = picker.locator('[role="option"][aria-selected="true"]')
      await expect(selected).toHaveCount(1)
      await expect(button.locator('.picker-label')).toHaveText(await selected.textContent())
      await selected.click()
      await expect(button).toHaveAttribute('aria-expanded', 'false')
      await button.click()
      const other = picker.locator('[role="option"][aria-selected="false"]:not(:disabled)').last()
      await other.click()
      await expectSettingsLabels(page)
    }
  }
  await page.locator('#close-settings-btn').click()
  await page.locator('#sidebar-settings-btn').click()
  await expectSettingsLabels(page)
  await page.locator('#close-settings-btn').click()
  await page.locator('#workspace-mode-switch [data-workspace-mode="general"]').click()
  await page.locator('#sidebar-settings-btn').click()
  await expect(page.locator('#setting-trans-style')).toHaveValue('natural')
  await expect(page.locator('#setting-translation-mode')).toHaveValue('scroll')
  await expectSettingsLabels(page)
})
