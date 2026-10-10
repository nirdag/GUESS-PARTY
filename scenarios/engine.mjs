import { chromium } from '@playwright/test'
import { API_URL, WEB_URL, ensureServers } from './servers.mjs'

const PLAYER_NAMES = ['Alice', 'Bob', 'Carol']

// Ordered milestones per mode; a scenario runs the pipeline up to (and including) its target.
const MODES = {
  classic: ['lobby', 'answering', 'answers-in', 'guessing', 'guessed', 'round-end', 'game-end'],
  suggestions: ['lobby', 'suggestions-pending', 'answering', 'answers-in', 'guessing', 'guessed', 'round-end', 'game-end'],
  allAtOnce: ['lobby', 'answering', 'answers-in', 'matching', 'matching-partial', 'round-end', 'game-end'],
  pool: ['lobby', 'pool-submitted', 'pool-ready', 'answering', 'answers-in', 'guessing', 'guessed', 'round-end', 'game-end'],
  poolAllAtOnce: ['lobby', 'pool-submitted', 'pool-ready', 'answering', 'answers-in', 'matching', 'matching-partial', 'round-end', 'game-end'],
}

export const catalog = Object.entries(MODES).flatMap(([mode, milestones]) => milestones.map((milestone) => `${mode}:${milestone}`))

async function createClient(browser, name, { mobile, locale } = {}) {
  const context = await browser.newContext(
    mobile
      ? { baseURL: WEB_URL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: locale ?? 'en-US' }
      : { baseURL: WEB_URL, viewport: { width: 720, height: 900 }, locale: locale ?? 'en-US' },
  )
  const page = await context.newPage()
  await page.addInitScript((clientName) => {
    document.title = clientName
  }, name)
  return { context, page, name }
}

const sel = {
  roomCode: '.room-card strong',
  startRound: '[data-role="start-round"]',
  lock: '[data-role="lock-answers"]',
  calc: '[data-role="calculate-score"]',
  confirm: '[data-role="confirm-next-round"]',
  newGame: '[data-role="new-game"]',
  token: '[data-role="matching-token"]',
  slot: '[data-role="matching-slot"]',
}

const visible = (client, selector) => client.page.locator(selector).first().waitFor({ state: 'visible', timeout: 15_000 })
const isVisible = (client, selector) => client.page.locator(selector).first().isVisible()

async function createRoom(host, options) {
  const { page } = host
  const login = await host.context.request.post(`${API_URL}/auth/e2e-login`, {
    data: { email: 'e2e-host@example.com', password: 'e2e-password-123' },
  })
  if (!login.ok()) {
    throw new Error(`Host login failed: ${login.status()} ${await login.text()}`)
  }
  await page.goto('/')
  await page.getByRole('button', { name: 'Create room' }).click()
  await page.locator('#host-setup-name').fill('Host')
  if (options.lang) {
    await page.locator('#host-setup-language').selectOption(options.lang)
  }
  if (options.allAtOnce) {
    await page.locator('input[name="host-setup-guess-flow"][value="allAtOnce"]').check()
  }
  if (options.pool) {
    await page.locator('#host-setup-question-pool').check()
  } else {
    await page.locator('#host-setup-random-playlist').uncheck()
  }
  if (options.hostIsPlayer) {
    await page.locator('#host-setup-add-self').check()
  }
  if (options.suggestions) {
    await page.locator('#host-setup-allow-suggestions').check()
  }
  await page.locator('#host-setup-form button[type="submit"]').click()
  await page.locator(sel.roomCode).filter({ hasText: /^[A-Z0-9]{6}$/ }).waitFor()
  return page.locator(sel.roomCode).innerText()
}

async function joinRoom(client, roomCode) {
  const { page } = client
  await page.goto('/')
  await page.getByRole('button', { name: 'Join room' }).click()
  await page.locator('#join-setup-name').fill(client.name)
  await page.locator('#join-setup-room-code').fill(roomCode)
  await page.locator('#join-setup-form button[type="submit"]').click()
  await page.locator('.player-list').filter({ hasText: client.name }).waitFor()
}

async function submitAnswers(participants, round = 1) {
  for (const client of participants) {
    await client.page.locator('#player-answer').fill(`${client.name} answer round ${round}`)
    await client.page.locator('[data-role="submit-answer"]').click()
  }
}

async function placeAll(client, names) {
  const slots = client.page.locator(sel.slot)
  const texts = await slots.allInnerTexts()
  for (const [index, text] of texts.entries()) {
    const author = names.find((name) => text.includes(name))
    await client.page.locator(sel.token, { hasText: author }).click()
    await slots.nth(index).click()
  }
}

async function guessAll(participants, outcome) {
  if (outcome === 'none') {
    return
  }
  const shown = await participants[0].page.locator('.answer-reveal strong').innerText()
  const author = participants.find((client) => shown.includes(client.name))?.name
  for (const guesser of participants.filter((client) => client.name !== author)) {
    const cards = guesser.page.locator('[data-guess-id]')
    const card = outcome === 'wrong'
      ? cards.filter({ hasNotText: author }).filter({ hasNotText: guesser.name }).first()
      : cards.filter({ hasText: author }).first()
    await card.click()
  }
}

