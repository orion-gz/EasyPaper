import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, activeReader, openReaderTools, SAMPLE_PDF_A } from './helpers.js'
test.setTimeout(60_000)

const docs = [
 {id:'audit-a', filename:'alpha.pdf', total_pages:1, metadata:{title:'Alpha',primer_shown:true}, translated_pages:[]},
 {id:'audit-b', filename:'beta.pdf', total_pages:1, metadata:{title:'Beta',primer_shown:true}, translated_pages:[]},
]
test('regression: delete confirmation receives keyboard focus and Escape closes it', async ({page}) => {
 await mockBaseRoutes(page,{documents:docs}); await gotoApp(page)
 await page.locator('.doc-card-check-btn[data-id="audit-a"]').click()
 await page.click('#lib-select-delete-btn')
 await expect(page.locator('.custom-confirm-modal-wrapper')).toBeVisible()
 const focused = await page.evaluate(()=>!!document.activeElement.closest('.custom-confirm-modal'))
 await page.keyboard.press('Escape')
 await expect(page.locator('.custom-confirm-modal-wrapper')).toHaveCount(0)
 expect(focused).toBe(true)
})

test('confirmation traps Tab and blocks background selection shortcuts', async ({ page }) => {
  await mockBaseRoutes(page, { documents: docs })
  await gotoApp(page)
  await page.locator('.doc-card-check-btn[data-id="audit-a"]').click()
  const trigger = page.locator('#lib-select-delete-btn')
  await trigger.click()
  const dialog = page.getByRole('dialog')
  const cancel = dialog.locator('.cancel-btn')
  const confirm = dialog.locator('.confirm-btn')
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(confirm).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Delete')
  await page.keyboard.press('Delete')
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect(page.locator('.doc-card-check-btn[data-id="audit-a"]')).toHaveClass(/checked/)
})
