import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, activeReader, openReaderTools, SAMPLE_PDF_A } from './helpers.js'
test.setTimeout(60_000)

const docs = [
 {id:'audit-a', filename:'alpha.pdf', total_pages:1, metadata:{title:'Alpha',primer_shown:true}, translated_pages:[]},
 {id:'audit-b', filename:'beta.pdf', total_pages:1, metadata:{title:'Beta',primer_shown:true}, translated_pages:[]},
]
test('regression: empty library still displays existing folders', async ({page}) => {
 await mockBaseRoutes(page,{documents:[],folders:[{id:'folder-a',name:'My Folder',parent_id:null,color:'#8b5cf6'}]})
 await gotoApp(page)
 await expect(page.locator('.library-folder-card[data-folder-id="folder-a"]')).toBeVisible()
})
