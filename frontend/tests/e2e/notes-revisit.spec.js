import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, activeReader, openReaderTools, SAMPLE_PDF_A } from './helpers.js'
test.setTimeout(60_000)

const docs = [
 {id:'audit-a', filename:'alpha.pdf', total_pages:1, metadata:{title:'Alpha',primer_shown:true}, translated_pages:[]},
 {id:'audit-b', filename:'beta.pdf', total_pages:1, metadata:{title:'Beta',primer_shown:true}, translated_pages:[]},
]
test('regression: notes favorite works after revisiting', async ({page}) => {
 await mockBaseRoutes(page,{documents:docs}); await gotoApp(page)
 await page.click('.sidebar-nav-item[data-page="notes"]')
 await expect(page.locator('.notes-paper-row')).toHaveCount(2)
 await page.click('.sidebar-nav-item[data-page="library"]')
 await page.click('.sidebar-nav-item[data-page="notes"]')
 await expect(page.locator('.notes-paper-row')).toHaveCount(2)
 await page.locator('.notes-paper-row[data-doc-id="audit-a"] .notes-fav-btn').click()
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('easypaper_library_favorites')||'[]'))).toContain('audit-a')
})
