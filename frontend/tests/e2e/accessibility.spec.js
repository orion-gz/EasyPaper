import { test, expect } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from "./helpers.js"

const documentFixture = {
  id: "doc-accessibility",
  filename: "Accessible.pdf",
  total_pages: 1,
  metadata: { title: "Accessible document" },
  translated_pages: [],
}

async function openViewer(page) {
  await mockBaseRoutes(page, { documents: [documentFixture] })
  await page.route("**/api/library/doc-accessibility/pdf", route => {
    route.fulfill({ status: 200, contentType: "application/pdf", body: SAMPLE_PDF_A })
  })
  await gotoApp(page)
  await page.evaluate(() => {
    localStorage.setItem("easypaper_hydrated_doc-accessibility", "1")
    location.hash = "#viewer?id=doc-accessibility"
  })
  await expect(page.locator("#viewer-screen.active")).toBeVisible()
  await expect(page.locator(`.pdf-page-wrapper[data-page="1"]`)).toBeVisible()
}

test("뷰어 핵심 화면이 WCAG 2.2 AA 자동 검사를 통과한다", async ({ page }) => {
  await openViewer(page)

  const results = await new AxeBuilder({ page })
    .include("#viewer-screen")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze()

  expect(results.violations).toEqual([])
})

test("메뉴와 개요를 키보드로 열고 Escape로 원래 트리거에 복귀한다", async ({ page }) => {
  await openViewer(page)

  const menuButton = page.locator("#toolbar-kebab-btn")
  await menuButton.focus()
  await menuButton.press("Enter")
  await expect(menuButton).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator("#translation-scope-btn")).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(menuButton).toBeFocused()
  await expect(menuButton).toHaveAttribute("aria-expanded", "false")

  const outlineButton = page.locator("#outline-toggle-btn")
  await outlineButton.focus()
  await outlineButton.press("Enter")
  await expect(outlineButton).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press("Escape")
  await expect(outlineButton).toBeFocused()
  await expect(outlineButton).toHaveAttribute("aria-expanded", "false")
})

test("채팅 패널과 리사이저를 키보드로 조작하고 닫을 때 포커스를 복귀한다", async ({ page }) => {
  await openViewer(page)

  const toggle = page.locator("#chat-toggle-btn")
  await toggle.click()
  await expect(page.locator("#chat-sidebar")).toBeVisible()

  const resizer = page.locator("#chat-resizer")
  await resizer.focus()
  const initial = Number(await resizer.getAttribute("aria-valuenow"))
  await resizer.press("ArrowLeft")
  await expect(resizer).toHaveAttribute("aria-valuenow", String(initial + 10))
  await resizer.press("Shift+ArrowRight")
  await expect(resizer).toHaveAttribute("aria-valuenow", String(initial - 30))
  await resizer.press("Home")
  await expect(resizer).toHaveAttribute("aria-valuenow", "390")

  await page.locator("#chat-input").press("Escape")
  await expect(page.locator("#chat-sidebar")).toBeHidden()
  await expect(toggle).toBeFocused()
})
