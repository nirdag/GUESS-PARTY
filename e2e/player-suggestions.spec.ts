import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'

type Client = {
  context: BrowserContext
  page: Page
  name: string
}

const hostCredentials = {
  email: 'e2e-host-suggestions@example.com',
  password: 'e2e-password-123',
}
const stepDelay = Number(process.env.E2E_STEP_DELAY || 0)

async function checkpoint(client: Client, label: string): Promise<void> {
  if (stepDelay > 0) {
    await client.page.waitForTimeout(stepDelay)
  }

  // fullPage is required here: the suggestion panels render below the fold at the default viewport size.
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

// Number of guess rounds varies with player count, so loop until the game-end screen appears.
async function playRoundToGameEnd(host: Client): Promise<void> {
  while (!(await host.page.locator('[data-role="new-game"]').isVisible())) {
    await host.page.locator('[data-role="calculate-score"]').click()
    await expect(host.page.locator('[data-role="next-round"]')).toBeVisible()
    await host.page.locator('[data-role="next-round"]').click()
  }
}

test('players can suggest questions privately and the host can use, dismiss, withdraw, and consume them', async ({ browser, baseURL }) => {
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

    // Mutual exclusivity: "play as a participant" disables/unchecks "allow players to suggest questions".
    await host.page.locator('#host-setup-add-self').check()
    await expect(host.page.locator('#host-setup-allow-suggestions')).not.toBeChecked()
    await expect(host.page.locator('#host-setup-allow-suggestions')).toBeDisabled()
    await host.page.locator('#host-setup-add-self').uncheck()
    await host.page.locator('#host-setup-allow-suggestions').check()

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

    const aliceSuggestion = 'What is your favorite childhood memory?'
    const bobSuggestion = 'What is the strangest food you have ever eaten?'

    await alice.page.locator('#suggest-question-input').fill(aliceSuggestion)
    await alice.page.locator('#suggest-question-form').getByRole('button', { name: 'Submit suggestion' }).click()
    await bob.page.locator('#suggest-question-input').fill(bobSuggestion)
    await bob.page.locator('#suggest-question-form').getByRole('button', { name: 'Submit suggestion' }).click()

    // Privacy: a player only ever sees their own pending suggestions, never another player's.
    await expect(bob.page.locator('body')).not.toContainText(aliceSuggestion)
    await expect(alice.page.locator('body')).not.toContainText(bobSuggestion)
    await expect(alice.page.locator('body')).toContainText(aliceSuggestion)
    await checkpoint(alice, 'player-own-suggestion-only')

    // The host-only panel shows every suggestion.
    await expect(host.page.locator('body')).toContainText(aliceSuggestion)
    await expect(host.page.locator('body')).toContainText(bobSuggestion)
    await checkpoint(host, 'host-sees-both-suggestions')

    // Dismissing Bob's suggestion removes it from the host's list without it ever being used.
    await host.page.locator('[data-role="dismiss-suggestion"]').nth(1).click()
    await expect(host.page.locator('body')).not.toContainText(bobSuggestion)

    // Alice withdraws her own suggestion; it disappears from both her own list and the host's.
    await alice.page.locator('[data-role="withdraw-suggestion"]').click()
    await expect(alice.page.locator('body')).not.toContainText(aliceSuggestion)
    await expect(host.page.locator('body')).not.toContainText(aliceSuggestion)

    // Re-submit so we can verify "use" (pre-fill without consuming) and consume-on-start behavior.
    await alice.page.locator('#suggest-question-input').fill(aliceSuggestion)
    await alice.page.locator('#suggest-question-form').getByRole('button', { name: 'Submit suggestion' }).click()
    await expect(host.page.locator('body')).toContainText(aliceSuggestion)

    await host.page.locator('[data-role="use-suggestion"]').click()
    await expect(host.page.locator('#host-question')).toHaveValue(aliceSuggestion)
    // Picking a suggestion only pre-fills the textarea; it must still be listed until the round actually starts.
    await expect(host.page.locator('body')).toContainText(aliceSuggestion)
    await checkpoint(host, 'host-used-suggestion-still-listed')

    await host.page.locator('[data-role="start-round"]').click()

    for (const player of [alice, bob, carol]) {
      await expect(player.page.locator('#player-answer')).toBeVisible()
      await player.page.locator('#player-answer').fill(`Answer from ${player.name}`)
      await player.page.locator('[data-role="submit-answer"]').click()
    }

    await expect(host.page.locator('[data-role="lock-answers"]')).toBeEnabled()
    await host.page.locator('[data-role="lock-answers"]').click()
    await playRoundToGameEnd(host)

    await host.page.locator('[data-role="new-game"]').click()
    await expect(host.page.locator('#host-question')).toBeVisible()

    // The suggestion is gone now that its round actually started.
    await expect(host.page.locator('body')).not.toContainText(aliceSuggestion)
    await checkpoint(host, 'suggestion-consumed-after-round-start')
  } finally {
    await Promise.all(clients.map((client) => client.context.close()))
  }
})