// Plays out everything left (including extra questions in pool mode) until the host sees the end-of-game controls.
async function playToGameEnd(host, participants, everyone, names) {
  for (let i = 0; i < 400; i += 1) {
    if (await isVisible(host, sel.newGame)) {
      return
    }
    for (const client of participants) {
      if (await isVisible(client, '#player-answer')) {
        await submitAnswers([client], 'x')
      }
      if ((await client.page.locator(sel.token).count()) > 0) {
        await placeAll(client, names)
      }
    }
    if (await host.page.locator(sel.lock).first().isEnabled().catch(() => false)) {
      await host.page.locator(sel.lock).first().click()
    }
    if (await isVisible(host, sel.calc)) {
      await host.page.locator(sel.calc).first().click()
    }
    if (await isVisible(host, sel.confirm)) {
      for (const client of everyone) {
        if (await isVisible(client, sel.confirm)) {
          await client.page.locator(sel.confirm).click()
        }
      }
    }
    await host.page.waitForTimeout(200)
  }
  throw new Error('Game did not reach game-end')
}

/**
 * @param {{ mode: keyof typeof MODES, target: string, seat?: string, lang?: string, mobile?: boolean,
 *   hostIsPlayer?: boolean, outcome?: 'correct'|'wrong'|'none', playerCount?: number, visibleBots?: boolean }} opts
 * @returns the headed browser that holds the seat page; close it to end the scenario.
 */
export async function runScenario(opts) {
  const milestones = MODES[opts.mode]
  if (!milestones?.includes(opts.target)) {
    throw new Error(`Unknown scenario ${opts.mode}:${opts.target}`)
  }
  const pool = opts.mode.startsWith('pool')
  const allAtOnce = opts.mode.endsWith('AtOnce') || opts.mode === 'allAtOnce'
  if (opts.hostIsPlayer && !pool) {
    throw new Error('hostIsPlayer is only supported together with a pool mode')
  }
  const outcome = opts.outcome ?? 'correct'
  const seat = (opts.seat ?? 'host').toLowerCase()
  const names = PLAYER_NAMES.slice(0, Math.max(3, Math.min(PLAYER_NAMES.length, opts.playerCount ?? 3)))
  const targetIndex = milestones.indexOf(opts.target)
  const reached = (milestone) => milestones.indexOf(milestone) <= targetIndex

  await ensureServers()
  const seatBrowser = await chromium.launch({ headless: false })
  const botBrowser = opts.visibleBots ? seatBrowser : await chromium.launch()
  const closeAll = () => Promise.all([seatBrowser.close().catch(() => {}), botBrowser.close().catch(() => {})])

  try {
    const clientOpts = { locale: opts.lang === 'he' ? 'he-IL' : 'en-US' }
    const make = (name) => {
      const isSeat = name.toLowerCase() === seat
      return createClient(isSeat ? seatBrowser : botBrowser, name, { ...clientOpts, mobile: isSeat && opts.mobile })
    }
    const host = await make('Host')
    const roomCode = await createRoom(host, {
      lang: opts.lang, allAtOnce, pool, hostIsPlayer: opts.hostIsPlayer, suggestions: opts.mode === 'suggestions',
    })
    const players = []
    for (const name of names) {
      const player = await make(name)
      await joinRoom(player, roomCode)
      players.push(player)
    }
    const everyone = [host, ...players]
    const participants = opts.hostIsPlayer ? everyone : players
    const allNames = participants.map((client) => client.name)

    const steps = {
      lobby: async () => {
        await host.page.locator('.player-list .player-pill').nth(names.length - 1).waitFor()
      },
      'suggestions-pending': async () => {
        for (const player of players.slice(0, 2)) {
          await player.page.locator('#suggest-question-input').fill(`What is ${player.name}'s favorite childhood memory?`)
          await player.page.locator('#suggest-question-form button[type="submit"]').click()
        }
        await host.page.locator('[data-role="dismiss-suggestion"]').first().waitFor()
      },
      'pool-submitted': async () => {
        for (const client of participants) {
          await client.page.locator('#pool-question-input').fill(`What would ${client.name} do with a free weekend?`)
          await client.page.locator('#pool-question-form button[type="submit"]').click()
        }
      },
      'pool-ready': async () => {
        for (const client of participants) {
          await client.page.locator('[data-role="toggle-pool-ready"]').click()
        }
        await host.page.locator(sel.startRound).and(host.page.locator(':enabled')).waitFor()
      },
      answering: async () => {
        if (!pool) {
          await host.page.locator('#host-queue-question').fill('What is the best way to spend a lazy Sunday?')
          await host.page.locator('#host-question-queue-form button[type="submit"]').click()
        }
        await host.page.locator(sel.startRound).click()
        await visible(participants[0], '#player-answer')
      },
      'answers-in': async () => {
        await submitAnswers(participants)
        await host.page.locator(sel.lock).and(host.page.locator(':enabled')).waitFor()
      },
      guessing: async () => {
        await host.page.locator(sel.lock).click()
        await visible(participants[0], '[data-guess-id]')
      },
      guessed: async () => guessAll(participants, outcome),
      matching: async () => {
        await host.page.locator(sel.lock).click()
        await visible(participants[0], sel.slot)
      },
      'matching-partial': async () => placeAll(participants[0], allNames),
      'round-end': async () => {
        if (allAtOnce) {
          for (const client of participants.slice(1)) {
            await placeAll(client, allNames)
          }
        } else {
          await host.page.locator(sel.calc).click()
        }
        await visible(host, sel.confirm)
      },
      'game-end': () => playToGameEnd(host, participants, everyone, allNames),
    }

    for (const milestone of milestones) {
      if (!reached(milestone)) {
        break
      }
      await steps[milestone]()
    }

    const seatClient = everyone.find((client) => client.name.toLowerCase() === seat)
    if (!seatClient) {
      throw new Error(`Unknown seat "${seat}"`)
    }
    await seatClient.page.bringToFront()
    seatBrowser.on('disconnected', () => botBrowser.close().catch(() => {}))
    return { browser: seatBrowser, seatPage: seatClient.page, close: closeAll, roomCode }
  } catch (error) {
    await closeAll()
    throw error
  }
}

export { WEB_URL }
