// Copy this file into frontend/tests/e2e/ui-ux-audit.spec.js before running.
// These assertions describe expected behavior and expose known bugs at 6d9b2db.
import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, activeReader, openReaderTools, SAMPLE_PDF_A } from './helpers.js'
test.setTimeout(60_000)

const docs = [
 {id:'audit-a', filename:'alpha.pdf', total_pages:1, metadata:{title:'Alpha',primer_shown:true}, translated_pages:[]},
 {id:'audit-b', filename:'beta.pdf', total_pages:1, metadata:{title:'Beta',primer_shown:true}, translated_pages:[]},
]
test('audit: notes favorite works after revisiting', async ({page}) => {
 await mockBaseRoutes(page,{documents:docs}); await gotoApp(page)
 await page.click('.sidebar-nav-item[data-page="notes"]')
 await expect(page.locator('.notes-paper-row')).toHaveCount(2)
 await page.click('.sidebar-nav-item[data-page="library"]')
 await page.click('.sidebar-nav-item[data-page="notes"]')
 await expect(page.locator('.notes-paper-row')).toHaveCount(2)
 await page.locator('.notes-paper-row[data-doc-id="audit-a"] .notes-fav-btn').click()
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('easypaper_library_favorites')||'[]'))).toContain('audit-a')
})
test('audit: clearing search before debounce restores filters', async ({page}) => {
 await mockBaseRoutes(page,{documents:docs}); await gotoApp(page)
 await expect(page.locator('#library-grid .doc-card')).toHaveCount(2)
 await page.locator('#library-search-input').evaluate(el=>{el.value='alpha';el.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#library-search-clear-btn').click()})
 await page.waitForTimeout(700)
 await expect(page.locator('#library-filter-row')).toBeVisible()
})
test('audit: bulk delete failure must not show success', async ({page}) => {
 await mockBaseRoutes(page,{documents:docs})
 await page.route('**/api/library/audit-a',route=>route.request().method()==='DELETE'?route.fulfill({status:500,json:{detail:'audit delete failed'}}):route.fulfill({json:docs[0]}))
 await gotoApp(page)
 await page.locator('[data-id="audit-a"] .doc-card-check-btn').click()
 await page.click('#lib-select-delete-btn')
 await page.locator('.custom-confirm-modal .confirm-btn').click()
 await expect(page.locator('.toast')).toHaveClass(/show/); await expect(page.locator('.toast')).not.toContainText('휴지통으로 이동되었습니다')
})
test('audit: empty library still displays existing folders', async ({page}) => {
 await mockBaseRoutes(page,{documents:[],folders:[{id:'folder-a',name:'My Folder',parent_id:null,color:'#8b5cf6'}]})
 await gotoApp(page)
 await expect(page.locator('.library-folder-card[data-folder-id="folder-a"]')).toBeVisible()
})
test('audit: delete confirmation receives keyboard focus and Escape closes it', async ({page}) => {
 await mockBaseRoutes(page,{documents:docs}); await gotoApp(page)
 await page.locator('.doc-card-check-btn[data-id="audit-a"]').click()
 await page.click('#lib-select-delete-btn')
 await expect(page.locator('.custom-confirm-modal-wrapper')).toBeVisible()
 const focused = await page.evaluate(()=>!!document.activeElement.closest('.custom-confirm-modal'))
 await page.keyboard.press('Escape')
 await expect(page.locator('.custom-confirm-modal-wrapper')).toHaveCount(0)
 expect(focused).toBe(true)
})
test('audit: delayed trash response cannot replace archive after leaving trash', async ({page}) => {
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
test('audit: composing Enter must not send unfinished chat', async ({page}) => {
 await mockBaseRoutes(page,{documents:docs})
 await page.route('**/api/library/audit-a/pdf',route=>route.fulfill({contentType:'application/pdf',body:SAMPLE_PDF_A}))
 let sends=0
 await page.route('**/api/chat/stream',route=>{sends++;return route.fulfill({contentType:'text/event-stream',body:'data: [DONE]\n\n'})})
 await gotoApp(page)
 await page.evaluate(()=>location.hash='viewer?id=audit-a')
 await openReaderTools(activeReader(page))
 const input=activeReader(page).locator('#chat-input')
 await input.fill('아직 작성 중')
 await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,keyCode:229,bubbles:true})
 await page.waitForTimeout(300)
 expect(sends).toBe(0)
 await expect(input).toHaveValue('아직 작성 중')
})
test('audit: notes briefing honors configured English target language', async ({page}) => {
 await mockBaseRoutes(page,{documents:[docs[0]],languageSettings:{ui_locale:'en',default_source_language:'auto',target_language:'en'}})
 let requestedLanguage
 await page.route('**/api/library/audit-a/primer?*',route=>{
   requestedLanguage=new URL(route.request().url()).searchParams.get('target_lang')
   return route.fulfill({json:{hook:'Briefing'}})
 })
 await gotoApp(page)
 await page.click('.sidebar-nav-item[data-page="notes"]')
 await expect.poll(()=>requestedLanguage).toBeTruthy()
 expect(['en','English','영어']).toContain(requestedLanguage)
})
test('audit: notes retries briefing after temporary failure and revisit', async ({page}) => {
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
test('audit: delayed archive response must not expose permanent delete for active document', async ({page}) => {
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
