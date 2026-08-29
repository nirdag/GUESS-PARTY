import './style.css'
import QRCode from 'qrcode'
import { type LanguageCode, getLanguage, languages, setLanguage, t } from './i18n'

type Role = 'host' | 'player'
type Screen = 'welcome' | 'membership' | 'host-setup' | 'join-setup' | 'lobby' | 'host-managing' | 'player-answering' | 'player-guessing' | 'round-end' | 'game-end' | 'admin-login' | 'admin-gallery'

type Account = {
  id: string
  email: string
  emailVerified: boolean
  isAdmin: boolean
}

type GalleryQuestion = {
  id: string
  text: string
}

type RoomSession = {
  roomCode: string
  role: Role
  playerId: string
  playerName: string
  reconnectToken: string
}

type Player = {
  id: string
  name: string
  score: number
  avatar: string
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
  language: LanguageCode
  guessTimeoutSeconds: number
  guessDeadlineMs: number | null
  remainingAuthorIds: string[]
}

const app = document.querySelector<HTMLDivElement>('#app')

// Must match server.js AVATAR_OPTIONS exactly; the server re-validates against its own copy.
const AVATAR_OPTIONS = [
  '🦊', '🐸', '🐧', '🐼', '🐨', '🦁', '🐵', '🐯',
  '🐮', '🐷', '🐙', '🦄', '🐝', '🦋', '🐢', '🐳',
  '🦖', '🌵', '🍕', '🎧', '🚀', '⭐', '🎲', '🎨',
]

if (!app) {
  throw new Error('App root not found')
}

const root = app
const roomSessionStorageKey = 'guess-party-room-session'

root.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  if (target.closest('[data-role="quit-room"]')) {
    quitRoom()
    return
  }

  if (target.closest('[data-role="close-room"]')) {
    closeRoom()
    return
  }

  const avatarButton = target.closest<HTMLElement>('[data-avatar]')
  if (avatarButton) {
    state.selectedAvatar = avatarButton.dataset.avatar ?? state.selectedAvatar
    renderApp()
  }
})

function readStoredRoomSession(): RoomSession | null {
  try {
    const stored = window.localStorage.getItem(roomSessionStorageKey)
    if (!stored) {
      return null
    }

    const session = JSON.parse(stored) as Partial<RoomSession>
    if (
      (session.role !== 'host' && session.role !== 'player')
      || !session.roomCode
      || !session.playerId
      || !session.playerName
      || !session.reconnectToken
    ) {
      return null
    }

    return session as RoomSession
  } catch {
    return null
  }
}

function saveRoomSession(session: RoomSession): void {
  try {
    window.localStorage.setItem(roomSessionStorageKey, JSON.stringify(session))
  } catch {
    // The game can continue for this page even if browser storage is unavailable.
  }
}

function clearStoredRoomSession(): void {
  try {
    window.localStorage.removeItem(roomSessionStorageKey)
  } catch {
    // Nothing else is required when browser storage is unavailable.
  }
}

const storedRoomSession = readStoredRoomSession()

const state = {
  screen: 'welcome' as Screen,
  account: null as Account | null,
  role: storedRoomSession?.role ?? 'host' as Role,
  roomCode: storedRoomSession?.roomCode ?? '',
  playerName: storedRoomSession?.playerName ?? '',
  currentPlayerId: storedRoomSession?.playerId ?? '',
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
  language: getLanguage(),
  selectedAvatar: AVATAR_OPTIONS[0],
  myAvatar: '',
  guessTimeoutSeconds: 20,
  guessDeadlineMs: null as number | null,
  remainingAuthorIds: [] as string[],
  adminError: '',
  adminLanguageFilter: 'en' as LanguageCode,
  adminQuestions: [] as GalleryQuestion[],
  showQuestionGallery: false,
  galleryQuestions: [] as GalleryQuestion[],
  showRoomSharingPanel: false,
  roomCodePrefilledFromUrl: false,
}

let queuedAction: (() => void) | null = null
let shouldRestoreRoomSession = Boolean(storedRoomSession)
let isPageUnloading = false
let reconnectAttempt = 0
let reconnectTimer: number | null = null
let reconnectAlertShown = false

// Vite dev server (5173) proxies nothing, so dev must reach the API/WS server on its own port.
const DEV_API_PORT = '8080'

// Reassigned by connectSocket(): the server closes this connection after room-closed/left-room,
// so a fresh socket is needed for the next room rather than reusing the dead one.
let socket: WebSocket

function isViteDevServer(): boolean {
  return window.location.port === '5173'
}

function buildSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'

  if (isViteDevServer()) {
    return `${protocol}://${window.location.hostname || 'localhost'}:${DEV_API_PORT}/ws`
  }

  return `${protocol}://${window.location.host}/ws`
}

function buildApiUrl(path: string): string {
  if (!isViteDevServer()) {
    return path
  }

  return `${window.location.protocol}//${window.location.hostname || 'localhost'}:${DEV_API_PORT}${path}`
}

function parseRoomJoinLink(): { roomCode: string; language: LanguageCode } | null {
  try {
    const params = new URLSearchParams(window.location.search)
    const roomCode = params.get('roomCode')?.toUpperCase().trim()
    const language = params.get('lang')

    if (!roomCode) {
      return null
    }

    // Validate room code format (6 alphanumeric characters)
    if (!/^[A-Z0-9]{6}$/.test(roomCode)) {
      return null
    }

    // Validate and normalize language
    const normalizedLang = (language === 'en' || language === 'he') ? language : 'en'

    // Strip the room link params from URL to prevent accidental re-sharing
    params.delete('roomCode')
    params.delete('lang')
    const cleanedSearch = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${cleanedSearch ? `?${cleanedSearch}` : ''}`)

    return { roomCode, language: normalizedLang }
  } catch {
    return null
  }
}

function generateRoomShareLink(): string {
  const baseUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}`
  const params = new URLSearchParams({
    roomCode: state.roomCode,
    lang: state.language,
  })
  return `${baseUrl}?${params.toString()}`
}

function isActiveRoomScreen(): boolean {
  return ['lobby', 'host-managing', 'player-answering', 'player-guessing', 'round-end', 'game-end'].includes(state.screen)
}

function updateConnectionStatus(isReconnecting: boolean): void {
  const status = root.querySelector<HTMLElement>('[data-role="connection-status"]')
  if (!status) {
    return
  }

  status.hidden = !isReconnecting
  status.textContent = isReconnecting ? t('prompts.reconnecting') : ''
}

function scheduleSocketReconnect(): void {
  if (isPageUnloading || reconnectTimer !== null) {
    return
  }

  const delay = Math.min(10000, 1000 * (2 ** Math.min(reconnectAttempt - 1, 3)))
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    connectSocket()
  }, delay)
}

