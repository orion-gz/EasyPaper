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
