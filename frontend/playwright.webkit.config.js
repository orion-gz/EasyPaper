import { defineConfig, devices } from '@playwright/test'
import baseConfig from './playwright.config.js'

// macOS의 WKWebView와 동일한 WebKit 계열에서 PDF 렌더링 회귀를 검증한다.
export default defineConfig({
  ...baseConfig,
  projects: [
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
