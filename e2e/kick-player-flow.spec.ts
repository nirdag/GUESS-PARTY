import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'

type Client = {
  context: BrowserContext
  page: Page
  name: string
}

const hostCredentials = {
  email: 'e2e-host-kick@example.com',
  password: 'e2e-password-123',
}

async function createClient(browser: Browser, name: string): Promise<Client> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.setViewportSize({ width: 720, height: 900 })
  await page.addInitScript((clientName) => {
    document.title = clientName
  }, name)
  return { context, page, name }
}

test('host can force-logout an unresponsive player from the lobby', async ({ browser, baseURL }) => {
  const clients: Client[] = []
  const host = await createClient(browser, 'Host')
  const apiURL = baseURL?.replace(':5173', ':8081')
  clients.push(host)

  try {
    const loginResponse = await host.context.request.post(`${apiURL}/auth/e2e-login`, { data: hostCredentials })
    expect(loginResponse.ok(), `${loginResponse.status()} ${await loginResponse.text()}`).toBeTruthy()

    await host.page.goto('/')
    await host.page.getByRole('button', { name: 'Create room' }).click()
    await host.page.locator('#host-setup-name').fill('Host')
    await host.page.locator('#host-setup-form').getByRole('button', { name: 'Create room' }).click()
    await expect(host.page.locator('.room-card strong')).toHaveText(/^[A-Z0-9]{6}$/)
    const roomCode = await host.page.locator('.room-card strong').innerText()

    const playerNames = ['Alice', 'Bob', 'Carol']
    for (const name of playerNames) {
      const player = await createClient(browser, name)
      clients.push(player)
      await player.page.goto('/')
      await player.page.getByRole('button', { name: 'Join room' }).click()
      await player.page.locator('#join-setup-name').fill(name)
      await player.page.locator('#join-setup-room-code').fill(roomCode)
      await player.page.locator('#join-setup-form').getByRole('button', { name: 'Join room' }).click()
      await expect(player.page.locator('.player-list')).toContainText(name)
    }
    const [alice, bob, carol] = clients.slice(1)
    await expect(host.page.locator('.player-list .player-pill')).toHaveCount(3)

    host.page.on('dialog', (dialog) => dialog.accept())
    let bobAlertMessage = ''
    bob.page.once('dialog', (dialog) => {
      bobAlertMessage = dialog.message()
      void dialog.accept()
    })

    await host.page.locator('[data-role="toggle-manage-players"]').click()
    await expect(host.page.locator('.manage-players-panel')).toContainText('Bob')
    await host.page.locator('[data-role="kick-player"][data-player-name="Bob"]').click()

    // The kicked player is bounced back to the welcome screen with an explanation.
    await expect(bob.page.locator('.welcome-panel')).toBeVisible({ timeout: 10000 })
    expect(bobAlertMessage).toContain('removed you from the room')

    // Remaining participants see the updated roster.
    await expect(host.page.locator('.player-list .player-pill')).toHaveCount(2)
    await expect(host.page.locator('.player-list')).not.toContainText('Bob')
    await expect(alice.page.locator('.player-list')).not.toContainText('Bob')
    await expect(carol.page.locator('.player-list')).not.toContainText('Bob')

    // Bob can rejoin the same room afterward under the same name.
    await bob.page.goto('/')
    await bob.page.getByRole('button', { name: 'Join room' }).click()
    await bob.page.locator('#join-setup-name').fill('Bob')
    await bob.page.locator('#join-setup-room-code').fill(roomCode)
    await bob.page.locator('#join-setup-form').getByRole('button', { name: 'Join room' }).click()
    await expect(bob.page.locator('.player-list')).toContainText('Bob')
    await expect(host.page.locator('.player-list .player-pill')).toHaveCount(3)
  } finally {
    await Promise.all(clients.map((client) => client.context.close()))
  }
})
