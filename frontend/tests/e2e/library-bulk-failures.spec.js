import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, activeReader, openReaderTools, SAMPLE_PDF_A } from './helpers.js'
test.setTimeout(60_000)

const docs = [
 {id:'audit-a', filename:'alpha.pdf', total_pages:1, metadata:{title:'Alpha',primer_shown:true}, translated_pages:[]},
 {id:'audit-b', filename:'beta.pdf', total_pages:1, metadata:{title:'Beta',primer_shown:true}, translated_pages:[]},
]
test('regression: bulk delete failure must not show success', async ({page}) => {
 await mockBaseRoutes(page,{documents:docs})
 await page.route('**/api/library/audit-a',route=>route.request().method()==='DELETE'?route.fulfill({status:500,json:{detail:'audit delete failed'}}):route.fulfill({json:docs[0]}))
 await gotoApp(page)
 await page.locator('[data-id="audit-a"] .doc-card-check-btn').click()
 await page.click('#lib-select-delete-btn')
 await page.locator('.custom-confirm-modal .confirm-btn').click()
 await expect(page.locator('.toast')).toHaveClass(/show/); await expect(page.locator('.toast')).not.toContainText('휴지통으로 이동되었습니다')
})
for (const action of ['delete', 'cache']) {
  test(`partial ${action} failure keeps only failed documents selected`, async ({ page }) => {
    await mockBaseRoutes(page, { documents: docs })
    const calls = []
    const suffix = action === 'cache' ? '/clear-cache' : ''
    for (const doc of docs) {
      await page.route(`**/api/library/${doc.id}${suffix}`, route => {
        calls.push(doc.id)
        return route.fulfill({ status: doc.id === 'audit-a' ? 500 : 200, json: {} })
      })
    }
    await gotoApp(page)
    for (const doc of docs) await page.locator(`.doc-card-check-btn[data-id="${doc.id}"]`).click()
    await page.click(`#lib-select-${action}-btn`)
    await page.locator('.custom-confirm-modal .confirm-btn').click()
    await expect(page.locator('#toast')).toContainText('1개 처리 완료, 1개 실패')
    expect(calls.sort()).toEqual(['audit-a', 'audit-b'])
    await expect(page.locator('.doc-card-check-btn[data-id="audit-a"]')).toHaveClass(/checked/)
    await expect(page.locator('.doc-card-check-btn[data-id="audit-b"]')).not.toHaveClass(/checked/)
    await expect(page.locator('#lib-select-count')).toContainText('1개')
  })
}
