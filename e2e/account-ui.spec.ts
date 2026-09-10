import { test, expect } from '@playwright/test'

const credentials = {
  email: 'e2e-host@example.com',
  password: 'e2e-password-123',
}

test('shows account controls below the panel and supports logout', async ({ page, baseURL }) => {
  const apiURL = baseURL?.replace(':5173', ':8081')
  const loginResponse = await page.request.post(`${apiURL}/auth/e2e-login`, { data: credentials })
  expect(loginResponse.ok(), `${loginResponse.status()} ${await loginResponse.text()}`).toBeTruthy()

  await page.goto('/')
  const accountBadge = page.locator('.account-badge')
  const welcomePanel = page.locator('.welcome-panel')
  await expect(accountBadge).toBeVisible()
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible()
  const accountBadgeBox = await accountBadge.boundingBox()
  const welcomePanelBox = await welcomePanel.boundingBox()
  expect(accountBadgeBox?.y).toBeGreaterThan(welcomePanelBox?.y ?? 0)

  await page.getByRole('button', { name: 'Create room' }).click()
  await expect(accountBadge).toBeVisible()
  const setupBadgeBox = await accountBadge.boundingBox()
  const setupPanelBox = await page.locator('.membership-panel').boundingBox()
  expect(setupBadgeBox?.y).toBeGreaterThan(setupPanelBox?.y ?? 0)

  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(accountBadge).toBeHidden()
  await expect(page.getByRole('button', { name: /Log in to save/i })).toBeVisible()
})