function formatScore(value: number): string {
  return t('common.scorePts', { value })
}

function renderGuessTimerBox(fallbackLabel: string): string {
  if (state.phase === 'guessing' && state.guessDeadlineMs) {
    const secondsLeft = Math.max(0, Math.ceil((state.guessDeadlineMs - Date.now()) / 1000))
    return `<div class="timer-box ${secondsLeft <= 5 ? 'urgent' : ''}" data-role="guess-countdown">${t('hostManaging.timeLeft', { seconds: secondsLeft })}</div>`
  }

  return `<div class="timer-box">${fallbackLabel}</div>`
}

function formatPlayerInitials(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?'
}

function formatPlayerAvatar(player: Player | undefined): string {
  return player?.avatar || formatPlayerInitials(player?.name ?? '')
}

function renderAvatarPicker(selected: string): string {
  const options = AVATAR_OPTIONS
    .map(
      (avatar) => `
        <button type="button" class="avatar-option ${avatar === selected ? 'selected' : ''}" data-avatar="${avatar}" aria-pressed="${avatar === selected}">
          ${avatar}
        </button>
      `,
    )
    .join('')

  return `<div class="avatar-picker">${options}</div>`
}

async function renderRoomSharingPanel(): Promise<string> {
  const shareLink = generateRoomShareLink()
  
  let qrCodeDataUrl = ''
  try {
    qrCodeDataUrl = await QRCode.toDataURL(shareLink, {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      width: 200,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
    })
  } catch (error) {
    console.error('Failed to generate QR code:', error)
  }

  return `
    <div class="room-sharing-panel">
      <div class="sharing-content">
        <h3>${t('roomSharing.title')}</h3>
        
        ${qrCodeDataUrl ? `<img src="${qrCodeDataUrl}" alt="${t('roomSharing.qrAlt')}" class="qr-code" />` : ''}
        
        <div class="share-link-container">
          <label for="room-share-link">${t('roomSharing.linkLabel')}</label>
          <div class="share-link-input-group">
            <input id="room-share-link" type="text" value="${shareLink}" readonly />
            <button class="copy-button" type="button" data-role="copy-share-link">${t('roomSharing.copyButton')}</button>
          </div>
        </div>
        
        <p class="sharing-hint">${t('roomSharing.hint')}</p>
      </div>
    </div>
  `
}

function getCurrentPlayer(): Player | undefined {
  return state.players.find((player) => player.id === state.currentPlayerId)
}

function getCurrentPlayerRank(): number | null {
  const sortedPlayers = [...state.players].sort((first, second) => second.score - first.score)
  let rank = 0
  let previousScore: number | null = null

  for (const [index, player] of sortedPlayers.entries()) {
    if (player.score !== previousScore) {
      rank = index + 1
      previousScore = player.score
    }

    if (player.id === state.currentPlayerId) {
      return rank
    }
  }

  return null
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
  state.guessTimeoutSeconds = serverState.guessTimeoutSeconds ?? state.guessTimeoutSeconds
  state.guessDeadlineMs = serverState.guessDeadlineMs ?? null
  state.remainingAuthorIds = serverState.remainingAuthorIds ?? state.remainingAuthorIds
  state.hasSubmittedAnswer = state.answers.some((answer) => answer.playerId === state.currentPlayerId)

  if (serverState.language) {
    state.language = serverState.language
    setLanguage(serverState.language)
  }
  
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
  manageGuessCountdown()
}

// Recomputed locally from an absolute deadline timestamp so we don't need a broadcast every second.
let guessCountdownHandle: number | null = null

function stopGuessCountdown(): void {
  if (guessCountdownHandle !== null) {
    window.clearInterval(guessCountdownHandle)
    guessCountdownHandle = null
  }
}

function tickGuessCountdown(): void {
  if (state.phase !== 'guessing' || !state.guessDeadlineMs) {
    stopGuessCountdown()
    return
  }

  const secondsLeft = Math.max(0, Math.ceil((state.guessDeadlineMs - Date.now()) / 1000))
  root.querySelectorAll<HTMLElement>('[data-role="guess-countdown"]').forEach((element) => {
    element.textContent = t('hostManaging.timeLeft', { seconds: secondsLeft })
    element.classList.toggle('urgent', secondsLeft <= 5)
  })
}

function manageGuessCountdown(): void {
  if (state.phase === 'guessing' && state.guessDeadlineMs) {
    if (guessCountdownHandle === null) {
      tickGuessCountdown()
      guessCountdownHandle = window.setInterval(tickGuessCountdown, 250)
    }
    return
  }

  stopGuessCountdown()
}

function createRoomSession(name: string, language: LanguageCode, avatar: string, guessTimeoutSeconds: number): void {
  const nextName = name.trim() || t('prompts.defaultHostName')
  state.playerName = nextName
  state.role = 'host'
  state.language = language
  state.myAvatar = avatar
  state.guessTimeoutSeconds = guessTimeoutSeconds
  setLanguage(language)
  shouldRestoreRoomSession = false
  clearStoredRoomSession()
  state.screen = 'lobby'

  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'create-room', name: nextName, roomCode: state.roomCode, language, avatar, guessTimeoutSeconds }))
    return
  }

  queuedAction = () => {
    socket.send(JSON.stringify({ type: 'create-room', name: nextName, roomCode: state.roomCode, language, avatar, guessTimeoutSeconds }))
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
    state.screen = 'host-setup'
    renderApp()
    return
  }

  state.screen = 'membership'
  renderApp()
}

