import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, activeReader, openReaderTools, SAMPLE_PDF_A } from './helpers.js'
test.setTimeout(60_000)

const docs = [
 {id:'audit-a', filename:'alpha.pdf', total_pages:1, metadata:{title:'Alpha',primer_shown:true}, translated_pages:[]},
 {id:'audit-b', filename:'beta.pdf', total_pages:1, metadata:{title:'Beta',primer_shown:true}, translated_pages:[]},
]
test('regression: composing Enter must not send unfinished chat', async ({page}) => {
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
 await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,bubbles:true})
 await page.waitForTimeout(200)
 expect(sends).toBe(0)
 await input.press('Enter')
 await expect.poll(()=>sends).toBe(1)
})
