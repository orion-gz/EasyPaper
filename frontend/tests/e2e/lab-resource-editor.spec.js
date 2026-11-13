import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

// Exercise the actual editor in a browser without unrelated app polling.
const source = readFileSync(new URL('../../src/labResources.js', import.meta.url), 'utf8')
  .replace("import { t } from './i18n.js'", 'const t = key => key')
  .replace('export function resourceEditor', 'window.resourceEditor = function')

test('model refresh preserves focused unfinished inputs and adds/removes cards', async ({ page }) => {
  await page.setContent('<form><div class="form-actions"></div></form>')
  await page.addScriptTag({ content: source })
  await page.evaluate(() => {
    window.editor = window.resourceEditor(document.querySelector('form'), async () => {}, () => 'server')
    window.editor.load({ models: ['a', 'b'] })
  })
  const input = page.locator('[data-model="a"] input').first()
  await input.fill('')
  await input.focus()
  await page.evaluate(() => { window.original = document.activeElement; window.editor.sync(['a', 'b']) })
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('')
  await page.evaluate(() => window.editor.sync(['a', 'c']))
  await expect(input).toBeFocused()
  expect(await page.evaluate(() => document.activeElement === window.original)).toBe(true)
  await expect(page.locator('[data-model="b"]')).toHaveCount(0)
  await expect(page.locator('[data-model="c"]')).toHaveCount(1)
  await input.fill('12.5')
  expect(await page.evaluate(() => window.editor.read().models.a.parameters_billions)).toBe(12.5)
  await page.evaluate(() => window.editor.load({ models: ['a'], memory_policy: { models: { a: { parameters_billions: 3 } } } }))
  await expect(input).toHaveValue('3')
})