function joinRoomSession(name: string, roomCode: string, avatar: string): void {
  const nextName = name.trim() || t('prompts.defaultPlayerName')
  const nextRoomCode = roomCode.trim().toUpperCase()

  if (!nextRoomCode) {
    window.alert(t('prompts.roomCodeRequired'))
    return
  }

  state.playerName = nextName
  state.role = 'player'
  state.roomCode = nextRoomCode
  state.myAvatar = avatar
  shouldRestoreRoomSession = false
  clearStoredRoomSession()

  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'join-room', name: nextName, roomCode: nextRoomCode, avatar }))
    return
  }

  queuedAction = () => {
    socket.send(JSON.stringify({ type: 'join-room', name: nextName, roomCode: nextRoomCode, avatar }))
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
      window.alert(t('prompts.typeQuestionFirst'))
      return
    }

    if (questionText.length < 8) {
      window.alert(t('prompts.questionTooShort'))
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

  const existingGuess = state.guesses.find((guess) => guess.guesserId === state.currentPlayerId)
  if (state.selectedGuessId || existingGuess) {
    window.alert(t('prompts.guessAlreadyLocked'))
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

function requestNewGame(): void {
  if (!state.roomCode) {
    return
  }

  sendSocketMessage('new-game')
}

function quitRoom(): void {
  if (!window.confirm(t('prompts.confirmQuit'))) {
    return
  }

  sendSocketMessage('leave-room')
}

function closeRoom(): void {
  if (!window.confirm(t('prompts.confirmCloseRoom'))) {
    return
  }

  sendSocketMessage('close-room')
}

function renderIdentityBanner(): string {
  const displayName = state.playerName || t('common.guest')
  const roleLabel = state.role === 'host' ? t('common.host') : t('common.player')
  const avatar = state.myAvatar || formatPlayerInitials(displayName)

  return `
    <div class="identity-banner">
      <span class="avatar">${avatar}</span>
      <span class="identity-label">${t('common.playingAs')}</span>
      <strong>${displayName}</strong>
      <span class="identity-role">${roleLabel}</span>
      <span class="connection-status" data-role="connection-status" role="status" aria-live="polite" hidden></span>
      ${state.role === 'host'
        ? `<button class="quit-button" type="button" data-role="close-room">${t('common.closeRoom')}</button>`
        : `<button class="quit-button" type="button" data-role="quit-room">${t('common.quit')}</button>`}
    </div>
  `
}

function appendAccountBadge(): void {
  if (!state.account) {
    return
  }

  root.insertAdjacentHTML('beforeend', `
    <div class="account-badge">
      <span class="account-badge-label">${t('common.loggedInAs')}</span>
      <strong>${state.account.email}</strong>
    </div>
  `)
}

function renderWelcome(): void {
  root.innerHTML = `
    <main class="shell">
      <section class="panel welcome-panel">
        <p class="eyebrow">${t('welcome.eyebrow')}</p>
        <h1>${t('welcome.title')}</h1>
        <p class="subtitle">${t('welcome.subtitle')}</p>

        <div class="welcome-grid">
          <button class="feature-card primary" type="button" data-role="create-room">
            <span class="card-tag">${t('welcome.hostTag')}</span>
            <strong>${t('welcome.createRoom')}</strong>
            <small>${t('welcome.createRoomHint')}</small>
          </button>

          <button class="feature-card secondary" type="button" data-role="join-room">
            <span class="card-tag">${t('welcome.playerTag')}</span>
            <strong>${t('welcome.joinRoom')}</strong>
            <small>${t('welcome.joinRoomHint')}</small>
          </button>

          <button class="feature-card secondary" type="button" data-role="admin-login">
            <span class="card-tag">${t('welcome.adminTag')}</span>
            <strong>${t('welcome.adminLogin')}</strong>
            <small>${t('welcome.adminLoginHint')}</small>
          </button>
        </div>
      </section>
    </main>
  `

  root.querySelector('[data-role="create-room"]')?.addEventListener('click', () => {
    state.customQuestion = ''
    state.selectedAvatar = AVATAR_OPTIONS[0]
    void openHostFlow()
  })

  root.querySelector('[data-role="join-room"]')?.addEventListener('click', () => {
    state.selectedAvatar = AVATAR_OPTIONS[0]
    state.screen = 'join-setup'
    renderApp()
  })

  root.querySelector('[data-role="admin-login"]')?.addEventListener('click', () => {
    state.adminError = ''
    state.screen = 'admin-login'
    renderApp()
  })
}

function renderHostSetup(): void {
  const languageOptions = Object.values(languages)
    .map((meta) => `<option value="${meta.code}" ${meta.code === state.language ? 'selected' : ''}>${t(`languages.${meta.code}`)}</option>`)
    .join('')

  root.innerHTML = `
    <main class="shell">
      <section class="panel membership-panel">
        <p class="eyebrow">${t('hostSetup.eyebrow')}</p>
        <h1>${t('hostSetup.title')}</h1>
        <p class="subtitle">${t('hostSetup.subtitle')}</p>

        <form id="host-setup-form" class="membership-form">
          <label for="host-setup-name">${t('hostSetup.nameLabel')}</label>
          <input id="host-setup-name" type="text" placeholder="${t('hostSetup.namePlaceholder')}" value="${state.playerName}" required />
          <label for="host-setup-language">${t('hostSetup.languageLabel')}</label>
          <select id="host-setup-language">${languageOptions}</select>
          <label>${t('hostSetup.avatarLabel')}</label>
          ${renderAvatarPicker(state.selectedAvatar)}
          <label for="host-setup-timeout-counter">${t('hostSetup.guessTimeLabel')}</label>
          <div class="guess-time-counter" role="group" aria-label="${t('hostSetup.guessTimeLabel')}">
            <button class="counter-button" type="button" data-role="guess-time-decrease" aria-label="${t('hostSetup.decreaseGuessTime')}">-</button>
            <output id="host-setup-timeout-counter" class="counter-value" aria-live="polite">${state.guessTimeoutSeconds}s</output>
            <button class="counter-button" type="button" data-role="guess-time-increase" aria-label="${t('hostSetup.increaseGuessTime')}">+</button>
          </div>
          <small class="field-hint">${t('hostSetup.guessTimeHint')}</small>
          <button class="primary-button" type="submit">${t('hostSetup.submit')}</button>
        </form>

        <div class="membership-actions">
          <button class="ghost-button" type="button" data-role="host-setup-back">${t('hostSetup.back')}</button>
        </div>
      </section>
    </main>
  `

  root.querySelector('[data-role="host-setup-back"]')?.addEventListener('click', () => {
    state.screen = 'welcome'
    renderApp()
  })

  root.querySelector<HTMLInputElement>('#host-setup-name')?.addEventListener('input', (event) => {
    state.playerName = (event.target as HTMLInputElement).value
  })

  // Track the pick so a later re-render (e.g. picking an avatar) doesn't revert the dropdown to English.
  root.querySelector<HTMLSelectElement>('#host-setup-language')?.addEventListener('change', (event) => {
    state.language = (event.target as HTMLSelectElement).value as LanguageCode
  })

  const updateGuessTime = (change: number) => {
    state.guessTimeoutSeconds = Math.min(60, Math.max(20, state.guessTimeoutSeconds + change))
    const output = root.querySelector<HTMLOutputElement>('#host-setup-timeout-counter')
    if (output) {
      output.value = `${state.guessTimeoutSeconds}s`
      output.textContent = output.value
    }
  }

  root.querySelector('[data-role="guess-time-decrease"]')?.addEventListener('click', () => updateGuessTime(-5))
  root.querySelector('[data-role="guess-time-increase"]')?.addEventListener('click', () => updateGuessTime(5))

  root.querySelector<HTMLFormElement>('#host-setup-form')?.addEventListener('submit', (event) => {
    event.preventDefault()
    const name = root.querySelector<HTMLInputElement>('#host-setup-name')?.value ?? ''
    const language = (root.querySelector<HTMLSelectElement>('#host-setup-language')?.value ?? 'en') as LanguageCode
    createRoomSession(name, language, state.selectedAvatar, state.guessTimeoutSeconds)
  })
}

function renderJoinSetup(): void {
  const roomCodeReadOnly = state.roomCodePrefilledFromUrl
  const roomCodeDisabled = roomCodeReadOnly ? 'disabled readonly' : ''
  const roomCodeHint = roomCodeReadOnly ? `<small class="field-hint">${t('joinSetup.roomCodePrefilled')}</small>` : ''

  root.innerHTML = `
    <main class="shell">
      <section class="panel membership-panel">
        <p class="eyebrow">${t('joinSetup.eyebrow')}</p>
        <h1>${t('joinSetup.title')}</h1>
        <p class="subtitle">${t('joinSetup.subtitle')}</p>

        <form id="join-setup-form" class="membership-form">
          <label for="join-setup-name">${t('joinSetup.nameLabel')}</label>
          <input id="join-setup-name" type="text" placeholder="${t('joinSetup.namePlaceholder')}" value="${state.playerName}" required />
          <label for="join-setup-room-code">${t('joinSetup.roomCodeLabel')}</label>
          <input id="join-setup-room-code" type="text" placeholder="${t('joinSetup.roomCodePlaceholder')}" value="${state.roomCode}" required ${roomCodeDisabled} />
          ${roomCodeHint}
          <label>${t('joinSetup.avatarLabel')}</label>
          ${renderAvatarPicker(state.selectedAvatar)}
          <button class="primary-button" type="submit">${t('joinSetup.submit')}</button>
        </form>

        <div class="membership-actions">
          <button class="ghost-button" type="button" data-role="join-setup-back">${t('joinSetup.back')}</button>
        </div>
      </section>
    </main>
  `

  root.querySelector('[data-role="join-setup-back"]')?.addEventListener('click', () => {
    state.screen = 'welcome'
    renderApp()
  })

  root.querySelector<HTMLInputElement>('#join-setup-name')?.addEventListener('input', (event) => {
    state.playerName = (event.target as HTMLInputElement).value
  })

  if (!roomCodeReadOnly) {
    root.querySelector<HTMLInputElement>('#join-setup-room-code')?.addEventListener('input', (event) => {
      state.roomCode = (event.target as HTMLInputElement).value
    })
  }

  root.querySelector<HTMLFormElement>('#join-setup-form')?.addEventListener('submit', (event) => {
    event.preventDefault()
    const name = root.querySelector<HTMLInputElement>('#join-setup-name')?.value ?? ''
    const roomCode = root.querySelector<HTMLInputElement>('#join-setup-room-code')?.value ?? ''
    joinRoomSession(name, roomCode, state.selectedAvatar)
  })
}

function renderMembership(): void {
  root.innerHTML = `
    <main class="shell">
      <section class="panel membership-panel">
        <p class="eyebrow">${t('membership.eyebrow')}</p>
        <h1>${t('membership.title')}</h1>
        <p class="subtitle">${t('membership.subtitle')}</p>

        <form id="membership-form" class="membership-form">
          <label for="membership-email">${t('membership.emailLabel')}</label>
          <input id="membership-email" type="email" autocomplete="email" required />
          <label for="membership-password">${t('membership.passwordLabel')}</label>
          <input id="membership-password" type="password" autocomplete="new-password" minlength="8" required />
          <label class="membership-confirm-field" for="membership-confirm">${t('membership.confirmLabel')}</label>
          <input class="membership-confirm-field" id="membership-confirm" type="password" autocomplete="new-password" minlength="8" />
          <p class="membership-error" data-role="membership-error" aria-live="polite"></p>
          <button class="primary-button" type="submit" data-role="membership-submit">${t('membership.createAccount')}</button>
        </form>

        <div class="membership-actions">
          <button class="ghost-button" type="button" data-role="membership-toggle">${t('membership.toggleToLogin')}</button>
          <button class="ghost-button" type="button" data-role="membership-back">${t('membership.back')}</button>
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
    submit!.textContent = loginMode ? t('membership.login') : t('membership.createAccount')
    toggle.textContent = loginMode ? t('membership.toggleToSignup') : t('membership.toggleToLogin')
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
      error!.textContent = t('membership.passwordsMismatch')
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
        error!.textContent = payload.error || t('membership.unableToContinue')
        return
      }

      if (loginMode) {
        window.location.reload()
        return
      }

      error!.textContent = t('membership.accountCreated')
    } catch {
      error!.textContent = t('membership.serviceUnavailable')
    } finally {
      submit!.disabled = false
    }
  })
}

async function fetchAdminQuestions(): Promise<void> {
  try {
    const response = await fetch(buildApiUrl(`/questions?language=${state.adminLanguageFilter}`), { credentials: 'include' })
    const payload = await response.json()
    state.adminQuestions = payload.questions ?? []
  } catch {
    state.adminQuestions = []
  }
}

async function openQuestionGallery(): Promise<void> {
  try {
    const response = await fetch(buildApiUrl(`/questions?language=${state.language}`))
    const payload = await response.json()
    state.galleryQuestions = payload.questions ?? []
  } catch {
    state.galleryQuestions = []
  }

  state.showQuestionGallery = true
  renderApp()
}

function renderAdminLogin(): void {
  root.innerHTML = `
    <main class="shell">
      <section class="panel membership-panel">
        <p class="eyebrow">${t('adminLogin.eyebrow')}</p>
        <h1>${t('adminLogin.title')}</h1>
        <p class="subtitle">${t('adminLogin.subtitle')}</p>

        <form id="admin-login-form" class="membership-form">
          <label for="admin-login-email">${t('adminLogin.emailLabel')}</label>
          <input id="admin-login-email" type="email" autocomplete="email" required />
          <label for="admin-login-password">${t('adminLogin.passwordLabel')}</label>
          <input id="admin-login-password" type="password" autocomplete="current-password" required />
          <p class="membership-error" data-role="admin-login-error" aria-live="polite">${state.adminError}</p>
          <button class="primary-button" type="submit" data-role="admin-login-submit">${t('adminLogin.submit')}</button>
        </form>

        <div class="membership-actions">
          <button class="ghost-button" type="button" data-role="admin-login-back">${t('adminLogin.back')}</button>
        </div>
      </section>
    </main>
  `

  const form = root.querySelector<HTMLFormElement>('#admin-login-form')
  const error = root.querySelector<HTMLElement>('[data-role="admin-login-error"]')
  const submit = root.querySelector<HTMLButtonElement>('[data-role="admin-login-submit"]')

  root.querySelector('[data-role="admin-login-back"]')?.addEventListener('click', () => {
    state.screen = 'welcome'
    renderApp()
  })

  form?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const email = root.querySelector<HTMLInputElement>('#admin-login-email')?.value.trim() ?? ''
    const password = root.querySelector<HTMLInputElement>('#admin-login-password')?.value ?? ''

    submit!.disabled = true
    error!.textContent = ''
    try {
      const loginResponse = await fetch(buildApiUrl('/auth/login'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const loginPayload = await loginResponse.json()
      if (!loginResponse.ok) {
        error!.textContent = loginPayload.error || t('adminLogin.invalidError')
        return
      }

      const sessionResponse = await fetch(buildApiUrl('/auth/session'), { credentials: 'include' })
      const sessionPayload = await sessionResponse.json()
      const account = sessionPayload.user as Account | null

      if (!account?.isAdmin) {
        error!.textContent = t('adminLogin.notAdminError')
        return
      }

      state.account = account
      state.adminLanguageFilter = 'en'
      await fetchAdminQuestions()
      state.screen = 'admin-gallery'
      renderApp()
    } catch {
      error!.textContent = t('adminLogin.invalidError')
    } finally {
      submit!.disabled = false
    }
  })
}

function renderAdminGallery(): void {
  const languageOptions = Object.values(languages)
    .map((meta) => `<option value="${meta.code}" ${meta.code === state.adminLanguageFilter ? 'selected' : ''}>${t(`languages.${meta.code}`)}</option>`)
    .join('')

  root.innerHTML = `
    <main class="shell">
      <section class="panel membership-panel">
        <p class="eyebrow">${t('adminGallery.eyebrow')}</p>
        <h1>${t('adminGallery.title')}</h1>
        <p class="subtitle">${t('adminGallery.subtitle')}</p>

        <form id="admin-add-question-form" class="membership-form">
          <label for="admin-add-language">${t('adminGallery.languageLabel')}</label>
          <select id="admin-add-language">${languageOptions}</select>
          <label for="admin-add-text">${t('adminGallery.questionTextLabel')}</label>
          <textarea id="admin-add-text" rows="3" maxlength="220"></textarea>
          <p class="membership-error" data-role="admin-add-error" aria-live="polite"></p>
          <button class="primary-button" type="submit">${t('adminGallery.addButton')}</button>
        </form>

        <div class="section-head">
          <h2>${t('adminGallery.languageLabel')}</h2>
          <select id="admin-filter-language">${languageOptions}</select>
        </div>

        <div class="result-list">
          ${state.adminQuestions.length > 0
            ? state.adminQuestions
                .map(
                  (question) => `
                    <div class="result-row">
                      <span>${question.text}</span>
                      <button class="ghost-button" type="button" data-role="admin-delete-question" data-question-id="${question.id}">${t('adminGallery.deleteButton')}</button>
                    </div>
                  `,
                )
                .join('')
            : `<div class="result-row"><span>${t('adminGallery.emptyState')}</span></div>`}
        </div>

        <div class="membership-actions">
          <button class="ghost-button" type="button" data-role="admin-gallery-back">${t('adminGallery.back')}</button>
        </div>
      </section>
    </main>
  `

  root.querySelector('[data-role="admin-gallery-back"]')?.addEventListener('click', () => {
    state.screen = 'welcome'
    renderApp()
  })

  root.querySelector<HTMLSelectElement>('#admin-filter-language')?.addEventListener('change', (event) => {
    state.adminLanguageFilter = (event.target as HTMLSelectElement).value as LanguageCode
    void fetchAdminQuestions().then(renderApp)
  })

  root.querySelectorAll<HTMLButtonElement>('[data-role="admin-delete-question"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const questionId = button.dataset.questionId ?? ''
      await fetch(buildApiUrl(`/admin/questions/${questionId}`), { method: 'DELETE', credentials: 'include' })
      await fetchAdminQuestions()
      renderApp()
    })
  })

  const addForm = root.querySelector<HTMLFormElement>('#admin-add-question-form')
  const addError = root.querySelector<HTMLElement>('[data-role="admin-add-error"]')

  addForm?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const language = root.querySelector<HTMLSelectElement>('#admin-add-language')?.value ?? 'en'
    const text = root.querySelector<HTMLTextAreaElement>('#admin-add-text')?.value.trim() ?? ''

    addError!.textContent = ''
    try {
      const response = await fetch(buildApiUrl('/admin/questions'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language, text }),
      })
      const payload = await response.json()
      if (!response.ok) {
        addError!.textContent = payload.error || t('adminGallery.addButton')
        return
      }

      state.adminLanguageFilter = language as LanguageCode
      await fetchAdminQuestions()
      renderApp()
    } catch {
      addError!.textContent = t('adminGallery.addButton')
    }
  })
}

function renderLobby(): void {
  const leaderboard = [...state.players].sort((a, b) => b.score - a.score)
  const hostQuestionIsValid = state.customQuestion.trim().length >= 8

  root.innerHTML = `
    <main class="shell">
      ${renderIdentityBanner()}
      <section class="panel hero-panel">
        <div class="hero-copy">
          <p class="eyebrow">${state.role === 'host' ? t('lobby.hostView') : t('lobby.playerView')}</p>
          <h1>${state.role === 'host' ? t('lobby.roomReady') : t('lobby.waitingInRoom')}</h1>
          <p class="subtitle">${t('lobby.roomCodeLine', { code: state.roomCode })}</p>
        </div>

        <div class="room-card">
          <span class="chip">${t('lobby.roomCodeChip')}</span>
          <strong>${state.roomCode}</strong>
          ${state.role === 'host'
            ? `<button class="primary-button" type="button" data-role="start-round" ${hostQuestionIsValid ? '' : 'disabled'}>${t('lobby.startRound')}</button>`
            : `<div class="chip">${t('lobby.waitingForHost')}</div>`}
        </div>

        ${state.role === 'host'
          ? `<button class="secondary-button" type="button" data-role="toggle-share-room">${t('roomSharing.shareButton')}</button>`
          : ''}
      </section>

      ${state.role === 'host' && state.showRoomSharingPanel
        ? `<section class="panel" id="sharing-panel-container"></section>`
        : ''}

      <section class="panel">
        <div class="section-head">
          <h2>${t('lobby.players')}</h2>
          <span>${t('lobby.joinedCount', { count: state.players.length })}</span>
        </div>

        <div class="player-list">
          ${state.players
            .map(
              (player) => `
                <div class="player-pill ${player.id === state.currentPlayerId ? 'active' : ''}">
                  <span class="avatar">${formatPlayerAvatar(player)}</span>
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
              <h2>${t('lobby.roundPrompt')}</h2>
              <span>${state.customQuestion.trim() ? t('lobby.readyToPlay') : t('lobby.required')}</span>
            </div>

            <form id="host-question-form" class="host-question-form">
              <label for="host-question">${t('lobby.questionLabel')}</label>
              <textarea id="host-question" rows="3" maxlength="220" placeholder="${t('lobby.questionPlaceholder')}">${state.customQuestion}</textarea>
              <div class="host-question-actions">
                <button class="secondary-button" type="submit">${t('lobby.saveQuestion')}</button>
                <button class="ghost-button" type="button" data-role="clear-question">${t('lobby.clear')}</button>
                <button class="ghost-button" type="button" data-role="browse-gallery">${t('lobby.browseGallery')}</button>
              </div>
            </form>

            ${state.showQuestionGallery
              ? `
                <div class="result-list">
                  <div class="section-head">
                    <h2>${t('lobby.galleryTitle')}</h2>
                    <button class="ghost-button" type="button" data-role="close-gallery">${t('lobby.galleryClose')}</button>
                  </div>
                  ${state.galleryQuestions.length > 0
                    ? state.galleryQuestions
                        .map(
                          (question) => `
                            <button type="button" class="result-row" data-role="select-gallery-question" data-question-text="${question.text.replace(/"/g, '&quot;')}">
                              <span>${question.text}</span>
                              <strong>${t('lobby.gallerySelect')}</strong>
                            </button>
                          `,
                        )
                        .join('')
                    : `<div class="result-row"><span>${t('lobby.galleryEmpty')}</span></div>`}
                </div>
                `
              : ''}

            <div class="rules-list">
              <div class="rule-item"><strong>1.</strong><span>${t('lobby.hostRule1')}</span></div>
              <div class="rule-item"><strong>2.</strong><span>${t('lobby.hostRule2')}</span></div>
              <div class="rule-item"><strong>3.</strong><span>${t('lobby.hostRule3')}</span></div>
              <div class="rule-item"><strong>4.</strong><span>${t('lobby.hostRule4')}</span></div>
            </div>
          </section>
          `
        : `
          <section class="panel">
            <div class="section-head">
              <h2>${t('lobby.roomRules')}</h2>
            </div>
            <div class="rules-list">
              <div class="rule-item"><strong>1.</strong><span>${t('lobby.playerRule1')}</span></div>
              <div class="rule-item"><strong>2.</strong><span>${t('lobby.playerRule2')}</span></div>
              <div class="rule-item"><strong>3.</strong><span>${t('lobby.playerRule3')}</span></div>
              <div class="rule-item"><strong>4.</strong><span>${t('lobby.playerRule4')}</span></div>
            </div>
          </section>
          `}

      <section class="panel">
        <div class="section-head">
          <h2>${t('lobby.leaderboard')}</h2>
        </div>

        <div class="leaderboard">
          ${leaderboard
            .map(
              (player, index) => `
                <div class="leaderboard-row ${index === 0 ? 'winner' : ''}">
                  <span>#${index + 1} ${formatPlayerAvatar(player)} ${player.name}</span>
                  <strong>${formatScore(player.score)}</strong>
                </div>
              `,
            )
            .join('')}
        </div>
      </section>
    </main>
  `

  // Render sharing panel if needed
  if (state.role === 'host' && state.showRoomSharingPanel) {
    const sharingContainer = root.querySelector('#sharing-panel-container')
    if (sharingContainer) {
      void renderRoomSharingPanel().then((panelHtml) => {
        sharingContainer.innerHTML = panelHtml

        // Add copy button handler
        sharingContainer.querySelector('[data-role="copy-share-link"]')?.addEventListener('click', () => {
          const linkInput = sharingContainer.querySelector<HTMLInputElement>('#room-share-link')
          if (linkInput) {
            void navigator.clipboard.writeText(linkInput.value).then(() => {
              window.alert(t('roomSharing.copiedMessage'))
            }).catch(() => {
              window.alert(t('roomSharing.copyError'))
            })
          }
        })
      })
    }
  }

  root.querySelector('[data-role="toggle-share-room"]')?.addEventListener('click', () => {
    state.showRoomSharingPanel = !state.showRoomSharingPanel
    renderApp()
  })

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
      window.alert(t('prompts.typeQuestionFirst'))
      return
    }

    state.customQuestion = value
    renderApp()
  })

  root.querySelector('[data-role="browse-gallery"]')?.addEventListener('click', () => {
    void openQuestionGallery()
  })

  root.querySelector('[data-role="close-gallery"]')?.addEventListener('click', () => {
    state.showQuestionGallery = false
    renderApp()
  })

  root.querySelectorAll<HTMLButtonElement>('[data-role="select-gallery-question"]').forEach((button) => {
    button.addEventListener('click', () => {
      state.customQuestion = button.dataset.questionText ?? ''
      state.showQuestionGallery = false
      renderApp()
    })
  })
}

function renderHostManaging(): void {
  const visiblePlayers = state.players.filter((player) => player.id !== state.currentPlayerId)
  const guessMap = new Map(state.guesses.map((guess) => [guess.guesserId, guess]))

  root.innerHTML = `
    <main class="shell">
      ${renderIdentityBanner()}
      <section class="panel round-panel">
        <div class="round-header">
          <div>
            <p class="eyebrow">${t('hostManaging.round', { number: state.answerRoundNumber })}</p>
            <h1>${state.question}</h1>
          </div>
          ${state.phase === 'answer-collection' ? `<div class="timer-box">${t('hostManaging.answerCollection')}</div>` : renderGuessTimerBox(t('hostManaging.guessingPhase'))}
        </div>

        <div class="answer-reveal">
          <span>${state.phase === 'answer-collection' ? t('hostManaging.hiddenAnswer') : t('hostManaging.randomAnswer')}</span>
          <strong>${state.phase === 'answer-collection' ? t('hostManaging.waitingForReveal') : state.selectedAnswer}</strong>
        </div>

        ${state.phase === 'answer-collection'
          ? `
            <div class="turn-box">
              <p>${t('hostManaging.answerCollection')}</p>
              <h2>${t('hostManaging.submittedCount', { count: state.answers.length })}</h2>
            </div>
            <button class="primary-button" type="button" data-role="lock-answers" ${state.answers.length > 0 ? '' : 'disabled'}>${t('hostManaging.startGuessing')}</button>
            `
          : `
            <div class="turn-box">
              <p>${t('hostManaging.currentTurn')}</p>
              <h2>${t('hostManaging.chooseWhoWroteIt')}</h2>
            </div>

            <div class="guess-status-list">
              ${visiblePlayers
                .map((player) => {
                  const guess = guessMap.get(player.id)
                  return `
                    <div class="guess-status-row ${guess ? 'done' : 'waiting'}">
                      <span>${formatPlayerAvatar(player)} ${player.name}</span>
                      <strong>${guess ? t('hostManaging.guessedLabel', { name: guess.guessedName }) : t('hostManaging.notGuessedYet')}</strong>
                    </div>
                  `
                })
                .join('')}
            </div>
            <div class="host-actions-row">
              <button class="primary-button" type="button" data-role="calculate-score">${t('hostManaging.stopTimer')}</button>
            </div>
          `}
      </section>

      <section class="panel">
        <div class="section-head">
          <h2>${t('hostManaging.submittedAnswers')}</h2>
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
            : `<div class="result-row"><span>${t('hostManaging.noAnswersYet')}</span></div>`}
        </div>
      </section>

      <section class="panel">
        <div class="section-head">
          <h2>${t('hostManaging.liveLeaderboard')}</h2>
        </div>

        <div class="leaderboard">
          ${[...state.players]
            .sort((a, b) => b.score - a.score)
            .map(
              (player, index) => `
                <div class="leaderboard-row ${index === 0 ? 'winner' : ''}">
                  <span>#${index + 1} ${formatPlayerAvatar(player)} ${player.name}</span>
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
      ${renderIdentityBanner()}
      <section class="panel player-answer-panel">
        <p class="eyebrow">${t('hostManaging.round', { number: state.answerRoundNumber })}</p>
        <h1>${state.question}</h1>

        ${alreadySubmitted
          ? `
            <div class="mini-card">
              <span>${t('playerAnswering.thanksSubmitted')}</span>
              <strong>${t('playerAnswering.waitingForOthers')}</strong>
            </div>
          `
          : `
            <div class="answer-box">
              <label for="player-answer">${t('playerAnswering.writeAnswer')}</label>
              <textarea id="player-answer" rows="4" placeholder="${t('playerAnswering.answerPlaceholder')}"></textarea>
            </div>

            <button class="primary-button" type="button" data-role="submit-answer">${t('playerAnswering.submitAnswer')}</button>
          `}

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
  // Players already revealed as a correct answer in an earlier round are no longer valid guesses.
  const guessOptions = state.players.filter((player) => player.id !== state.currentPlayerId && state.remainingAuthorIds.includes(player.id))
  const selectedGuessId = state.selectedGuessId ?? state.guesses.find((entry) => entry.guesserId === state.currentPlayerId)?.guessedId ?? null
  const guessIsLocked = Boolean(selectedGuessId)
  const currentPlayer = getCurrentPlayer()
  const currentPlayerRank = getCurrentPlayerRank()
  const placementLabel = currentPlayerRank === 1 ? t('playerGuessing.place1') : currentPlayerRank === 2 ? t('playerGuessing.place2') : currentPlayerRank === 3 ? t('playerGuessing.place3') : null

  root.innerHTML = `
    <main class="shell">
      ${renderIdentityBanner()}
      <section class="panel round-panel">
        <div class="round-header">
          <div>
            <p class="eyebrow">${t('hostManaging.round', { number: state.answerRoundNumber })}</p>
            <h1>${state.question}</h1>
          </div>
          ${renderGuessTimerBox(t('playerGuessing.guessingPhase'))}
        </div>

        <div class="answer-reveal">
          <span>${t('playerGuessing.answerWasThis')}</span>
          <strong>${state.selectedAnswer}</strong>
        </div>

        <div class="turn-box">
          <p>${t('playerGuessing.currentTurn')}</p>
          <h2>${t('playerGuessing.guessWhoWroteIt')}</h2>
        </div>

        <div class="guess-score-status">
          <div>
            <span>${t('playerGuessing.yourScore')}</span>
            <strong>${currentPlayer ? formatScore(currentPlayer.score) : t('playerGuessing.scoreLoading')}</strong>
          </div>
          ${placementLabel ? `<span class="score-placement rank-${currentPlayerRank}">${placementLabel}</span>` : ''}
        </div>

        <div class="guess-grid">
          ${guessOptions
            .map(
              (player) => `
                <button type="button" class="guess-card ${selectedGuessId === player.id ? 'selected' : ''} ${guessIsLocked ? 'locked' : ''}" data-guess-id="${player.id}">
                  <span>${formatPlayerAvatar(player)} ${player.name}</span>
                  <small>${t('playerGuessing.guessThisPerson')}</small>
                </button>
              `,
            )
            .join('')}
        </div>

        <div class="mini-card">
          <span>${selectedGuessId ? t('playerGuessing.yourPick') : t('playerGuessing.waitingForPick')}</span>
          <strong>${selectedGuessId ? guessOptions.find((player) => player.id === selectedGuessId)?.name ?? t('playerGuessing.selected') : t('playerGuessing.noSelectionYet')}</strong>
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
      ${renderIdentityBanner()}
      <section class="panel summary-panel">
        <p class="eyebrow">${t('roundEnd.complete')}</p>
        <h1>${t('roundEnd.standings')}</h1>

        <div class="leaderboard">
          ${sortedPlayers
            .map(
              (player, index) => `
                <div class="leaderboard-row ${index === 0 ? 'winner' : ''}">
                  <span>#${index + 1} ${formatPlayerAvatar(player)} ${player.name}</span>
                  <strong>${formatScore(player.score)}</strong>
                </div>
              `,
            )
            .join('')}
        </div>
      </section>

      <section class="panel">
        <div class="section-head">
          <h2>${t('roundEnd.results')}</h2>
        </div>

        <div class="mini-card">
          <span>${t('roundEnd.answerWas')}</span>
          <strong>"${state.selectedAnswer}"</strong>
        </div>

        <div class="mini-card">
          <span>${t('roundEnd.writtenBy')}</span>
          <strong>${(() => {
            const author = state.players.find((player) => player.id === state.answerAuthorId)
            return author ? `${formatPlayerAvatar(author)} ${author.name}` : t('roundEnd.unknown')
          })()}</strong>
        </div>

        <div class="result-list">
          ${state.roundResults
            .map(
              (result) => `
                <div class="result-row ${result.correct ? 'success' : 'fail'}">
                  <span>${t('roundEnd.guessedLine', { guesser: result.guesserName, guessed: result.guessedName })}</span>
                  <strong>${result.correct ? t('roundEnd.pointsEarned', { points: result.points }) : t('roundEnd.noPoints')}</strong>
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
          return `<div class="mini-card"><span>${myResult.correct ? t('roundEnd.earnedMore') : t('roundEnd.missedIt')}</span></div>`
        })()}

        ${state.role === 'host' ? `<button class="primary-button next-round" type="button" data-role="next-round">${state.answerRoundNumber >= state.answers.length ? t('roundEnd.goToFinalBoard') : t('roundEnd.nextRound')}</button>` : ''}
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
      ${renderIdentityBanner()}
      <section class="panel summary-panel">
        <p class="eyebrow">${t('gameEnd.complete')}</p>
        <h1>${t('gameEnd.finished')}</h1>

        <div class="leaderboard">
          ${sortedPlayers
            .map(
              (player, index) => `
                <div class="leaderboard-row ${index === 0 ? 'winner' : index === 1 ? 'second' : index === 2 ? 'third' : ''}">
                  <span>#${index + 1} ${formatPlayerAvatar(player)} ${player.name}</span>
                  <strong>${formatScore(player.score)}</strong>
                </div>
              `,
            )
            .join('')}
        </div>
      </section>

      <section class="panel">
        <div class="section-head">
          <h2>${t('gameEnd.topPerformers')}</h2>
        </div>

        <div class="result-list">
          ${topThree
            .map(
              (player, index) => `
                <div class="result-row success">
                  <span>${[t('gameEnd.gold'), t('gameEnd.silver'), t('gameEnd.bronze')][index]} — ${formatPlayerAvatar(player)} ${player.name}</span>
                  <strong>${formatScore(player.score)}</strong>
                </div>
              `,
            )
            .join('')}
        </div>
      </section>

      ${state.role === 'host' ? `<button class="primary-button next-round" type="button" data-role="new-game">${t('gameEnd.newGame')}</button>` : ''}
    </main>
  `

  root.querySelector<HTMLButtonElement>('[data-role="new-game"]')?.addEventListener('click', () => {
    state.customQuestion = ''
    requestNewGame()
  })
}

function renderApp(): void {
  // Screens outside an active room are never room-scoped, so they must not inherit a previous room's language.
  if (state.screen === 'welcome' || state.screen === 'host-setup' || state.screen === 'join-setup' || state.screen === 'admin-login' || state.screen === 'admin-gallery') {
    setLanguage('en')
  }

  if (state.screen === 'welcome') {
    renderWelcome()
    appendAccountBadge()
    return
  }

  if (state.screen === 'membership') {
    renderMembership()
    appendAccountBadge()
    return
  }

  if (state.screen === 'admin-login') {
    renderAdminLogin()
    appendAccountBadge()
    return
  }

  if (state.screen === 'admin-gallery') {
    renderAdminGallery()
    appendAccountBadge()
    return
  }

  if (state.screen === 'host-setup') {
    renderHostSetup()
    appendAccountBadge()
    return
  }

  if (state.screen === 'join-setup') {
    renderJoinSetup()
    appendAccountBadge()
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

function connectSocket(): void {
  socket = new WebSocket(buildSocketUrl())

  socket.addEventListener('open', () => {
    reconnectAttempt = 0
    reconnectAlertShown = false
    updateConnectionStatus(false)

    if (shouldRestoreRoomSession && storedRoomSession) {
      socket.send(JSON.stringify({
        type: 'reconnect-room',
        roomCode: storedRoomSession.roomCode,
        role: storedRoomSession.role,
        reconnectToken: storedRoomSession.reconnectToken,
      }))
      shouldRestoreRoomSession = false
    }

    if (queuedAction) {
      const nextAction = queuedAction
      queuedAction = null
      nextAction()
    }
  })

  socket.addEventListener('message', (event) => {
    try {
      const payload = JSON.parse(event.data)

      if (payload.type === 'room-session') {
        const session = payload.session as RoomSession
        saveRoomSession(session)
        state.roomCode = session.roomCode
        state.role = session.role
        state.currentPlayerId = session.playerId
        state.playerName = session.playerName
        return
      }

      if (payload.type === 'room-state') {
        applyRoomState(payload.state)
        return
      }

      if (payload.type === 'left-room') {
        clearStoredRoomSession()
        shouldRestoreRoomSession = false
        state.screen = 'welcome'
        state.roomCode = ''
        state.playerName = ''
        state.currentPlayerId = ''
        state.players = []
        renderApp()
        return
      }

      if (payload.type === 'room-closed') {
        clearStoredRoomSession()
        shouldRestoreRoomSession = false
        state.screen = 'welcome'
        state.roomCode = ''
        state.playerName = ''
        state.currentPlayerId = ''
        state.players = []
        setLanguage('en')
        window.alert(t('prompts.roomClosed'))
        renderApp()
        return
      }

      if (payload.type === 'player-left') {
        window.alert(t('prompts.playerLeft', { name: payload.playerName }))
        return
      }

      if (payload.type === 'error') {
        if (payload.code === 'ROOM_SESSION_EXPIRED' || payload.code === 'ROOM_SESSION_INVALID') {
          clearStoredRoomSession()
          shouldRestoreRoomSession = false
          state.screen = 'welcome'
          state.roomCode = ''
          state.playerName = ''
          state.currentPlayerId = ''
          renderApp()
        }
        window.alert(payload.code ? t(`errors.${payload.code}`) : (payload.message || t('errors.default')))
      }
    } catch {
      window.alert(t('prompts.invalidRoomData'))
    }
  })

  socket.addEventListener('close', () => {
    if (isPageUnloading) {
      return
    }

    reconnectAttempt += 1

    if (isActiveRoomScreen()) {
      updateConnectionStatus(true)
      if (reconnectAttempt >= 5 && !reconnectAlertShown) {
        reconnectAlertShown = true
        window.alert(t('prompts.connectionClosed'))
      }
    }

    scheduleSocketReconnect()
  })
}

connectSocket()

window.addEventListener('pagehide', () => {
  isPageUnloading = true
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
})

async function consumeEmailVerificationLink(): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  const token = params.get('verify')
  if (!token) {
    return
  }

  // Strip the token from the URL immediately so it can't be reused/leaked via history or referrers.
  params.delete('verify')
  const cleanedSearch = params.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${cleanedSearch ? `?${cleanedSearch}` : ''}`)

  try {
    const response = await fetch(buildApiUrl('/auth/verify-email'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    const payload = await response.json()
    window.alert(response.ok ? t('prompts.emailVerified') : (payload.error || t('prompts.verifyLinkInvalid')))
  } catch {
    window.alert(t('prompts.verifyLater'))
  }
}

function initializeRoomLinkIfProvided(): void {
  const roomLinkData = parseRoomJoinLink()
  if (roomLinkData) {
    state.roomCode = roomLinkData.roomCode
    state.language = roomLinkData.language
    state.screen = 'join-setup'
    state.roomCodePrefilledFromUrl = true
    setLanguage(roomLinkData.language)
  }
}

consumeEmailVerificationLink().finally(() => {
  initializeRoomLinkIfProvided()
  renderApp()
})
