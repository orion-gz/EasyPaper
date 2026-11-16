import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

const source = name => readFileSync(new URL(name, import.meta.url), 'utf8')

test.beforeEach(async ({ page }) => {
  // Serve the production module unchanged, with its real dependencies and CSS.
  const files = {
    '/image.svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="100"></svg>'],
    '/releaseNotes.js': ['text/javascript', source('../../src/releaseNotes.js')],
    '/marked.js': ['text/javascript', source('../../node_modules/marked/lib/marked.esm.js')],
    '/purify.js': ['text/javascript', source('../../node_modules/dompurify/dist/purify.es.mjs')],
    '/app.css': ['text/css', source('../../src/style.css')],
    '/notes.css': ['text/css', source('../../src/styles/release-notes.css')],
  }
  await page.route('http://release-notes.test/**', route => {
    const path = new URL(route.request().url()).pathname
    const [contentType, body] = files[path] || ['text/html', `<!doctype html>
      <script type="importmap">{"imports":{"marked":"/marked.js","dompurify":"/purify.js"}}</script>
      <link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/notes.css">
      <main style="width:360px;padding:12px"><div id="notes"></div><ul class="update-changelog-list"><li id="popup"></li></ul></main>`]
    return route.fulfill({ contentType, body })
  })
  await page.goto('http://release-notes.test/')
})

async function render(page, body) {
  await page.evaluate(async body => {
    const { renderReleaseNotes, installReleaseNotesLinks } = await import('/releaseNotes.js')
    for (const id of ['notes', 'popup']) {
      const root = document.getElementById(id)
      renderReleaseNotes(root, body)
      installReleaseNotesLinks(root, url => { window.openedReleaseUrl = url })
    }
  }, body)
}

for (const theme of ['dark', 'light']) {
  test(`headings, callouts, emphasis, lists and media in ${theme} theme`, async ({ page }) => {
    if (theme === 'light') await page.evaluate(() => document.body.classList.add('light-theme'))
    await render(page, '# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6\n\n**bold** *italic* ~~deleted~~\n\n'
      + ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'].map(type => `> [!${type}]\n> **callout body**`).join('\n\n')
      + '\n\n1. first\n2. second\n\n```md\n> [!NOTE]\n```\n\n![image](http://release-notes.test/image.svg)')
    for (const id of ['notes', 'popup']) {
      const root = page.locator(`#${id}`)
      await expect(root.locator('.release-callout')).toHaveCount(5)
      await expect(root.locator('.release-callout-title').first()).toHaveText('Note')
      await expect(root.locator('.release-callout strong')).toHaveCount(5)
      await expect(root.locator('pre code')).toHaveText('> [!NOTE]\n')
      await expect(root.locator('em')).toHaveCSS('font-style', 'italic')
      await expect(root.locator('del')).toHaveCSS('text-decoration-line', 'line-through')
      await expect(root.locator('ol')).toHaveCSS('list-style-type', 'decimal')
      await root.locator('img').evaluate(image => { image.loading = 'eager' })
      await expect.poll(() => root.locator('img').evaluate(image => image.naturalWidth)).toBe(2000)
      const metrics = await root.evaluate(el => ({
        sizes: [...el.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => parseFloat(getComputedStyle(h).fontSize)),
        imageWidth: el.querySelector('img').getBoundingClientRect().width,
        width: el.getBoundingClientRect().width,
        calloutBorder: getComputedStyle(el.querySelector('blockquote')).borderLeftWidth,
      }))
      expect(metrics.sizes.every((size, index, sizes) => index === 0 || size < sizes[index - 1])).toBe(true)
      expect(metrics.imageWidth).toBeLessThanOrEqual(metrics.width)
      expect(metrics.calloutBorder).toBe('4px')
    }
  })
}

test('links and embeds open through the external browser callback', async ({ page }) => {
  await render(page, '[named link](https://example.com/docs)\n\nhttps://example.com/release\n\n<iframe title="Video" src="https://www.youtube.com/embed/example"></iframe>')
  for (const id of ['notes', 'popup']) {
    const root = page.locator(`#${id}`)
    await expect(root.locator('.release-link-card')).toHaveCount(2)
    await expect(root.locator('iframe')).toHaveCount(0)
    await expect(root.getByRole('link', { name: 'named link', exact: true })).toHaveAttribute('rel', 'noopener noreferrer')
    await root.getByRole('link', { name: 'named link', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.openedReleaseUrl)).toBe('https://example.com/docs')
    await root.locator('.release-link-card').last().click()
    await expect.poll(() => page.evaluate(() => window.openedReleaseUrl)).toBe('https://www.youtube.com/embed/example')
  }
})

test('untrusted release HTML cannot run scripts or retain unsafe embeds', async ({ page }) => {
  await render(page, '> [!WARNING] Custom title\n> safe body\n\n<script>window.releaseXss=true</script>\n<img src="x" onerror="window.releaseXss=true">\n<a href="javascript:window.releaseXss=true">unsafe</a>\n<iframe src="javascript:window.releaseXss=true"></iframe>\n<iframe srcdoc="<script>window.releaseXss=true</script>"></iframe>')
  await expect(page.locator('#notes .release-callout-title')).toHaveText('Custom title')
  await expect(page.locator('#notes script, #notes iframe, #notes [onerror], #notes a[href^="javascript:"]')).toHaveCount(0)
  expect(await page.evaluate(() => window.releaseXss)).toBeUndefined()
})
