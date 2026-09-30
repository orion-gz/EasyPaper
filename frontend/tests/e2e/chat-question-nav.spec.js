import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../src/chatQuestionNav.js', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../../src/style.css', import.meta.url), 'utf8')

test('question dots navigate, track scrolling, and reset with conversation history', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setContent('<aside aria-label="AI assistant" style="display:flex;flex-direction:column;width:390px;height:400px"><div id="chat-messages" class="chat-messages"></div></aside>')
  await page.addStyleTag({ content: styles })
  await page.addScriptTag({ type: 'module', content: `${source}\nmountChatQuestionNav(document.getElementById('chat-messages'))` })
  const nav = page.locator('.chat-question-nav')
  await expect(nav).toBeHidden()
  await page.evaluate(() => {
    document.getElementById('chat-messages').innerHTML = Array.from({ length: 20 }, (_, i) =>
      `<div class="chat-message user"><div class="message-bubble">Question ${i + 1}</div></div><div class="chat-message assistant" style="min-height:200px">Answer ${i + 1}</div>`).join('')
  })
  const dots = nav.getByRole('button')
  await expect(dots).toHaveCount(20)
  await dots.nth(9).click()
  await expect(dots.nth(9)).toHaveAttribute('aria-current', 'true')
  expect(await page.evaluate(() => {
    const messages = document.getElementById('chat-messages')
    return Math.abs(messages.querySelectorAll('.user')[9].getBoundingClientRect().top - messages.getBoundingClientRect().top - 20)
  })).toBeLessThan(2)
  await dots.first().focus()
  await page.keyboard.press('Enter')
  await expect(dots.first()).toHaveAttribute('aria-current', 'true')
  await page.evaluate(() => document.getElementById('chat-messages').scrollTo({ top: 1500, behavior: 'instant' }))
  await expect(dots.first()).not.toHaveAttribute('aria-current', 'true')
  await page.evaluate(() => {
    document.getElementById('chat-messages').innerHTML = '<div class="chat-message user"><div class="message-bubble">Restored question</div></div>'
  })
  await expect(dots).toHaveCount(1)
  await expect(dots.first()).toHaveAccessibleName('1. Restored question')
  await page.evaluate(() => document.getElementById('chat-messages').replaceChildren())
  await expect(nav).toBeHidden()
})

for (const scale of [0.8, 1, 1.25]) {
  test(`question tooltip and bubble alignment at UI scale ${scale}`, async ({ page }) => {
    await page.setContent('<aside aria-label="AI assistant" style="display:flex;flex-direction:column;width:390px;height:400px"><div id="chat-messages" class="chat-messages"></div></aside>')
    await page.addStyleTag({ content: styles })
    await page.evaluate(scale => { document.documentElement.style.zoom = String(scale) }, scale)
    await page.addScriptTag({ type: 'module', content: `${source}\nmountChatQuestionNav(document.getElementById('chat-messages'))` })
    await page.evaluate(() => {
      document.getElementById('chat-messages').innerHTML = Array.from({ length: 12 }, (_, i) =>
        `<div class="chat-message user"><div class="message-bubble">Question ${i + 1}: Explain this result in detail.</div></div><div class="chat-message assistant" style="min-height:250px">Answer ${i + 1}</div>`).join('')
    })
    const dots = page.locator('.chat-question-dot')
    const tooltip = page.getByRole('tooltip')
    await expect(dots).toHaveCount(12)
    await dots.nth(4).hover()
    await expect(tooltip).toHaveText('5. Question 5: Explain this result in detail.')
    // Tooltip stays inside the sidebar, including at non-default UI scales.
    const tooltipBounds = await tooltip.boundingBox()
    const sidebarBounds = await page.locator('aside').boundingBox()
    expect(tooltipBounds.x).toBeGreaterThanOrEqual(sidebarBounds.x)
    expect(tooltipBounds.x + tooltipBounds.width).toBeLessThanOrEqual(sidebarBounds.x + sidebarBounds.width)
    await page.keyboard.press('Escape')
    await expect(tooltip).toBeHidden()

    // Navigate down, then up; both paths must reveal the question itself.
    for (const index of [8, 2]) {
      await dots.nth(index).click()
      await expect.poll(() => page.evaluate(({ index, scale }) => {
        const messages = document.getElementById('chat-messages')
        const bubble = messages.querySelectorAll('.user .message-bubble')[index]
        return Math.abs((bubble.getBoundingClientRect().top - messages.getBoundingClientRect().top) / scale - 20)
      }, { index, scale })).toBeLessThan(2)
      await expect(dots.nth(index)).toHaveAttribute('aria-current', 'true')
    }
    await dots.first().focus()
    await expect(tooltip).toContainText('Question 1:')
    await page.keyboard.press('Escape')
    await expect(tooltip).toBeHidden()
  })
}
