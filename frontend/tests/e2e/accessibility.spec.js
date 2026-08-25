import { test, expect } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A, SAMPLE_PDF_CITATION } from "./helpers.js"

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

test("뷰어 툴바를 Tab만으로 논리적인 순서로 이동하고 포커스를 식별한다", async ({ page }) => {
  await openViewer(page)

  const tabOrder = [
    "#back-btn",
    "#logo-btn",
    "#viewer-read-toggle-btn",
    "#outline-toggle-btn",
    "#doc-title-edit-btn",
    "#page-input",
    "#zoom-out-btn",
    "#zoom-in-btn",
    "#capture-area-btn",
    "#chat-toggle-btn",
    "#toolbar-kebab-btn",
  ]

  await page.locator(tabOrder[0]).focus()
  for (let index = 0; index < tabOrder.length; index += 1) {
    const control = page.locator(tabOrder[index])
    await expect(control).toBeFocused()
    if (index < tabOrder.length - 1) await page.keyboard.press("Tab")
  }

  const focusStyle = await page.locator("#toolbar-kebab-btn").evaluate(element => {
    const style = getComputedStyle(element)
    return { style: style.outlineStyle, width: style.outlineWidth }
  })
  expect(focusStyle.style).not.toBe("none")
  expect(focusStyle.width).not.toBe("0px")
})

test("열린 채팅 패널과 메뉴도 WCAG 2.2 AA 자동 검사를 통과한다", async ({ page }) => {
  await openViewer(page)

  await page.locator("#chat-toggle-btn").press("Enter")
  await expect(page.locator("#chat-sidebar")).toBeVisible()
  await page.locator("#toolbar-kebab-btn").press("Space")
  await expect(page.locator("#toolbar-kebab-menu")).toBeVisible()
  await expect(page.locator("#toolbar-kebab-btn")).toHaveAttribute("aria-haspopup", "dialog")
  await expect(page.locator("#toolbar-kebab-menu")).toHaveAttribute("role", "dialog")

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

test("인용 오버레이를 키보드로 열고 Escape로 트리거에 복귀한다", async ({ page }) => {
  const citationDocument = {
    id: "doc-C",
    filename: "Citation.pdf",
    total_pages: 1,
    metadata: { title: "Citation Sample Paper" },
    translated_pages: [],
  }
  await mockBaseRoutes(page, { documents: [citationDocument] })
  await page.route("**/api/library/doc-C/pdf", route => {
    route.fulfill({ status: 200, contentType: "application/pdf", body: SAMPLE_PDF_CITATION })
  })
  await page.route("**/api/library/doc-C/references", route => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ references: { "1": "Vaswani et al. Attention Is All You Need. 2017." } }),
    })
  })

  await gotoApp(page)
  await page.evaluate(() => { location.hash = "#viewer?id=doc-C" })
  const trigger = page.locator(".citation-marker-box").first()
  await expect(trigger).toBeVisible()
  await trigger.focus()
  await trigger.press("Space")

  const tooltip = page.locator(".citation-tooltip")
  await expect(tooltip).toBeVisible()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await expect(tooltip.locator(".citation-tooltip-resolve-btn")).toBeFocused()

  await page.keyboard.press("Escape")
  await expect(tooltip).toBeHidden()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await expect(trigger).toBeFocused()
})
