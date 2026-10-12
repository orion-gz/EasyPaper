import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, activeReader, openReaderTools, SAMPLE_PDF_A } from './helpers.js'
test.setTimeout(60_000)

const docs = [
 {id:'audit-a', filename:'alpha.pdf', total_pages:1, metadata:{title:'Alpha',primer_shown:true}, translated_pages:[]},
 {id:'audit-b', filename:'beta.pdf', total_pages:1, metadata:{title:'Beta',primer_shown:true}, translated_pages:[]},
]
test('regression: clearing search before debounce restores filters', async ({page}) => {
 await mockBaseRoutes(page,{documents:docs}); await gotoApp(page)
 await expect(page.locator('#library-grid .doc-card')).toHaveCount(2)
 await page.locator('#library-search-input').evaluate(el=>{el.value='alpha';el.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#library-search-clear-btn').click()})
 await page.waitForTimeout(700)
 await expect(page.locator('#library-filter-row')).toBeVisible()
})
test('late search errors do not reappear after clearing the query', async ({ page }) => {
  await mockBaseRoutes(page, { documents: docs })
  let pending
  await page.route('**/api/library/search*', route => { pending = route })
  await gotoApp(page)
  await expect(page.locator('#library-grid .doc-card')).toHaveCount(2)
  await page.fill('#library-search-input', 'Alpha')
  await expect.poll(() => !!pending).toBe(true)
  await page.click('#library-search-clear-btn')
  await pending.fulfill({ status: 500, json: { detail: 'failure' } })
  await page.waitForTimeout(300)
  await expect(page.locator('#library-search-status')).toBeHidden()
  await expect(page.locator('#library-filter-row')).toBeVisible()
})
