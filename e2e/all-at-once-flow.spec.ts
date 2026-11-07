import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { placeAll } from '../scenarios/engine.mjs'

type Client = {
  context: BrowserContext
  page: Page
  name: string
}

async function createClient(browser: Browser, name: string, mobile = false): Promise<Client> {
  const context = await browser.newContext(mobile ? { isMobile: true, hasTouch: true } : {})
  const page = await context.newPage()
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 720, height: 900 })
  await page.addInitScript((clientName) => {
    document.title = clientName
    window.localStorage.setItem('guess-party-language', 'en')
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
    await host.page.locator('#host-setup-random-playlist').uncheck()

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

    await host.page.locator('#host-queue-question').fill('What is the best way to spend a lazy Sunday?')
    await host.page.locator('#host-question-queue-form').getByRole('button', { name: 'Add question' }).click()
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
      // Each player authored one of the 3 answers, so their own board only has the other 2 to match.
      await expect(client.page.locator('[data-role="matching-slot"]')).toHaveCount(2)
      await expect(client.page.locator('[data-role="matching-token"]')).toHaveCount(2)
      await expect(client.page.locator('.matching-token-drag-hint')).toHaveCount(2)
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
    // Alice never sees her own answer/name on the board, so she matches one of the other two players here.
    await placeMatchToken(alice, bob.name, answers.get(bob.name)!)
    await expect(alice.page.locator('[data-role="remove-match"]')).toHaveCount(1)
    await alice.page.locator('[data-role="remove-match"]').click()
    await expect(alice.page.locator('[data-role="matching-slot"].filled')).toHaveCount(0)
    await expect(alice.page.locator('[data-role="matching-token"]')).toHaveCount(2)

    // The scenario helper swaps Bob's two authors; the default and explicit correct outcomes stay correct.
    for (const client of [alice, bob, carol]) {
      await placeAll(client, playerNames, client === bob ? 'wrong' : client === carol ? 'correct' : undefined)
      await expect(client.page.locator('[data-role="matching-token"]')).toHaveCount(0)
      await expect(client.page.locator('.matching-token-drag-hint')).toHaveCount(0)
      await expect(client.page.locator('[data-role="remove-match"]')).toHaveCount(0)
    }

    // Round auto-completes once everyone is done; no manual "lock"/"calculate score" step exists for this mode.
    await expect(host.page.locator('.leaderboard')).toBeVisible()

    // Alice and Carol are correct on both their guesses; Bob's two swapped guesses earn no points.
    const scoreTexts = await host.page.locator('.leaderboard-row strong').allInnerTexts()
    const totalScore = scoreTexts.reduce((sum, text) => sum + Number(text.replace(/\D/g, '')), 0)
    expect(totalScore).toBe(5)

    const answerPairs = alice.page.locator('.round-answer-pair')
    await expect(answerPairs).toHaveCount(3)
    for (let index = 0; index < await answerPairs.count(); index += 1) {
      const answerPair = answerPairs.nth(index)
      const answerField = answerPair.locator('.round-answer-field').nth(0)
      const authorField = answerPair.locator('.round-answer-field').nth(1)
      const answerText = await answerField.innerText()
      const authorName = await authorField.innerText()
      const expectedAuthor = [...answers.entries()].find(([, text]) => answerText.includes(text))?.[0]
      expect(expectedAuthor).toBeTruthy()
      expect(authorName).toContain(expectedAuthor!)

      const answerBox = await answerField.boundingBox()
      const authorBox = await authorField.boundingBox()
      expect(answerBox).not.toBeNull()
      expect(authorBox).not.toBeNull()
      expect(answerBox!.x).toBeLessThan(authorBox!.x)
      expect(Math.abs(answerBox!.y - authorBox!.y)).toBeLessThan(1)
    }

    // Tabs are sorted by finishing position, and each card shows the selected player's result for that answer.
    const resultTabs = alice.page.locator('[data-role="all-at-once-result-tab"]')
    await expect(resultTabs).toHaveCount(3)
    // Clients finished in loop order, so the tabs are sorted by finishing position and badged accordingly.
    await expect(resultTabs.nth(0)).toContainText('1st')
    await expect(resultTabs.nth(0)).toContainText(alice.name)
    await expect(resultTabs.nth(1)).toContainText('2nd')
    await expect(resultTabs.nth(1)).toContainText(bob.name)
    await expect(resultTabs.nth(2)).toContainText('3rd')
    await expect(resultTabs.nth(2)).toContainText(carol.name)
    await expect(resultTabs.filter({ hasText: alice.name })).toHaveAttribute('aria-selected', 'true')
    await expect(alice.page.locator('.all-at-once-results-total strong')).toHaveText('3 pts')
    const card = (client: Client, author: string) => client.page.locator('.round-answer-pair').filter({ hasText: answers.get(author)! })
    await expect(card(alice, 'Alice').locator('[data-role="answer-feedback"]')).toHaveText('Your answer — not eligible for points')
    await expect(card(alice, 'Bob').locator('[data-role="answer-feedback"]')).toHaveText('You guessed Bob · ✅ Correct! +2 pts')
    await expect(card(alice, 'Carol').locator('[data-role="answer-feedback"]')).toHaveText('You guessed Carol · ✅ Correct! +1 pts')
    await expect(alice.page.locator('.all-at-once-results-panel .result-row')).toHaveCount(0)

    await resultTabs.filter({ hasText: bob.name }).click()
    await expect(resultTabs.filter({ hasText: bob.name })).toHaveAttribute('aria-selected', 'true')
    await expect(alice.page.locator('.all-at-once-results-total strong')).toHaveText('0 pts')
    await expect(card(alice, 'Bob').locator('[data-role="answer-feedback"]')).toHaveText("Bob's answer — not eligible for points")
    await expect(card(alice, 'Alice').locator('[data-role="answer-feedback"]')).toHaveText('Bob guessed Carol · ❌ Missed it · 0 pts')
    await expect(card(alice, 'Carol').locator('[data-role="answer-feedback"]')).toHaveText('Bob guessed Alice · ❌ Missed it · 0 pts')
    await expect(card(alice, 'Alice').locator('.round-answer-author')).toContainText('Alice')
    await host.page.locator('[data-role="all-at-once-result-tab"]').filter({ hasText: bob.name }).click()
    await expect(card(host, 'Alice').locator('[data-role="answer-feedback"]')).toHaveText('Bob guessed Carol · ❌ Missed it · 0 pts')

    // Another player's confirmation broadcasts room state, but must not reset Alice's selected result tab.
    await host.page.locator('[data-role="confirm-next-round"]').click()
    await expect(resultTabs.filter({ hasText: bob.name })).toHaveAttribute('aria-selected', 'true')

    for (const client of [alice, bob, carol]) {
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
    await host.page.locator('[data-language="he"]').click()
    await host.page.locator('[data-role="create-room"]').click()
    await host.page.locator('#host-setup-name').fill('Host')

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
    // Each client authored one of the 3 answers, so their own board only has the other 2 to match.
    for (const client of [host, alice, bob]) {
      await expect(client.page.locator('[data-role="matching-slot"]')).toHaveCount(2)
    }
    await expect(host.page.locator('html')).toHaveAttribute('dir', 'rtl')
    const rtlSlot = await host.page.locator('[data-role="matching-slot"]').first().boundingBox()
    const rtlToken = await host.page.locator('[data-role="matching-token"]').first().boundingBox()
    expect(rtlSlot).not.toBeNull()
    expect(rtlToken).not.toBeNull()
    expect(rtlSlot!.x).toBeGreaterThan(rtlToken!.x)

    for (const client of [host, alice, bob]) {
      for (const [name, text] of answers) {
        if (name === client.name) {
          continue
        }
        await placeMatchToken(client, name, text)
      }
    }

    await expect(host.page.locator('.leaderboard')).toBeVisible()
    await expect(host.page.locator('.round-answer-pair')).toHaveCount(3)
    await expect(host.page.locator('.round-answer-pair').filter({ hasText: 'Host answer' }).locator('[data-role="answer-feedback"]')).toHaveText('התשובה שלך — לא מזכה בנקודות')
    await expect(host.page.locator('.round-answer-pair').filter({ hasText: 'Alice answer' }).locator('[data-role="answer-feedback"]')).toContainText('ניחשת את Alice')
  } finally {
    for (const client of clients) {
      await client.context.close().catch(() => {})
    }
  }
})

