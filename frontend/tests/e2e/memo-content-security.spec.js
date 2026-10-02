import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import {mockBaseRoutes,gotoApp,activeReader,evaluateReader,SAMPLE_PDF_A} from './helpers.js'
test('memo editing preserves HTML as text under production CSP',async({page})=>{
  const csp=JSON.parse(fs.readFileSync('../src-tauri/tauri.conf.json')).app.security.csp
  await page.route('**/index.html**',async route=>{const response=await route.fetch();await route.fulfill({response,headers:{...response.headers(),'Content-Security-Policy':csp}})})
  const doc={id:'audit-memo',filename:'memo.pdf',total_pages:1,metadata:{title:'Audit memo'},translated_pages:[]}
  await mockBaseRoutes(page,{documents:[doc]})
  await page.route('**/api/library/audit-memo/pdf',route=>route.fulfill({contentType:'application/pdf',body:SAMPLE_PDF_A}))
  await page.route('**/audit-missing-image',route=>route.fulfill({status:404,body:''}))
  await gotoApp(page)
  await page.evaluate(()=>{
    localStorage.setItem('easypaper_hydrated_audit-memo','1')
    localStorage.setItem('easypaper_memos_audit-memo',JSON.stringify({page_1:[{id:'audit',pageNum:1,sentenceIdx:0,sentenceText:'Sample PDF A - page 1',content:'</textarea><img src="/audit-missing-image" onerror="window.__auditExecuted=true"><textarea>',x:10,y:10}]}))
    location.hash='#viewer?id=audit-memo'
  })
  const memo=activeReader(page).locator('.floating-memo[data-id="audit"]')
  await expect(memo).toBeVisible()
  await memo.locator('.edit-btn').click()
  await expect(memo.locator('textarea')).toHaveValue('</textarea><img src="/audit-missing-image" onerror="window.__auditExecuted=true"><textarea>')
  await expect(memo.locator('img')).toHaveCount(0)
  expect(await evaluateReader(page,()=>window.__auditExecuted)).toBeUndefined()
})
