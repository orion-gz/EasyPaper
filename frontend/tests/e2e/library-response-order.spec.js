import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, activeReader, openReaderTools, SAMPLE_PDF_A } from './helpers.js'
test.setTimeout(60_000)

const docs = [
 {id:'audit-a', filename:'alpha.pdf', total_pages:1, metadata:{title:'Alpha',primer_shown:true}, translated_pages:[]},
 {id:'audit-b', filename:'beta.pdf', total_pages:1, metadata:{title:'Beta',primer_shown:true}, translated_pages:[]},
]
test('regression: delayed trash response cannot replace archive after leaving trash', async ({page}) => {
 await mockBaseRoutes(page,{documents:docs})
 let delay = false
 let release
 const gate = new Promise(r=>release=r)
 const trashDoc={...docs[0],id:'trash-a',filename:'deleted.pdf',metadata:{title:'Deleted'}}
 await page.route('**/api/library/trash*', async route=>{
   if(delay) await gate
   await route.fulfill({json:{documents:[trashDoc],total:1}})
 })
 await gotoApp(page)
 await expect(page.locator('#lib-tab-trash')).toBeVisible()
 delay=true
 await page.click('#lib-tab-trash')
 await page.click('#lib-tab-trash')
 await expect(page.locator('#library-grid .doc-card[data-id="audit-b"]')).toBeVisible()
 release()
 await page.waitForTimeout(400)
 await expect(page.locator('#library-grid .doc-card[data-id="trash-a"]')).toHaveCount(0)
})
test('regression: delayed archive response must not expose permanent delete for active document', async ({page}) => {
 await mockBaseRoutes(page,{documents:docs})
 let delay=false, release, started=false
 const gate=new Promise(r=>release=r)
 await page.route('**/api/library?*',async route=>{
   if(delay){started=true;await gate}
   await route.fulfill({json:{documents:docs,total:docs.length}})
 })
 const trashDoc={...docs[0],id:'trash-a',metadata:{title:'Deleted'}}
 await page.route('**/api/library/trash*',route=>route.fulfill({json:{documents:[trashDoc],total:1}}))
 await gotoApp(page)
 await expect(page.locator('.doc-card[data-id="audit-a"]')).toBeVisible()
 await page.click('#lib-tab-trash')
 await expect(page.locator('.doc-card[data-id="trash-a"]')).toBeVisible()
 await page.waitForTimeout(5100) // expire the shared library GET cache
 delay=true
 await page.click('#lib-tab-trash')
 await expect.poll(()=>started).toBe(true)
 await page.click('#lib-tab-trash')
 await expect(page.locator('.doc-card[data-id="trash-a"]')).toBeVisible()
 release()
 await page.waitForTimeout(400)
 await expect(page.locator('.doc-card[data-id="audit-a"] .doc-permanent-delete-btn')).toHaveCount(0)
})
