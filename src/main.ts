import './style.css'

type Role = 'host' | 'player'
type Screen = 'welcome' | 'membership' | 'lobby' | 'host-managing' | 'player-answering' | 'player-guessing' | 'round-end' | 'game-end'

type Account = {
  id: string
  email: string
  emailVerified: boolean
}

type Player = {
  id: string
  name: string
  score: number
}

type GuessRecord = {
  guesserId: string
  guesserName: string
  guessedId: string
  guessedName: string
  correct: boolean
  points: number
}

type RoundResult = {
  guesserName: string
  guessedName: string
  correct: boolean
  points: number
}

type RoomState = {
  code: string
  phase: 'lobby' | 'answer-collection' | 'guessing' | 'round-end' | 'game-end'
  answerRoundNumber: number
  question: string
  selectedAnswer: string
  answerAuthorId: string | null
  activeGuesserIndex: number
  players: Player[]
  answers: Array<{ playerId: string; playerName: string; text: string }>
  guesses: GuessRecord[]
  roundResults: RoundResult[]
  hostId: string | null
  timeLeft: number
}

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('App root not found')
}

const root = app

const state = {
  screen: 'welcome' as Screen,
  account: null as Account | null,
  role: 'host' as Role,
  roomCode: '',
  playerName: '',
  currentPlayerId: '',
  players: [] as Player[],
  answerRoundNumber: 0,
  question: '',
  selectedAnswer: '',
  answerAuthorId: null as string | null,
  activeGuesserIndex: 0,
  roundResults: [] as RoundResult[],
  phase: 'lobby' as RoomState['phase'],
  answers: [] as RoomState['answers'],
  guesses: [] as GuessRecord[],
  timeLeft: 0,
  customQuestion: '',
  selectedGuessId: null as string | null,
  hasSubmittedAnswer: false,
}

let queuedAction: (() => void) | null = null

const socket = new WebSocket(buildSocketUrl())

function buildSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const host = window.location.hostname || 'localhost'
  return `${protocol}://${host}:8080/ws`
}

function buildApiUrl(path: string): string {
  if (window.location.port === '8080') {
    return path
  }

  const protocol = window.location.protocol === 'https:' ? 'https' : 'http'
  const host = window.location.hostname || 'localhost'
  return `${protocol}://${host}:8080${path}`
}

function formatScore(value: number): string {
  return `${value} pts`
}

function formatPlayerInitials(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?'
}

function getCurrentPlayer(): Player | undefined {
  return state.players.find((player) => player.id === state.currentPlayerId)
}

function sendSocketMessage(type: string, payload: Record<string, unknown> = {}): void {
  const message = {
    type,
    roomCode: state.roomCode,
    ...payload,
  }

  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message))
    return
  }

  queuedAction = () => {
    socket.send(JSON.stringify(message))
  }
}

function applyRoomState(serverState: Partial<RoomState>): void {
  if (!serverState) {
    return
  }

  state.roomCode = serverState.code || state.roomCode
  state.players = serverState.players ?? state.players
  state.answerRoundNumber = serverState.answerRoundNumber ?? state.answerRoundNumber
  state.question = serverState.question ?? state.question
  state.selectedAnswer = serverState.selectedAnswer ?? state.selectedAnswer
  state.answerAuthorId = serverState.answerAuthorId ?? state.answerAuthorId
  state.activeGuesserIndex = serverState.activeGuesserIndex ?? state.activeGuesserIndex
  state.roundResults = serverState.roundResults ?? state.roundResults
  state.answers = serverState.answers ?? state.answers
  state.guesses = serverState.guesses ?? state.guesses
  state.timeLeft = serverState.timeLeft ?? state.timeLeft
  state.phase = serverState.phase ?? state.phase
  state.hasSubmittedAnswer = state.answers.some((answer) => answer.playerId === state.currentPlayerId)
  
  // Reset selected guess if transitioning to a new guessing phase or if current guess is no longer in the guesses array
  if (state.phase === 'guessing') {
    const playerGuessInRound = state.guesses.find((guess) => guess.guesserId === state.currentPlayerId)
    state.selectedGuessId = playerGuessInRound?.guessedId ?? null
  } else {
    state.selectedGuessId = null
  }

  if (state.role === 'host' && serverState.hostId) {
    state.currentPlayerId = serverState.hostId
  } else if (!state.currentPlayerId || !state.players.some((player) => player.id === state.currentPlayerId)) {
    const matchingName = state.playerName.trim().toLowerCase()
    const matchedPlayer = state.players.find((player) => player.name.toLowerCase() === matchingName)
    state.currentPlayerId = matchedPlayer?.id ?? state.players[0]?.id ?? state.currentPlayerId
  }

  if (state.phase === 'lobby') {
    state.screen = 'lobby'
  } else if (state.phase === 'answer-collection') {
    state.screen = state.role === 'host' ? 'host-managing' : 'player-answering'
  } else if (state.phase === 'guessing') {
    state.screen = state.role === 'host' ? 'host-managing' : 'player-guessing'
  } else if (state.phase === 'round-end') {
    state.screen = 'round-end'
  } else if (state.phase === 'game-end') {
    state.screen = 'game-end'
  }

  renderApp()
}

