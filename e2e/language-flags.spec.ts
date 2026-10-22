import { expect, test } from '@playwright/test'

test('welcome language flag drives the host setup screen without a room language select', async ({ page }) => {
  await page.goto('/')
  await page.locator('[data-language="he"]').click()
  await expect(page.locator('[data-language="he"]')).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: 'צור חדר' }).click()
  await expect(page.getByRole('heading', { name: 'הגדר את החדר שלך' })).toBeVisible()
  await expect(page.locator('#host-setup-language')).toHaveCount(0)

  await page.locator('[data-role="host-setup-back"]').click()
  await page.locator('[data-language="en"]').click()
  await page.getByRole('button', { name: 'Create room' }).click()
  await expect(page.getByRole('heading', { name: 'Set up your room' })).toBeVisible()
})
