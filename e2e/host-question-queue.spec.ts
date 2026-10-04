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
const adminCredentials = {
  email: 'admin@guess-party.local',
  password: 'e2e-password-123',
}

async function createClient(browser: Browser, name: string): Promise<Client> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.setViewportSize({ width: 720, height: 900 })
  return { context, page, name }
}

test('host queues gallery and custom questions, edits order, and plays them as a playlist', async ({ browser, baseURL }) => {
  const clients: Client[] = []
  const host = await createClient(browser, 'Host')
  const apiURL = baseURL?.replace(':5173', ':8081')
  clients.push(host)

  const galleryQuestion = 'What is the most memorable place you have visited?'
  const removedQuestion = 'What is your favorite way to spend a quiet Saturday?'
  const secondQuestion = 'Which small thing always makes your day better?'
  let galleryQuestionId = ''

  try {
    const loginResponse = await host.context.request.post(`${apiURL}/auth/e2e-login`, { data: hostCredentials })
    expect(loginResponse.ok(), `${loginResponse.status()} ${await loginResponse.text()}`).toBeTruthy()
    const existingResponse = await host.context.request.get(`${apiURL}/my-questions?language=en`)
    const existingPayload = await existingResponse.json()
    for (const question of existingPayload.questions ?? []) {
      if (question.text === galleryQuestion) {
        await host.context.request.delete(`${apiURL}/my-questions/${question.id}`)
      }
    }
    const galleryResponse = await host.context.request.post(`${apiURL}/my-questions`, {
      data: { language: 'en', text: galleryQuestion },
    })
    expect(galleryResponse.ok(), `${galleryResponse.status()} ${await galleryResponse.text()}`).toBeTruthy()
    galleryQuestionId = (await galleryResponse.json()).question.id

    await host.page.goto('/')
    await host.page.getByRole('button', { name: 'Create room' }).click()
    await host.page.locator('#host-setup-name').fill('Host')
    await host.page.locator('#host-setup-random-playlist').uncheck()
    await host.page.locator('#host-setup-form').getByRole('button', { name: 'Create room' }).click()
    await expect(host.page.locator('.room-card strong')).toHaveText(/^[A-Z0-9]{6}$/)
    const roomCode = await host.page.locator('.room-card strong').innerText()

    for (const name of ['Alice', 'Bob', 'Carol']) {
      const player = await createClient(browser, name)
      clients.push(player)
      await player.page.goto('/')
      await player.page.getByRole('button', { name: 'Join room' }).click()
      await player.page.locator('#join-setup-name').fill(name)
      await player.page.locator('#join-setup-room-code').fill(roomCode)
      await player.page.locator('#join-setup-form').getByRole('button', { name: 'Join room' }).click()
    }
    const players = clients.slice(1)

    await host.page.locator('[data-role="browse-gallery"]').click()
    await host.page.locator('[data-role="gallery-filter"][data-filter="private"]').click()
    await host.page.locator('[data-role="select-gallery-question"]').filter({ hasText: galleryQuestion }).first().click()
    await expect(host.page.locator('[data-role="host-queue-item"]')).toHaveCount(1)

    await host.page.locator('#host-queue-question').fill(removedQuestion)
    await host.page.locator('#host-question-queue-form').getByRole('button', { name: 'Add question' }).click()
    await expect(host.page.locator('[data-role="host-queue-item"]')).toHaveCount(2)
    await host.page.locator('#host-queue-question').fill(secondQuestion)
    await host.page.locator('#host-question-queue-form').getByRole('button', { name: 'Add question' }).click()
    await expect(host.page.locator('[data-role="host-queue-item"]')).toHaveCount(3)

    await host.page.locator('[data-role="host-queue-item"]').nth(2)
      .locator('[data-role="move-host-queue-question"][data-direction="-1"]').click()
    await expect(host.page.locator('[data-role="host-queue-item"]').nth(1)).toContainText(secondQuestion)
    await host.page.locator('[data-role="host-queue-item"]').nth(2)
      .locator('[data-role="remove-host-queue-question"]').click()
    await expect(host.page.locator('[data-role="host-queue-item"]')).toHaveCount(2)

    await host.page.locator('[data-role="browse-gallery"]').click()
    await host.page.locator('[data-role="gallery-filter"][data-filter="private"]').click()
    await host.page.locator('[data-role="select-gallery-question"]').filter({ hasText: galleryQuestion }).first().click()
    await expect(host.page.locator('[data-role="host-queue-error"]')).toHaveText('That question is already in the queue.')
    await expect(host.page.locator('[data-role="host-queue-item"]')).toHaveCount(2)
    await expect(host.page.locator('[data-role="host-queue-item"]').nth(0)).toContainText(galleryQuestion)
    await expect(host.page.locator('[data-role="host-queue-item"]').nth(1)).toContainText(secondQuestion)

    for (const player of players) {
      await expect(player.page.locator('body')).not.toContainText(galleryQuestion)
      await expect(player.page.locator('body')).not.toContainText(secondQuestion)
    }

    await host.page.locator('[data-role="start-round"]').click()
    for (const player of players) {
      await expect(player.page.locator('.player-answer-panel h1')).toHaveText(galleryQuestion)
      await expect(player.page.locator('.asker-tag')).toHaveText('Question 1 of 2')
    }
  } finally {
    if (galleryQuestionId) {
      await host.context.request.delete(`${apiURL}/my-questions/${galleryQuestionId}`).catch(() => {})
    }
    await Promise.all(clients.map((client) => client.context.close()))
  }
})