function createRoomSession(): void {
  const rawName = window.prompt('Choose your display name for this room', state.playerName || 'Host') ?? 'Host'
  const nextName = rawName.trim() || 'Host'
  state.playerName = nextName
  state.role = 'host'
  state.screen = 'lobby'

  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'create-room', name: nextName, roomCode: state.roomCode }))
    return
  }

  queuedAction = () => {
    socket.send(JSON.stringify({ type: 'create-room', name: nextName, roomCode: state.roomCode }))
  }

  renderApp()
}

async function openHostFlow(): Promise<void> {
  try {
    const response = await fetch(buildApiUrl('/auth/session'), { credentials: 'include' })
    const payload = await response.json()
    state.account = payload.user ?? null
  } catch {
    state.account = null
  }

  if (state.account?.emailVerified) {
    createRoomSession()
    return
  }

  state.screen = 'membership'
  renderApp()
}

function joinRoomSession(): void {
  const rawName = window.prompt('Enter your player name', state.playerName || 'Player') ?? 'Player'
  const name = rawName.trim() || 'Player'
  const rawRoomCode = window.prompt('Enter the room code', state.roomCode || '') ?? ''
  const roomCode = rawRoomCode.trim().toUpperCase()

  if (!roomCode) {
    window.alert('A room code is required to join.')
    return
  }

  state.playerName = name
  state.role = 'player'
  state.roomCode = roomCode

  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'join-room', name, roomCode }))
    return
  }

  queuedAction = () => {
    socket.send(JSON.stringify({ type: 'join-room', name, roomCode }))
  }

  renderApp()
}

function startRound(): void {
  if (!state.roomCode) {
    return
  }

  if (state.role === 'host') {
    const questionText = state.customQuestion.trim()

    if (!questionText) {
      window.alert('Type a question before starting the round.')
      return
    }

    if (questionText.length < 8) {
      window.alert('Question should be at least 8 characters long.')
      return
    }
  }

  sendSocketMessage('start-round', { question: state.customQuestion.trim() })
}

function revealAnswer(): void {
  if (!state.roomCode) {
    return
  }

  sendSocketMessage('reveal-answer')
}

function submitPlayerAnswer(answer: string): void {
  if (!state.roomCode || !state.currentPlayerId) {
    return
  }

  sendSocketMessage('submit-answer', { playerId: state.currentPlayerId, answerText: answer })
}

function handleGuess(guessId: string): void {
  if (!state.roomCode || !state.currentPlayerId) {
    return
  }

  state.selectedGuessId = guessId
  sendSocketMessage('guess', { playerId: state.currentPlayerId, targetPlayerId: guessId })
}

function lockAnswers(): void {
  if (!state.roomCode) {
    return
  }

  sendSocketMessage('lock-answers')
}

function calculateScores(): void {
  if (!state.roomCode) {
    return
  }

  sendSocketMessage('calculate-score')
}

