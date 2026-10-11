import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, activeReader, openReaderTools, SAMPLE_PDF_A } from './helpers.js'
test.setTimeout(60_000)

const docs = [
 {id:'audit-a', filename:'alpha.pdf', total_pages:1, metadata:{title:'Alpha',primer_shown:true}, translated_pages:[]},
 {id:'audit-b', filename:'beta.pdf', total_pages:1, metadata:{title:'Beta',primer_shown:true}, translated_pages:[]},
]
test('regression: notes briefing honors configured English target language', async ({page}) => {
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

test('notes briefing cache is separated by target language', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [docs[0]] })
  const languages = []
  await page.route('**/api/library/audit-a/primer?*', route => {
    const language = new URL(route.request().url()).searchParams.get('target_lang')
    languages.push(language)
    return route.fulfill({ json: { hook: 'Briefing ' + language } })
  })
  await gotoApp(page)
  await page.click('.sidebar-nav-item[data-page="notes"]')
  await expect(page.locator('.notes-tab-content')).toContainText('Briefing ko')
  await page.click('.sidebar-nav-item[data-page="library"]')
  await page.evaluate(() => localStorage.setItem('easypaper_target_lang_research', 'en'))
  await page.click('.sidebar-nav-item[data-page="notes"]')
  await expect(page.locator('.notes-tab-content')).toContainText('Briefing en')
  await page.click('.sidebar-nav-item[data-page="library"]')
  await page.evaluate(() => localStorage.setItem('easypaper_target_lang_research', 'ko'))
  await page.click('.sidebar-nav-item[data-page="notes"]')
  await expect(page.locator('.notes-tab-content')).toContainText('Briefing ko')
  expect(languages).toEqual(['ko', 'en'])
})