test('host question queue stops at ten and allows additions after removing one', async ({ browser }) => {
  const clients: Client[] = []
  const host = await createClient(browser, 'Host')
  clients.push(host)

  try {
    await host.page.goto('/')
    await host.page.getByRole('button', { name: 'Create room' }).click()
    await host.page.locator('#host-setup-name').fill('Host')
    await host.page.locator('#host-setup-random-playlist').uncheck()
    await host.page.locator('#host-setup-form').getByRole('button', { name: 'Create room' }).click()
    await expect(host.page.locator('.room-card strong')).toHaveText(/^[A-Z0-9]{6}$/)
    const roomCode = await host.page.locator('.room-card strong').innerText()

    for (const name of ['Alice', 'Bob', 'Carol']) {
      const player = await createClient(browser, name)
      clients.push(player)
      await player.page.goto('/')
      await player.page.getByRole('button', { name: 'Join room' }).click()
      await player.page.locator('#join-setup-name').fill(name)
      await player.page.locator('#join-setup-room-code').fill(roomCode)
      await player.page.locator('#join-setup-form').getByRole('button', { name: 'Join room' }).click()
    }

    const queuePanel = host.page.locator('section.panel').filter({ has: host.page.locator('#host-question-queue-form') })
    for (let index = 1; index <= 10; index += 1) {
      await host.page.locator('#host-queue-question').fill(`What is a favorite thing number ${index}?`)
      await host.page.locator('#host-question-queue-form').getByRole('button', { name: 'Add question' }).click()
      await expect(host.page.locator('[data-role="host-queue-item"]')).toHaveCount(index)
    }

    await expect(queuePanel.locator('.section-head span')).toHaveText('10/10 questions')
    await expect(host.page.locator('[data-role="host-queue-error"]')).toHaveText('The question queue is full (10 questions maximum).')
    await expect(host.page.locator('#host-queue-question')).toBeDisabled()
    await expect(host.page.locator('#host-question-queue-form').getByRole('button', { name: 'Add question' })).toBeDisabled()
    await expect(host.page.locator('[data-role="browse-gallery"]')).toBeDisabled()

    await host.page.locator('[data-role="remove-host-queue-question"]').first().click()
    await expect(host.page.locator('[data-role="host-queue-item"]')).toHaveCount(9)
    await expect(queuePanel.locator('.section-head span')).toHaveText('9/10 questions')
    await expect(host.page.locator('#host-queue-question')).toBeEnabled()

    await host.page.locator('#host-queue-question').fill('What is another favorite thing to share?')
    await host.page.locator('#host-question-queue-form').getByRole('button', { name: 'Add question' }).click()
    await expect(host.page.locator('[data-role="host-queue-item"]')).toHaveCount(10)
  } finally {
    await Promise.all(clients.map((client) => client.context.close()))
  }
})

test('host-as-player answers queued questions and keeps host round controls', async ({ browser }) => {
  const clients: Client[] = []
  const host = await createClient(browser, 'Host')
  clients.push(host)

  try {
    await host.page.goto('/')
    await host.page.getByRole('button', { name: 'Create room' }).click()
    await host.page.locator('#host-setup-name').fill('Host')
    await host.page.locator('#host-setup-add-self').check()
    await host.page.locator('#host-setup-random-playlist').uncheck()
    await host.page.locator('#host-setup-form').getByRole('button', { name: 'Create room' }).click()
    await expect(host.page.locator('.room-card strong')).toHaveText(/^[A-Z0-9]{6}$/)
    const roomCode = await host.page.locator('.room-card strong').innerText()

    for (const name of ['Alice', 'Bob']) {
      const player = await createClient(browser, name)
      clients.push(player)
      await player.page.goto('/')
      await player.page.getByRole('button', { name: 'Join room' }).click()
      await player.page.locator('#join-setup-name').fill(name)
      await player.page.locator('#join-setup-room-code').fill(roomCode)
      await player.page.locator('#join-setup-form').getByRole('button', { name: 'Join room' }).click()
    }

    const question = 'What is your favorite childhood game?'
    await host.page.locator('#host-queue-question').fill(question)
    await host.page.locator('#host-question-queue-form').getByRole('button', { name: 'Add question' }).click()
    await host.page.locator('[data-role="start-round"]').click()

    for (const client of clients) {
      await expect(client.page.locator('#player-answer')).toBeVisible()
      await expect(client.page.locator('.player-answer-panel h1')).toHaveText(question)
      await client.page.locator('#player-answer').fill(`Answer from ${client.name}`)
      await client.page.locator('[data-role="submit-answer"]').click()
    }

    await expect(host.page.locator('[data-role="lock-answers"]')).toBeEnabled()
    await host.page.locator('[data-role="lock-answers"]').click()
    await expect(host.page.locator('[data-role="calculate-score"]')).toBeVisible()
  } finally {
    await Promise.all(clients.map((client) => client.context.close()))
  }
})