function advanceAnswer(): void {
  if (!state.roomCode) {
    return
  }

  sendSocketMessage('advance-answer')
}

function renderWelcome(): void {
  root.innerHTML = `
    <main class="shell">
      <section class="panel welcome-panel">
        <p class="eyebrow">Guess Party</p>
        <h1>Who wrote the answer?</h1>
        <p class="subtitle">A friendly group game for family and friends.</p>

        <div class="welcome-grid">
          <button class="feature-card primary" type="button" data-role="create-room">
            <span class="card-tag">Host</span>
            <strong>Create room</strong>
            <small>Start the round and manage the game flow.</small>
          </button>

          <button class="feature-card secondary" type="button" data-role="join-room">
            <span class="card-tag">Player</span>
            <strong>Join room</strong>
            <small>Enter your name and play with the group.</small>
          </button>
        </div>
      </section>
    </main>
  `

  root.querySelector('[data-role="create-room"]')?.addEventListener('click', () => {
    state.customQuestion = ''
    void openHostFlow()
  })

  root.querySelector('[data-role="join-room"]')?.addEventListener('click', () => {
    joinRoomSession()
  })
}

function renderMembership(): void {
  root.innerHTML = `
    <main class="shell">
      <section class="panel membership-panel">
        <p class="eyebrow">Host membership</p>
        <h1>Become a host</h1>
        <p class="subtitle">Create an account to start and manage your own rooms.</p>

        <form id="membership-form" class="membership-form">
          <label for="membership-email">Email address</label>
          <input id="membership-email" type="email" autocomplete="email" required />
          <label for="membership-password">Password</label>
          <input id="membership-password" type="password" autocomplete="new-password" minlength="8" required />
          <label class="membership-confirm-field" for="membership-confirm">Confirm password</label>
          <input class="membership-confirm-field" id="membership-confirm" type="password" autocomplete="new-password" minlength="8" />
          <p class="membership-error" data-role="membership-error" aria-live="polite"></p>
          <button class="primary-button" type="submit" data-role="membership-submit">Create account</button>
        </form>

        <div class="membership-actions">
          <button class="ghost-button" type="button" data-role="membership-toggle">Already have an account? Log in</button>
          <button class="ghost-button" type="button" data-role="membership-back">Back</button>
        </div>
      </section>
    </main>
  `

  let loginMode = false
  const form = root.querySelector<HTMLFormElement>('#membership-form')
  const error = root.querySelector<HTMLElement>('[data-role="membership-error"]')
  const submit = root.querySelector<HTMLButtonElement>('[data-role="membership-submit"]')
  const toggle = root.querySelector<HTMLButtonElement>('[data-role="membership-toggle"]')
  const confirmFields = root.querySelectorAll<HTMLElement>('.membership-confirm-field')

  toggle?.addEventListener('click', () => {
    loginMode = !loginMode
    confirmFields.forEach((field) => { field.hidden = loginMode })
    submit!.textContent = loginMode ? 'Log in' : 'Create account'
    toggle.textContent = loginMode ? 'Need an account? Sign up' : 'Already have an account? Log in'
  })

  root.querySelector('[data-role="membership-back"]')?.addEventListener('click', () => {
    state.screen = 'welcome'
    renderApp()
  })

  form?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const email = root.querySelector<HTMLInputElement>('#membership-email')?.value.trim() ?? ''
    const password = root.querySelector<HTMLInputElement>('#membership-password')?.value ?? ''
    const confirmation = root.querySelector<HTMLInputElement>('#membership-confirm')?.value ?? ''

    if (!loginMode && password !== confirmation) {
      error!.textContent = 'Passwords do not match.'
      return
    }

    submit!.disabled = true
    error!.textContent = ''
    try {
      const response = await fetch(buildApiUrl(loginMode ? '/auth/login' : '/auth/signup'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const payload = await response.json()
      if (!response.ok) {
        error!.textContent = payload.error || 'Unable to continue.'
        return
      }

      if (loginMode) {
        window.location.reload()
        return
      }

      error!.textContent = 'Account created. Verify your email, then log in to host a room.'
    } catch {
      error!.textContent = 'The account service is unavailable.'
    } finally {
      submit!.disabled = false
    }
  })
}

