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
const playerNames = ['Alice', 'Bob', 'Charlie', 'Dana']
const scoreTiers = [120, 100, 80]
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

function addScore(scores: Map<string, number>, player: Client, points: number): void {
  scores.set(player.name, (scores.get(player.name) ?? 0) + points)
}

async function submitCorrectNormalGuesses(players: Client[], answers: Map<string, string>, scores: Map<string, number>): Promise<void> {
  const answerText = await players[0].page.locator('.answer-reveal strong').innerText()
  const answerAuthor = [...answers].find(([, answer]) => answer === answerText)?.[0]
  expect(answerAuthor, `Unknown answer displayed: ${answerText}`).toBeTruthy()

  for (const [index, player] of players.filter((player) => player.name !== answerAuthor).entries()) {
    await player.page.locator(`[data-guess-id]:has-text("${answerAuthor}")`).click()
    addScore(scores, player, scoreTiers[index])
  }
}

async function completeQuestion(host: Client, players: Client[], questionNumber: number, scores: Map<string, number>): Promise<void> {
  const question = `Question ${questionNumber}: what makes a game night memorable?`
  const answers = new Map(players.map((player) => [player.name, `Question ${questionNumber} answer from ${player.name}`]))

  await host.page.locator('#host-question').fill(question)
  await host.page.locator('#host-question-form').getByRole('button', { name: 'Save question' }).click()
  await host.page.locator('[data-role="start-round"]').click()
  await checkpoint(host, `question-${questionNumber}-answer-collection`)

  for (const player of players) {
    await expect(player.page.locator('#player-answer')).toBeVisible()
    await player.page.locator('#player-answer').fill(answers.get(player.name)!)
    await player.page.locator('[data-role="submit-answer"]').click()
  }

  await expect(host.page.locator('[data-role="lock-answers"]')).toBeEnabled()
  await host.page.locator('[data-role="lock-answers"]').click()
  await checkpoint(host, `question-${questionNumber}-guessing-started`)

  for (let roundNumber = 1; roundNumber <= 2; roundNumber += 1) {
    if (questionNumber === 1 && roundNumber === 1) {
      await submitCorrectNormalGuesses(players, answers, scores)
    }
    await host.page.locator('[data-role="calculate-score"]').click()
    await expect(host.page.locator('[data-role="next-round"]')).toBeVisible()
    await expect(host.page.locator('.rounds-left')).toHaveText(`${3 - roundNumber} rounds left to play this question`)
    await checkpoint(host, `question-${questionNumber}-round-${roundNumber}-complete`)
    await host.page.locator('[data-role="next-round"]').click()
  }

  await host.page.locator('[data-role="calculate-score"]').click()
  await expect(host.page.locator('[data-role="next-round"]')).toBeVisible()
  await expect(host.page.locator('.rounds-left')).toHaveText('0 rounds left to play this question')
  await checkpoint(host, `question-${questionNumber}-round-3-complete`)
  await host.page.locator('[data-role="next-round"]').click()
  await expect(host.page.locator('[data-role="new-game"]')).toBeVisible()
  await checkpoint(host, `question-${questionNumber}-game-complete`)
}

test('host and four players can complete two live questions', async ({ browser, baseURL }) => {
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
    const players = clients.slice(1)
    await expect(host.page.locator('.player-list .player-pill')).toHaveCount(4)
    await checkpoint(host, 'all-players-joined')

    const expectedScores = new Map(playerNames.map((name) => [name, 0]))
  await completeQuestion(host, players, 1, expectedScores)

    await host.page.locator('[data-role="new-game"]').click()
    await expect(host.page.locator('#host-question')).toBeVisible()

    await completeQuestion(host, players, 2, expectedScores)

    await expect(host.page.getByRole('heading', { name: 'Final scores' })).toBeVisible()
    await expect(host.page.locator('.leaderboard')).toHaveCount(1)
    await expect(host.page.locator('.leaderboard-row')).toHaveCount(4)
    await expect(host.page.locator('.leaderboard-row').nth(0)).toContainText('Gold')
    await expect(host.page.locator('.leaderboard-row').nth(1)).toContainText('Silver')
    await expect(host.page.locator('.leaderboard-row').nth(2)).toContainText('Bronze')
    await expect(host.page.locator('.leaderboard-row').nth(3)).toContainText('#4')
    await expect(host.page.locator('.result-list')).toHaveCount(0)

    const scoreRows = await host.page.locator('.leaderboard-row').allTextContents()
    const actualScores = new Map(playerNames.map((name) => {
      const row = scoreRows.find((text) => text.includes(name))
      const points = Number(row?.match(/(\d+) pts/)?.[1])
      return [name, points]
    }))
    expect(actualScores).toEqual(expectedScores)
    expect(new Set(actualScores.values()).size).toBe(4)
    await checkpoint(host, 'two-question-game-complete')
  } finally {
    await Promise.all(clients.map((client) => client.context.close()))
  }
})
