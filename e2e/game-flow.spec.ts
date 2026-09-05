import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'

type Client = {
  context: BrowserContext
  page: Page
  name: string
}

const hostCredentials = {
  email: 'e2e-host@example.com',
  password: 'e2e-password-123',
}
const playerNames = ['Alice', 'Bob', 'Charlie']
const stepDelay = Number(process.env.E2E_STEP_DELAY || 0)

async function checkpoint(client: Client, label: string): Promise<void> {
  if (stepDelay > 0) {
    await client.page.waitForTimeout(stepDelay)
  }

  await client.page.screenshot({
    path: test.info().outputPath(`${label}-${client.name}.png`),
    fullPage: true,
  })

  if (process.env.E2E_PAUSE === '1') {
    await client.page.pause()
  }

  test.info().annotations.push({ type: 'checkpoint', description: label })
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

test('host and three players can complete a live game', async ({ browser, baseURL }) => {
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
    await checkpoint(host, 'room-created')

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
    await expect(host.page.locator('.player-list .player-pill')).toHaveCount(3)
    await checkpoint(host, 'all-players-joined')

    await host.page.locator('#host-question').fill('What makes a perfect game night?')
    await host.page.locator('#host-question-form').getByRole('button', { name: 'Save question' }).click()
    await host.page.locator('[data-role="start-round"]').click()
    await checkpoint(host, 'answer-collection-started')

    for (const [index, player] of clients.slice(1).entries()) {
      await expect(player.page.locator('#player-answer')).toBeVisible()
      await player.page.locator('#player-answer').fill(`Answer from ${playerNames[index]}`)
      await player.page.locator('[data-role="submit-answer"]').click()
    }

    await expect(host.page.locator('[data-role="lock-answers"]')).toBeEnabled()
    await host.page.locator('[data-role="lock-answers"]').click()
    await checkpoint(host, 'guessing-started')

    for (let roundIndex = 0; roundIndex < playerNames.length; roundIndex += 1) {
      for (const player of clients.slice(1)) {
        const guessCards = player.page.locator('[data-guess-id]')
        if (await guessCards.count() > 0) {
          await expect(guessCards.first()).toBeVisible()
          await guessCards.first().click()
        }
      }

      await host.page.locator('[data-role="calculate-score"]').click()
      await expect(host.page.locator('[data-role="next-round"]')).toBeVisible()
      await checkpoint(host, `round-${roundIndex + 1}-complete`)
      await host.page.locator('[data-role="next-round"]').click()
    }

    await expect(host.page.locator('[data-role="new-game"]')).toBeVisible()
    await expect(host.page.locator('.leaderboard-row')).toHaveCount(3)
    await checkpoint(host, 'game-complete')
  } finally {
    await Promise.all(clients.map((client) => client.context.close()))
  }
})