function renderLobby(): void {
  const leaderboard = [...state.players].sort((a, b) => b.score - a.score)
  const hostQuestionIsValid = state.customQuestion.trim().length >= 8

  root.innerHTML = `
    <main class="shell">
      <section class="panel hero-panel">
        <div class="hero-copy">
          <p class="eyebrow">${state.role === 'host' ? 'Host view' : 'Player view'}</p>
          <h1>${state.role === 'host' ? 'Room ready' : 'Waiting in the room'}</h1>
          <p class="subtitle">Room code: ${state.roomCode}</p>
        </div>

        <div class="room-card">
          <span class="chip">Room code</span>
          <strong>${state.roomCode}</strong>
          ${state.role === 'host'
            ? `<button class="primary-button" type="button" data-role="start-round" ${hostQuestionIsValid ? '' : 'disabled'}>Start round</button>`
            : '<div class="chip">Waiting for the host to begin</div>'}
        </div>
      </section>

      <section class="panel">
        <div class="section-head">
          <h2>Players</h2>
          <span>${state.players.length} joined</span>
        </div>

        <div class="player-list">
          ${state.players
            .map(
              (player) => `
                <div class="player-pill ${player.id === state.currentPlayerId ? 'active' : ''}">
                  <span class="avatar">${formatPlayerInitials(player.name)}</span>
                  <span>${player.name}</span>
                </div>
              `,
            )
            .join('')}
        </div>
      </section>

      ${state.role === 'host'
        ? `
          <section class="panel">
            <div class="section-head">
              <h2>Round prompt</h2>
              <span>${state.customQuestion.trim() ? 'Ready to play' : 'Required'}</span>
            </div>

            <form id="host-question-form" class="host-question-form">
              <label for="host-question">Type the question for this round</label>
              <textarea id="host-question" rows="3" maxlength="220" placeholder="Example: What is the most creative way to spend a rainy Sunday with friends?">${state.customQuestion}</textarea>
              <div class="host-question-actions">
                <button class="secondary-button" type="submit">Save question</button>
                <button class="ghost-button" type="button" data-role="clear-question">Clear</button>
              </div>
            </form>

            <div class="rules-list">
              <div class="rule-item"><strong>1.</strong><span>Wait for the host to provide a question.</span></div>
              <div class="rule-item"><strong>2.</strong><span>Answer the question and wait for everyone else to submit their answers.</span></div>
              <div class="rule-item"><strong>3.</strong><span>Once enough answers are in, the host starts the guessing phase.</span></div>
              <div class="rule-item"><strong>4.</strong><span>You cannot guess your own answer, and faster correct guesses earn a speed bonus.</span></div>
            </div>
          </section>
          `
        : `
          <section class="panel">
            <div class="section-head">
              <h2>Room rules</h2>
            </div>
            <div class="rules-list">
              <div class="rule-item"><strong>1.</strong><span>Wait for the host to provide a question.</span></div>
              <div class="rule-item"><strong>2.</strong><span>Answer the question, then wait for everyone else to submit their answers.</span></div>
              <div class="rule-item"><strong>3.</strong><span>Each person tries to guess who wrote each answer.</span></div>
              <div class="rule-item"><strong>4.</strong><span>Correct guesses earn 120 points each.</span></div>
            </div>
          </section>
          `}

      <section class="panel">
        <div class="section-head">
          <h2>Leaderboard</h2>
        </div>

        <div class="leaderboard">
          ${leaderboard
            .map(
              (player, index) => `
                <div class="leaderboard-row ${index === 0 ? 'winner' : ''}">
                  <span>#${index + 1} ${player.name}</span>
                  <strong>${formatScore(player.score)}</strong>
                </div>
              `,
            )
            .join('')}
        </div>
      </section>
    </main>
  `

  root.querySelector('[data-role="start-round"]')?.addEventListener('click', () => {
    startRound()
  })

  root.querySelector('[data-role="clear-question"]')?.addEventListener('click', () => {
    state.customQuestion = ''
    renderApp()
  })

  const hostQuestionForm = root.querySelector<HTMLFormElement>('#host-question-form')
  hostQuestionForm?.addEventListener('submit', (event) => {
    event.preventDefault()
    const textarea = root.querySelector<HTMLTextAreaElement>('#host-question')
    const value = textarea?.value.trim() ?? ''

    if (!value) {
      window.alert('Type a question before starting the round.')
      return
    }

    state.customQuestion = value
    renderApp()
  })
}