test('mobile pool matching keeps unmatched answers above completed matches', async ({ browser }) => {
  const clients: Client[] = []
  const host = await createClient(browser, 'Host')
  clients.push(host)

  try {
    await host.page.goto('/')
    await host.page.getByRole('button', { name: 'Create room' }).click()
    await host.page.locator('#host-setup-name').fill(host.name)
    await host.page.locator('input[name="host-setup-guess-flow"][value="allAtOnce"]').check()
    await host.page.locator('#host-setup-question-pool').check()
    await host.page.locator('#host-setup-form button[type="submit"]').click()
    await expect(host.page.locator('.room-card strong')).toHaveText(/^[A-Z0-9]{6}$/)
    const roomCode = await host.page.locator('.room-card strong').innerText()

    for (const name of ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank']) {
      const player = await createClient(browser, name, name === 'Alice')
      clients.push(player)
      await player.page.goto('/')
      await player.page.getByRole('button', { name: 'Join room' }).click()
      await player.page.locator('#join-setup-name').fill(name)
      await player.page.locator('#join-setup-room-code').fill(roomCode)
      await player.page.locator('#join-setup-form button[type="submit"]').click()
      await expect(player.page.locator('.player-list')).toContainText(name)
    }

    const players = clients.slice(1)
    for (const player of players) {
      await player.page.locator('#pool-question-input').fill(`${player.name}'s favorite memory?`)
      await player.page.locator('#pool-question-form button[type="submit"]').click()
      await player.page.locator('[data-role="toggle-pool-ready"]').click()
    }
    await expect(host.page.locator('[data-role="start-round"]')).toBeEnabled()
    await host.page.locator('[data-role="start-round"]').click()
    for (const player of players) {
      await player.page.locator('#player-answer').fill(`${player.name} answer`)
      await player.page.locator('[data-role="submit-answer"]').click()
    }
    await expect(host.page.locator('[data-role="lock-answers"]')).toBeEnabled()
    await host.page.locator('[data-role="lock-answers"]').click()

    const alice = players[0]
    const slots = alice.page.locator('[data-role="matching-slot"]')
    const tokens = alice.page.locator('[data-role="matching-token"]')
    await expect(slots).toHaveCount(5)
    await expect(tokens).toHaveCount(5)
    const originalIds = await slots.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-slot-id')))
    const slot = (id: string | null) => alice.page.locator(`[data-role="matching-slot"][data-slot-id="${id}"]`)
    const slotOrder = () => slots.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-slot-id')))

    await tokens.first().tap()
    await slot(originalIds[0]).tap()
    await expect.poll(slotOrder).toEqual([...originalIds.slice(1), originalIds[0]])
    await expect(slot(originalIds[0])).toHaveClass(/filled/)
    await expect(tokens).toHaveCount(4)

    await tokens.first().tap()
    await slot(originalIds[2]).tap()
    await expect.poll(slotOrder).toEqual([originalIds[1], originalIds[3], originalIds[4], originalIds[0], originalIds[2]])
    await expect(tokens).toHaveCount(3)

    await slot(originalIds[0]).locator('[data-role="remove-match"]').tap()
    await expect.poll(slotOrder).toEqual([originalIds[0], originalIds[1], originalIds[3], originalIds[4], originalIds[2]])
    await expect(slot(originalIds[0])).not.toHaveClass(/filled/)
    await expect(tokens).toHaveCount(4)

    await slot(originalIds[2]).locator('[data-role="remove-match"]').tap()
    await expect(tokens).toHaveCount(5)
    await placeAll(alice, players.map((player) => player.name), 'wrong')
    await expect(slots.locator('[data-role="remove-match"]')).toHaveCount(0)
    await expect(alice.page.getByText("You're done! Waiting for the others to finish...")).toBeVisible()

    // A force-completed, partial board is not a submitted guess and must not be shown as a miss.
    const bob = players[1]
    await placeMatchToken(bob, 'Alice', 'Alice answer')
    await host.page.locator('[data-role="force-complete-matching"]').click()
    await expect(bob.page.locator('.round-answer-pair')).toHaveCount(6)
    await expect(bob.page.locator('[data-role="all-at-once-result-tab"]').filter({ hasText: 'Bob' })).toHaveAttribute('aria-selected', 'true')
    await expect(bob.page.locator('.round-answer-pair').filter({ hasText: 'Bob answer' }).locator('[data-role="answer-feedback"]')).toHaveText('Your answer — not eligible for points')
    await expect(bob.page.locator('.round-answer-pair').filter({ hasText: 'Alice answer' }).locator('[data-role="answer-feedback"]')).toHaveText('No submitted guess')
    await expect(bob.page.locator('.round-answer-pair.fail')).toHaveCount(0)
    await expect(alice.page.locator('.round-answer-pair')).toHaveCount(6)
    await expect(alice.page.locator('.round-answer-pair.fail')).toHaveCount(2)
    await expect(alice.page.locator('.round-answer-pair.success')).toHaveCount(3)
    const cardWidth = await alice.page.locator('.round-answer-pair').first().boundingBox()
    expect(cardWidth).not.toBeNull()
    expect(cardWidth!.x + cardWidth!.width).toBeLessThanOrEqual(390)
  } finally {
    for (const client of clients) {
      await client.context.close().catch(() => {})
    }
  }
})