test('default random playlist can be edited and starts with its first selected question', async ({ browser, baseURL }) => {
  const clients: Client[] = []
  const host = await createClient(browser, 'Host')
  const apiURL = baseURL?.replace(':5173', ':8081')
  const catalogQuestionTexts = [
    'E2E public random playlist question alpha?',
    'E2E public random playlist question beta?',
    'E2E public random playlist question gamma?',
  ]
  const createdQuestionIds: string[] = []
  clients.push(host)

  try {
    const loginResponse = await host.context.request.post(`${apiURL}/auth/e2e-login`, { data: adminCredentials })
    expect(loginResponse.ok(), `${loginResponse.status()} ${await loginResponse.text()}`).toBeTruthy()
    const existingResponse = await host.context.request.get(`${apiURL}/questions?language=en`)
    const existingPayload = await existingResponse.json()
    for (const question of existingPayload.questions ?? []) {
      if (catalogQuestionTexts.includes(question.text)) {
        await host.context.request.delete(`${apiURL}/admin/questions/${question.id}`)
      }
    }
    for (const text of catalogQuestionTexts) {
      const response = await host.context.request.post(`${apiURL}/admin/questions`, { data: { language: 'en', text } })
      expect(response.ok(), `${response.status()} ${await response.text()}`).toBeTruthy()
      createdQuestionIds.push((await response.json()).question.id)
    }

    await host.page.goto('/')
    await host.page.getByRole('button', { name: 'Create room' }).click()
    await host.page.locator('#host-setup-name').fill('Host')
    await expect(host.page.locator('#host-setup-random-playlist')).toBeChecked()
    await host.page.locator('#host-setup-random-playlist-count').fill('2')
    await host.page.locator('#host-setup-form').getByRole('button', { name: 'Create room' }).click()
    await expect(host.page.locator('.room-card strong')).toHaveText(/^[A-Z0-9]{6}$/)
    const roomCode = await host.page.locator('.room-card strong').innerText()

    for (const name of ['Alice', 'Bob', 'Carol']) {
      const player = await createClient(browser, name)
      clients.push(player)
      await player.page.goto('/')
      await player.page.getByRole('button', { name: 'Join room' }).click()
      await player.page.locator('#join-setup-name').fill(name)
      await player.page.locator('#join-setup-room-code').fill(roomCode)
      await player.page.locator('#join-setup-form').getByRole('button', { name: 'Join room' }).click()
    }

    const queueItems = host.page.locator('[data-role="host-queue-item"]')
    await expect(queueItems).toHaveCount(2)
    const originalTexts = await queueItems.locator('.host-queue-text').allTextContents()
    expect(originalTexts.every((text) => catalogQuestionTexts.includes(text))).toBe(true)
    for (const player of clients.slice(1)) {
      for (const text of originalTexts) {
        await expect(player.page.locator('body')).not.toContainText(text)
      }
    }

    await queueItems.first().locator('[data-role="remove-host-queue-question"]').click()
    await expect(queueItems).toHaveCount(1)
    await host.page.locator('[data-role="add-random-question"]').click()
    await expect(queueItems).toHaveCount(2)
    const refilledTexts = await queueItems.locator('.host-queue-text').allTextContents()
    expect(refilledTexts).not.toContain(originalTexts[0])

    const firstQuestion = refilledTexts[0]
    await host.page.locator('[data-role="start-round"]').click()
    for (const player of clients.slice(1)) {
      await expect(player.page.locator('.player-answer-panel h1')).toHaveText(firstQuestion)
    }
  } finally {
    for (const questionId of createdQuestionIds) {
      await host.context.request.delete(`${apiURL}/admin/questions/${questionId}`).catch(() => {})
    }
    await Promise.all(clients.map((client) => client.context.close()))
  }
})