function renderHostManaging(): void {
  const visiblePlayers = state.players.filter((player) => player.id !== state.currentPlayerId)
  const guessMap = new Map(state.guesses.map((guess) => [guess.guesserId, guess]))

  root.innerHTML = `
    <main class="shell">
      <section class="panel round-panel">
        <div class="round-header">
          <div>
            <p class="eyebrow">Round ${state.answerRoundNumber}</p>
            <h1>${state.question}</h1>
          </div>
          <div class="timer-box">${state.phase === 'answer-collection' ? 'Answer collection' : 'Guessing phase'}</div>
        </div>

        <div class="answer-reveal">
          <span>${state.phase === 'answer-collection' ? 'Hidden answer to reveal' : 'Random answer'}</span>
          <strong>${state.phase === 'answer-collection' ? 'Waiting for reveal...' : state.selectedAnswer}</strong>
        </div>

        ${state.phase === 'answer-collection'
          ? `
            <div class="turn-box">
              <p>Answer collection</p>
              <h2>${state.answers.length} submitted</h2>
            </div>
            <button class="primary-button" type="button" data-role="lock-answers" ${state.answers.length > 0 ? '' : 'disabled'}>Start guessing</button>
            `
          : `
            <div class="turn-box">
              <p>Current turn</p>
              <h2>Choose who wrote it</h2>
            </div>

            <div class="guess-status-list">
              ${visiblePlayers
                .map((player) => {
                  const guess = guessMap.get(player.id)
                  return `
                    <div class="guess-status-row ${guess ? 'done' : 'waiting'}">
                      <span>${player.name}</span>
                      <strong>${guess ? `Guessed: ${guess.guessedName}` : 'Did not guess yet'}</strong>
                    </div>
                  `
                })
                .join('')}
            </div>
            <div class="host-actions-row">
              <button class="primary-button" type="button" data-role="calculate-score">Stop timer and calculate score</button>
            </div>
          `}
      </section>

      <section class="panel">
        <div class="section-head">
          <h2>Submitted answers</h2>
        </div>

        <div class="result-list">
          ${state.answers.length > 0
            ? state.answers
                .map(
                  (entry) => `
                    <div class="result-row">
                      <span>${entry.playerName}:</span>
                      <strong>${entry.text}</strong>
                    </div>
                  `,
                )
                .join('')
            : '<div class="result-row"><span>No answers submitted yet</span></div>'}
        </div>
      </section>

      <section class="panel">
        <div class="section-head">
          <h2>Live leaderboard</h2>
        </div>

        <div class="leaderboard">
          ${[...state.players]
            .sort((a, b) => b.score - a.score)
            .map(
              (player, index) => `
                <div class="leaderboard-row ${index === 0 ? 'winner' : ''}">
                  <span>#${index + 1} ${player.name}</span>
                  <strong>${formatScore(player.score)}</strong>
                </div>
              `,
            )
            .join('')}
        </div>
      </section>
    </main>
  `

  root.querySelector<HTMLButtonElement>('[data-role="reveal-answer"]')?.addEventListener('click', () => {
    revealAnswer()
  })

  root.querySelector<HTMLButtonElement>('[data-role="lock-answers"]')?.addEventListener('click', () => {
    lockAnswers()
  })

  root.querySelector<HTMLButtonElement>('[data-role="calculate-score"]')?.addEventListener('click', () => {
    calculateScores()
  })

  root.querySelectorAll<HTMLButtonElement>('[data-guess-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const guessId = button.dataset.guessId ?? ''
      handleGuess(guessId)
    })
  })
}

