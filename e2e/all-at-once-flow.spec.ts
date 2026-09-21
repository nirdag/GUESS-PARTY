import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'

type Client = {
  context: BrowserContext
  page: Page
  name: string
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

// Tap-to-select then tap-to-place is used here instead of simulated dragging, since it's the more
// reliable input path for Playwright and exercises the same placeMatchToken() code path as a real drag.
async function placeMatchToken(client: Client, authorName: string, answerText: string): Promise<void> {
  await client.page.locator('[data-role="matching-token"]', { hasText: authorName }).click()
  await client.page.locator('[data-role="matching-slot"]', { hasText: answerText }).click()
}

test('all-at-once guessing mode: full matching board flow with rank-based scoring', async ({ browser }) => {
  const clients: Client[] = []
  const host = await createClient(browser, 'Host')
  clients.push(host)

  try {
    await host.page.goto('/')
    await host.page.getByRole('button', { name: 'Create room' }).click()
    await host.page.locator('#host-setup-name').fill('Host')

    // Opt into the all-at-once guessing flow instead of the default one-at-a-time flow.
    await host.page.locator('input[name="host-setup-guess-flow"][value="allAtOnce"]').check()

    await host.page.locator('#host-setup-form').getByRole('button', { name: 'Create room' }).click()
    await expect(host.page.locator('.room-card strong')).toHaveText(/^[A-Z0-9]{6}$/)
    await expect(host.page.locator('.identity-flow-badge')).toHaveText('All at once')
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

    await host.page.locator('#host-question').fill('What is the best way to spend a lazy Sunday?')
    await host.page.locator('#host-question-form').getByRole('button', { name: 'Save question' }).click()
    await host.page.locator('[data-role="start-round"]').click()

    const answers = new Map([
      [alice.name, 'Alice loves rainy afternoons'],
      [bob.name, 'Bob loves surprise parties'],
      [carol.name, 'Carol loves board games'],
    ])

    for (const [client, text] of [
      [alice, answers.get('Alice')!],
      [bob, answers.get('Bob')!],
      [carol, answers.get('Carol')!],
    ] as const) {
      await client.page.locator('#player-answer').fill(text)
      await client.page.locator('[data-role="submit-answer"]').click()
    }

    await host.page.locator('[data-role="lock-answers"]').click()

    // The matching board (not the sequential one-answer-at-a-time screen) should appear for every player.
    for (const client of [alice, bob, carol]) {
      await expect(client.page.locator('[data-role="matching-slot"]')).toHaveCount(3)
      await expect(client.page.locator('[data-role="matching-token"]')).toHaveCount(3)
      await expect(client.page.locator('.matching-token-drag-hint')).toHaveCount(3)
    }
    const ltrSlot = await alice.page.locator('[data-role="matching-slot"]').first().boundingBox()
    const ltrToken = await alice.page.locator('[data-role="matching-token"]').first().boundingBox()
    const secondLtrToken = await alice.page.locator('[data-role="matching-token"]').nth(1).boundingBox()
    expect(ltrSlot).not.toBeNull()
    expect(ltrToken).not.toBeNull()
    expect(secondLtrToken).not.toBeNull()
    expect(ltrSlot!.x).toBeLessThan(ltrToken!.x)
    expect(secondLtrToken!.y).toBeGreaterThan(ltrToken!.y)
    expect(secondLtrToken!.x).toBe(ltrToken!.x)

    await alice.page.mouse.move(ltrToken!.x + ltrToken!.width / 2, ltrToken!.y + ltrToken!.height / 2)
    await alice.page.mouse.down()
    await alice.page.mouse.move(ltrToken!.x + ltrToken!.width / 2 + 10, ltrToken!.y + ltrToken!.height / 2 + 10)
    await expect(alice.page.locator('.matching-token-ghost')).toBeVisible()
    const dragGhost = await alice.page.locator('.matching-token-ghost').boundingBox()
    expect(dragGhost).not.toBeNull()
    expect(dragGhost!.width).toBeCloseTo(ltrToken!.width, 1)
    await alice.page.mouse.up()

    // A tentative match can be removed before the final drop, returning its name to the token column.
    await placeMatchToken(alice, alice.name, answers.get(alice.name)!)
    await expect(alice.page.locator('[data-role="remove-match"]')).toHaveCount(1)
    await alice.page.locator('[data-role="remove-match"]').click()
    await expect(alice.page.locator('[data-role="matching-slot"].filled')).toHaveCount(0)
    await expect(alice.page.locator('[data-role="matching-token"]')).toHaveCount(3)

    // Every player fully matches all 3 answers - including their own, per design (no board is missing an entry).
    for (const client of [alice, bob, carol]) {
      for (const [name, text] of answers) {
        await placeMatchToken(client, name, text)
      }
      await expect(client.page.locator('[data-role="matching-token"]')).toHaveCount(0)
      await expect(client.page.locator('.matching-token-drag-hint')).toHaveCount(0)
      await expect(client.page.locator('[data-role="remove-match"]')).toHaveCount(0)
    }

    // Round auto-completes once everyone is done; no manual "lock"/"calculate score" step exists for this mode.
    await expect(host.page.locator('.leaderboard')).toBeVisible()

    // Each answer had 3 correct guessers ranked 3/2/1 by placement speed -> 6 points distributed per answer,
    // 18 points total across all 3 answers, split across the 3 players.
    const scoreTexts = await host.page.locator('.leaderboard-row strong').allInnerTexts()
    const totalScore = scoreTexts.reduce((sum, text) => sum + Number(text.replace(/\D/g, '')), 0)
    expect(totalScore).toBe(18)

    for (const client of [host, alice, bob, carol]) {
      await client.page.locator('[data-role="confirm-next-round"]').click()
    }

    await expect(host.page.locator('[data-role="new-game"]')).toBeVisible()
  } finally {
    for (const client of clients) {
      await client.context.close().catch(() => {})
    }
  }
})

// Regression test: host-setup previously only synced the guess-flow radio's value into state on form submit,
// so any other re-render of the host-setup screen in between (e.g. re-picking an avatar) silently reverted the
// selection back to 'sequential' before it ever reached the server - reproduces the exact combo that surfaced it.
test('all-at-once mode survives a host-setup re-render when combined with host-as-player and question-pool mode', async ({ browser }) => {
  const clients: Client[] = []
  const host = await createClient(browser, 'Host')
  clients.push(host)

  try {
    await host.page.goto('/')
    await host.page.getByRole('button', { name: 'Create room' }).click()
    await host.page.locator('#host-setup-name').fill('Host')
    await host.page.locator('#host-setup-language').selectOption('he')

    // Re-pick an avatar AFTER selecting the mode, to force a full host-setup re-render before submit.
    await host.page.locator('input[name="host-setup-guess-flow"][value="allAtOnce"]').check()
    await host.page.locator('#host-setup-add-self').check()
    await host.page.locator('#host-setup-question-pool').check()
    await host.page.locator('[data-avatar]').nth(2).click()
    await expect(host.page.locator('input[name="host-setup-guess-flow"][value="allAtOnce"]')).toBeChecked()
    await expect(host.page.locator('#host-setup-add-self')).toBeChecked()
    await expect(host.page.locator('#host-setup-question-pool')).toBeChecked()

    await host.page.locator('#host-setup-form button[type="submit"]').click()
    await expect(host.page.locator('.room-card strong')).toHaveText(/^[A-Z0-9]{6}$/)
    const roomCode = await host.page.locator('.room-card strong').innerText()

    const playerNames = ['Alice', 'Bob']
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

    const [alice, bob] = clients.slice(1)

    for (const client of [host, alice, bob]) {
      await client.page.locator('#pool-question-input').fill(`${client.name} favorite childhood memory?`)
      await client.page.locator('#pool-question-form button[type="submit"]').click()
    }
    for (const client of [host, alice, bob]) {
      await client.page.locator('[data-role="toggle-pool-ready"]').click()
    }

    await expect(host.page.locator('[data-role="start-round"]')).toBeEnabled()
    await host.page.locator('[data-role="start-round"]').click()

    const answers = new Map([
      [host.name, 'Host answer'],
      [alice.name, 'Alice answer'],
      [bob.name, 'Bob answer'],
    ])
    for (const [client, text] of [[host, answers.get('Host')!], [alice, answers.get('Alice')!], [bob, answers.get('Bob')!]] as const) {
      await client.page.locator('#player-answer').fill(text)
      await client.page.locator('[data-role="submit-answer"]').click()
    }

    await host.page.locator('[data-role="lock-answers"]').click()

    // The matching board (not the sequential one-answer-at-a-time screen) must appear for everyone, host included.
    for (const client of [host, alice, bob]) {
      await expect(client.page.locator('[data-role="matching-slot"]')).toHaveCount(3)
    }
    await expect(host.page.locator('html')).toHaveAttribute('dir', 'rtl')
    const rtlSlot = await host.page.locator('[data-role="matching-slot"]').first().boundingBox()
    const rtlToken = await host.page.locator('[data-role="matching-token"]').first().boundingBox()
    expect(rtlSlot).not.toBeNull()
    expect(rtlToken).not.toBeNull()
    expect(rtlSlot!.x).toBeGreaterThan(rtlToken!.x)

    for (const client of [host, alice, bob]) {
      for (const [name, text] of answers) {
        await placeMatchToken(client, name, text)
      }
    }

    await expect(host.page.locator('.leaderboard')).toBeVisible()
  } finally {
    for (const client of clients) {
      await client.context.close().catch(() => {})
    }
  }
})
