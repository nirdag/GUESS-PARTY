import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'

type Client = {
  context: BrowserContext
  page: Page
  name: string
}

const hostCredentials = {
  email: 'e2e-host-pool@example.com',
  password: 'e2e-password-123',
}
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

test('pre-game question pool gathering, host moderation, player ready confirmation, and multi-question game flow', async ({ browser, baseURL }) => {
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

    // Check Question Pool mode
    await host.page.locator('#host-setup-question-pool').check()
    await expect(host.page.locator('#host-setup-allow-suggestions')).toBeDisabled()

    await host.page.locator('#host-setup-form').getByRole('button', { name: 'Create room' }).click()
    await expect(host.page.locator('.room-card strong')).toHaveText(/^[A-Z0-9]{6}$/)
    const roomCode = await host.page.locator('.room-card strong').innerText()

    // Host sees Start button disabled initially
    await expect(host.page.locator('[data-role="start-round"]')).toBeDisabled()

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

    const aliceQuestion = 'What is your absolute favorite hobby on weekends?'
    const bobQuestion = 'What is the strangest pizza topping you ever tried?'
    const carolBadQuestion = 'Inappropriate question that host will discard?'

    // Alice submits a question
    await alice.page.locator('#pool-question-input').fill(aliceQuestion)
    await alice.page.locator('#pool-question-form').getByRole('button', { name: 'Submit question' }).click()

    // Bob submits a question
    await bob.page.locator('#pool-question-input').fill(bobQuestion)
    await bob.page.locator('#pool-question-form').getByRole('button', { name: 'Submit question' }).click()

    // Carol submits a bad question
    await carol.page.locator('#pool-question-input').fill(carolBadQuestion)
    await carol.page.locator('#pool-question-form').getByRole('button', { name: 'Submit question' }).click()

    // Privacy verification: Players do not see each others' questions
    await expect(alice.page.locator('body')).toContainText(aliceQuestion)
    await expect(alice.page.locator('body')).not.toContainText(bobQuestion)
    await expect(alice.page.locator('body')).not.toContainText(carolBadQuestion)

    await expect(bob.page.locator('body')).toContainText(bobQuestion)
    await expect(bob.page.locator('body')).not.toContainText(aliceQuestion)
    await expect(bob.page.locator('body')).not.toContainText(carolBadQuestion)

    // Host inspection verification: Host sees all 3 questions with authors
    await expect(host.page.locator('.host-moderation-panel')).toContainText(aliceQuestion)
    await expect(host.page.locator('.host-moderation-panel')).toContainText(bobQuestion)
    await expect(host.page.locator('.host-moderation-panel')).toContainText(carolBadQuestion)
    await checkpoint(host, 'host-inspects-all-questions')

    // Host discards Carol's question
    const discardButtons = host.page.locator('[data-role="discard-pool-question"]')
    await expect(discardButtons).toHaveCount(3)
    await discardButtons.nth(2).click()

    // Question disappears from host and from Carol
    await expect(host.page.locator('.host-moderation-panel')).not.toContainText(carolBadQuestion)
    await expect(carol.page.locator('body')).not.toContainText(carolBadQuestion)

    // Start button is still disabled because players haven't confirmed ready
    await expect(host.page.locator('[data-role="start-round"]')).toBeDisabled()

    // Players confirm ready
    await alice.page.locator('[data-role="toggle-pool-ready"]').click()
    await expect(alice.page.locator('body')).toContainText('Ready to play')

    await bob.page.locator('[data-role="toggle-pool-ready"]').click()
    await expect(bob.page.locator('body')).toContainText('Ready to play')

    await carol.page.locator('[data-role="toggle-pool-ready"]').click()
    await expect(carol.page.locator('body')).toContainText('Ready to play')

    // Now all players are ready, host start button becomes enabled!
    await expect(host.page.locator('[data-role="start-round"]')).toBeEnabled()
    await checkpoint(host, 'all-ready-start-enabled')

    // Host starts round 1
    await host.page.locator('[data-role="start-round"]').click()

    // Round 1 answering phase: All 3 players see player-answering screen
    await expect(alice.page.locator('#player-answer')).toBeVisible()
    await expect(bob.page.locator('#player-answer')).toBeVisible()
    await expect(carol.page.locator('#player-answer')).toBeVisible()
    await expect(alice.page.locator('.player-answer-panel h1')).toHaveText(/Question by (Alice|Bob): /)
    await expect(bob.page.locator('.player-answer-panel h1')).toHaveText(/Question by (Alice|Bob): /)
    await expect(carol.page.locator('.player-answer-panel h1')).toHaveText(/Question by (Alice|Bob): /)

    await alice.page.locator('#player-answer').fill('Alice answer for Q1')
    await alice.page.locator('[data-role="submit-answer"]').click()

    await bob.page.locator('#player-answer').fill('Bob answer for Q1')
    await bob.page.locator('[data-role="submit-answer"]').click()

    await carol.page.locator('#player-answer').fill('Carol answer for Q1')
    await carol.page.locator('[data-role="submit-answer"]').click()

    // Host locks answers for Question 1
    await host.page.locator('[data-role="lock-answers"]').click()

    // Play through all guess rounds for Question 1 until Question 2 answering screen appears
    while (!(await alice.page.locator('#player-answer').isVisible())) {
      if (await host.page.locator('[data-role="calculate-score"]').isVisible()) {
        await host.page.locator('[data-role="calculate-score"]').click()
      }
      if (await host.page.locator('[data-role="confirm-next-round"]').isVisible()) {
        for (const client of [host, alice, bob, carol]) {
          await client.page.locator('[data-role="confirm-next-round"]').click()
        }
      }
      await host.page.waitForTimeout(200)
    }

    // Question 2 answering phase
    await expect(alice.page.locator('#player-answer')).toBeVisible()
    await expect(bob.page.locator('#player-answer')).toBeVisible()
    await expect(carol.page.locator('#player-answer')).toBeVisible()

    await alice.page.locator('#player-answer').fill('Alice answer for Q2')
    await alice.page.locator('[data-role="submit-answer"]').click()

    await bob.page.locator('#player-answer').fill('Bob answer for Q2')
    await bob.page.locator('[data-role="submit-answer"]').click()

    await carol.page.locator('#player-answer').fill('Carol answer for Q2')
    await carol.page.locator('[data-role="submit-answer"]').click()

    // Host locks answers for Question 2
    await host.page.locator('[data-role="lock-answers"]').click()

    // Play through guessing for Question 2 until game-end appears
    while (!(await host.page.locator('[data-role="new-game"]').isVisible())) {
      if (await host.page.locator('[data-role="calculate-score"]').isVisible()) {
        await host.page.locator('[data-role="calculate-score"]').click()
      }
      if (await host.page.locator('[data-role="confirm-next-round"]').isVisible()) {
        for (const client of [host, alice, bob, carol]) {
          await client.page.locator('[data-role="confirm-next-round"]').click()
        }
      }
      await host.page.waitForTimeout(200)
    }

    await expect(host.page.locator('[data-role="new-game"]')).toBeVisible()
    await checkpoint(host, 'game-end-reached')
  } finally {
    for (const client of clients) {
      await client.context.close().catch(() => {})
    }
  }
})
