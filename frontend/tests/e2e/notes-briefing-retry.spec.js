import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, activeReader, openReaderTools, SAMPLE_PDF_A } from './helpers.js'
test.setTimeout(60_000)

const docs = [
 {id:'audit-a', filename:'alpha.pdf', total_pages:1, metadata:{title:'Alpha',primer_shown:true}, translated_pages:[]},
 {id:'audit-b', filename:'beta.pdf', total_pages:1, metadata:{title:'Beta',primer_shown:true}, translated_pages:[]},
]
test('regression: notes retries briefing after temporary failure and revisit', async ({page}) => {
 await mockBaseRoutes(page,{documents:[docs[0]]})
 let attempts=0
 await page.route('**/api/library/audit-a/primer?*',route=>{
   attempts++
   return attempts===1 ? route.fulfill({status:503,json:{detail:'temporary failure'}}) : route.fulfill({json:{hook:'Recovered briefing'}})
 })
 await gotoApp(page)
 await page.click('.sidebar-nav-item[data-page="notes"]')
 await expect(page.locator('.notes-tab-content')).toContainText('브리핑을 불러오지 못했습니다')
 await page.click('.sidebar-nav-item[data-page="library"]')
 await page.click('.sidebar-nav-item[data-page="notes"]')
 await expect(page.locator('.notes-tab-content')).toContainText('Recovered briefing')
})

test('failed notes briefing can be retried without leaving the page', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [docs[0]] })
  let attempts = 0
  await page.route('**/api/library/audit-a/primer?*', route => {
    attempts++
    return attempts === 1
      ? route.fulfill({ status: 503, json: { detail: 'temporary failure' } })
      : route.fulfill({ json: { hook: 'Recovered briefing' } })
  })
  await gotoApp(page)
  await page.click('.sidebar-nav-item[data-page="notes"]')
  await page.getByRole('button', { name: '다시 시도', exact: true }).click()
  await expect(page.locator('.notes-tab-content')).toContainText('Recovered briefing')
  await expect(page.locator('.notes-summary-retry')).toHaveCount(0)
  expect(attempts).toBe(2)
})