function renderPlayerAnswering(): void {
  const alreadySubmitted = state.answers.some((entry) => entry.playerId === state.currentPlayerId)

  root.innerHTML = `
    <main class="shell">
      <section class="panel player-answer-panel">
        <p class="eyebrow">Round ${state.answerRoundNumber}</p>
        <h1>${state.question}</h1>

        ${alreadySubmitted
          ? '<div class="mini-card"><span>Thank you for submitting your response</span></div>'
          : `
            <div class="answer-box">
              <label for="player-answer">Write your answer</label>
              <textarea id="player-answer" rows="4" placeholder="Type your answer here..."></textarea>
            </div>

            <button class="primary-button" type="button" data-role="submit-answer">Submit answer</button>
          `}

        <div class="mini-card">
          <span>Playing as</span>
          <strong>${getCurrentPlayer()?.name ?? 'Guest'}</strong>
        </div>
      </section>
    </main>
  `

  root.querySelector<HTMLButtonElement>('[data-role="submit-answer"]')?.addEventListener('click', () => {
    const input = root.querySelector<HTMLTextAreaElement>('#player-answer')
    const value = input?.value.trim()

    if (!value) {
      return
    }

    state.hasSubmittedAnswer = true
    submitPlayerAnswer(value)
    renderApp()
  })
}

function renderPlayerGuessing(): void {
  const guessOptions = state.players.filter((player) => player.id !== state.currentPlayerId)
  const selectedGuessId = state.selectedGuessId ?? state.guesses.find((entry) => entry.guesserId === state.currentPlayerId)?.guessedId ?? null

  root.innerHTML = `
    <main class="shell">
      <section class="panel round-panel">
        <div class="round-header">
          <div>
            <p class="eyebrow">Round ${state.answerRoundNumber}</p>
            <h1>${state.question}</h1>
          </div>
          <div class="timer-box">Guessing phase</div>
        </div>

        <div class="answer-reveal">
          <span>Someone answere was this:</span>
          <strong>${state.selectedAnswer}</strong>
        </div>

        <div class="turn-box">
          <p>Current turn</p>
          <h2>Guess who wrote it</h2>
        </div>

        <div class="guess-grid">
          ${guessOptions
            .map(
              (player) => `
                <button type="button" class="guess-card ${selectedGuessId === player.id ? 'selected' : ''}" data-guess-id="${player.id}">
                  <span>${player.name}</span>
                  <small>Guess this person</small>
                </button>
              `,
            )
            .join('')}
        </div>

        <div class="mini-card">
          <span>${selectedGuessId ? 'Your pick' : 'Waiting for your pick'}</span>
          <strong>${selectedGuessId ? guessOptions.find((player) => player.id === selectedGuessId)?.name ?? 'Selected' : 'No selection yet'}</strong>
        </div>
      </section>
    </main>
  `

  root.querySelectorAll<HTMLButtonElement>('[data-guess-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const guessId = button.dataset.guessId ?? ''
      handleGuess(guessId)
      renderApp()
    })
  })
}

function renderRoundEnd(): void {
  const sortedPlayers = [...state.players].sort((a, b) => b.score - a.score)

  root.innerHTML = `
    <main class="shell">
      <section class="panel summary-panel">
        <p class="eyebrow">Round complete</p>
        <h1>Round standings</h1>

        <div class="leaderboard">
          ${sortedPlayers
            .map(
              (player, index) => `
                <div class="leaderboard-row ${index === 0 ? 'winner' : ''}">
                  <span>#${index + 1} ${player.name}</span>
                  <strong>${formatScore(player.score)}</strong>
                </div>
              `,
            )
            .join('')}
        </div>
      </section>

      <section class="panel">
        <div class="section-head">
          <h2>Round results</h2>
        </div>

        <div class="mini-card">
          <span>The answer was</span>
          <strong>"${state.selectedAnswer}"</strong>
        </div>

        <div class="mini-card">
          <span>Written by</span>
          <strong>${state.players.find((player) => player.id === state.answerAuthorId)?.name ?? 'Unknown'}</strong>
        </div>

        <div class="result-list">
          ${state.roundResults
            .map(
              (result) => `
                <div class="result-row ${result.correct ? 'success' : 'fail'}">
                  <span>${result.guesserName} guessed ${result.guessedName}</span>
                  <strong>${result.correct ? `+${formatScore(result.points)}` : 'No points'}</strong>
                </div>
              `,
            )
            .join('')}
        </div>

        ${(() => {
          const myResult = state.roundResults.find((result) => result.guesserName === getCurrentPlayer()?.name)
          if (!myResult) {
            return ''
          }
          return `<div class="mini-card"><span>${myResult.correct ? '🎉 You earned more points!' : '😅 You missed it'}</span></div>`
        })()}

        ${state.role === 'host' ? `<button class="primary-button next-round" type="button" data-role="next-round">${state.answerRoundNumber >= state.answers.length ? 'Go to final score board' : 'Next round'}</button>` : ''}
      </section>
    </main>
  `

  root.querySelector<HTMLButtonElement>('[data-role="next-round"]')?.addEventListener('click', () => {
    advanceAnswer()
  })
}

function renderGameEnd(): void {
  const sortedPlayers = [...state.players].sort((a, b) => b.score - a.score)
  const topThree = sortedPlayers.slice(0, 3)

  root.innerHTML = `
    <main class="shell">
      <section class="panel summary-panel">
        <p class="eyebrow">Game complete</p>
        <h1>🎉 Game finished!</h1>

        <div class="leaderboard">
          ${sortedPlayers
            .map(
              (player, index) => `
                <div class="leaderboard-row ${index === 0 ? 'winner' : index === 1 ? 'second' : index === 2 ? 'third' : ''}">
                  <span>#${index + 1} ${player.name}</span>
                  <strong>${formatScore(player.score)}</strong>
                </div>
              `,
            )
            .join('')}
        </div>
      </section>

      <section class="panel">
        <div class="section-head">
          <h2>Top performers</h2>
        </div>

        <div class="result-list">
          ${topThree
            .map(
              (player, index) => `
                <div class="result-row success">
                  <span>${['🥇 Gold', '🥈 Silver', '🥉 Bronze'][index]} — ${player.name}</span>
                  <strong>${formatScore(player.score)}</strong>
                </div>
              `,
            )
            .join('')}
        </div>
      </section>

      ${state.role === 'host' ? '<button class="primary-button next-round" type="button" data-role="new-game">Start a new game</button>' : ''}
    </main>
  `

  root.querySelector<HTMLButtonElement>('[data-role="new-game"]')?.addEventListener('click', () => {
    state.customQuestion = ''
    renderLobby()
  })
}

function renderApp(): void {
  if (state.screen === 'welcome') {
    renderWelcome()
    return
  }

  if (state.screen === 'membership') {
    renderMembership()
    return
  }

  if (state.screen === 'lobby') {
    renderLobby()
    return
  }

  if (state.screen === 'host-managing') {
    renderHostManaging()
    return
  }

  if (state.screen === 'player-answering') {
    renderPlayerAnswering()
    return
  }

  if (state.screen === 'player-guessing') {
    renderPlayerGuessing()
    return
  }

  if (state.screen === 'round-end') {
    renderRoundEnd()
    return
  }

  if (state.screen === 'game-end') {
    renderGameEnd()
    return
  }
}

socket.addEventListener('open', () => {
  if (queuedAction) {
    const nextAction = queuedAction
    queuedAction = null
    nextAction()
  }
})

socket.addEventListener('message', (event) => {
  try {
    const payload = JSON.parse(event.data)

    if (payload.type === 'room-state') {
      applyRoomState(payload.state)
      return
    }

    if (payload.type === 'error') {
      window.alert(payload.message || 'Something went wrong.')
    }
  } catch {
    window.alert('The room connection sent invalid data.')
  }
})

socket.addEventListener('close', () => {
  window.alert('The game server connection was closed. Refresh the page to reconnect.')
})

renderApp()
