import './style.css'
import QRCode from 'qrcode'
import { type LanguageCode, getLanguage, languages, setLanguage, t } from './i18n'

type Role = 'host' | 'player'
type Screen = 'welcome' | 'membership' | 'host-setup' | 'join-setup' | 'lobby' | 'host-managing' | 'player-answering' | 'player-guessing' | 'matching-board' | 'round-end' | 'game-end' | 'admin-login' | 'admin-gallery' | 'ask-question' | 'waiting-for-question'

type GuessFlowMode = 'sequential' | 'allAtOnce'

type MatchingSlot = {
  slotId: string
  text: string
  authorId?: string
}

type MyMatch = {
  slotId: string
  guessedId: string
  guessedName: string
}

type MatchingProgressEntry = {
  playerId: string
  done: boolean
}

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

type AdminGalleryQuestion = GalleryQuestion & {
  language: LanguageCode
  translationGroupId: string
}

type SuggestionEntry = {
  id: string
  playerId: string
  playerName: string
  text: string
}

type PoolQuestion = {
  id: string
  playerId: string
  playerName: string
  text: string
  createdAt?: number
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
  ready?: boolean
  connected?: boolean
  poolQuestionCount?: number
}

type GuessRecord = {
  guesserId: string
  guesserName: string
  guessedId: string
  guessedName: string
  correct: boolean
  points: number
  answerSlot?: 'A' | 'B'
}

type RoundResult = {
  guesserId?: string
  guesserName: string
  guessedName: string
  correct: boolean
  points: number
  answerSlot?: 'A' | 'B'
}

type FinalMatchup = {
  answers: Array<{ slot: 'A' | 'B'; text: string }>
  authorIds: string[]
  autoRevealed: boolean
  truth: { A: string; B: string } | null
}

type RoomState = {
  code: string
  phase: 'lobby' | 'asking' | 'answer-collection' | 'guessing' | 'matching' | 'round-end' | 'game-end'
  answerRoundNumber: number
  question: string
  questionAuthorName: string | null
  selectedAnswer: string
  answerAuthorId: string | null
  activeGuesserIndex: number
  players: Player[]
  answers: Array<{ playerId: string; playerName: string; text: string }>
  guesses: GuessRecord[]
  roundResults: RoundResult[]
  hostId: string | null
  hostName?: string
  hostAvatar?: string
  timeLeft: number
  language: LanguageCode
  guessTimeoutSeconds: number
  guessDeadlineMs: number | null
  guessCountdownEndsAt: number | null
  remainingAuthorIds: string[]
  hostIsPlayer: boolean
  askingPlayerId: string | null
  pendingNextAskerId: string | null
  finalMatchup: FinalMatchup | null
  allowPlayerSuggestions: boolean
  suggestedQuestions: SuggestionEntry[]
  mySuggestedQuestions: SuggestionEntry[]
  questionPoolMode?: boolean
  poolQuestions?: PoolQuestion[]
  myPoolQuestions?: PoolQuestion[]
  poolQuestionCount?: number
  poolTotalQuestions?: number
  currentPoolQuestionIndex?: number
  allPlayersReady?: boolean
  canStartGame?: boolean
  roundEndConfirmedIds?: string[]
  guessFlowMode?: GuessFlowMode
  matchingBoard?: MatchingSlot[]
  matchingAuthorIds?: string[]
  myMatches?: MyMatch[]
  matchingProgress?: MatchingProgressEntry[]
  matchingConfirmed?: boolean
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

  if (target.closest('[data-role="toggle-manage-players"]')) {
    state.showManagePlayersPanel = !state.showManagePlayersPanel
    renderApp()
    return
  }

  const kickButton = target.closest<HTMLElement>('[data-role="kick-player"]')
  if (kickButton) {
    const playerId = kickButton.dataset.playerId ?? ''
    const playerName = kickButton.dataset.playerName ?? ''
    kickPlayer(playerId, playerName)
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
const postLoginScreenStorageKey = 'guess-party-post-login-screen'

const state = {
  screen: 'welcome' as Screen,
  account: null as Account | null,
  role: storedRoomSession?.role ?? 'host' as Role,
  roomCode: storedRoomSession?.roomCode ?? '',
  playerName: storedRoomSession?.playerName ?? '',
  currentPlayerId: storedRoomSession?.playerId ?? '',
  players: [] as Player[],
  hostId: '' as string,
  hostName: '' as string,
  hostAvatar: '' as string,
  roundEndConfirmedIds: [] as string[],
  // Tracks whether the result overlay/sound already fired for the current round-end instance, since
  // renderRoundEnd() re-renders on every broadcast (e.g. other players confirming next round).
  roundEndOverlayShown: false,
  selectedAllAtOnceResultsPlayerId: null as string | null,
  answerRoundNumber: 0,
  question: '',
  questionAuthorName: null as string | null,
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
  selectedGuessSlot: null as 'A' | 'B' | null,
  hasSubmittedAnswer: false,
  language: getLanguage(),
  selectedAvatar: AVATAR_OPTIONS[0],
  myAvatar: '',
  guessTimeoutSeconds: 20,
  guessDeadlineMs: null as number | null,
  guessCountdownEndsAt: null as number | null,
  remainingAuthorIds: [] as string[],
  hostIsPlayer: false,
  askingPlayerId: null as string | null,
  pendingNextAskerId: null as string | null,
  addSelfAsPlayer: false,
  allowPlayerSuggestions: false,
  suggestedQuestions: [] as SuggestionEntry[],
  mySuggestedQuestions: [] as SuggestionEntry[],
  suggestionDraft: '',
  questionPoolMode: false,
  poolQuestions: [] as PoolQuestion[],
  myPoolQuestions: [] as PoolQuestion[],
  poolQuestionDraft: '',
  isPlayerReady: false,
  poolMaxReadyConfirmationSent: false,
  poolQuestionCount: 0,
  poolTotalQuestions: 0,
  currentPoolQuestionIndex: 0,
  allPlayersReady: false,
  canStartGame: false,
  askerOverlayConfirmed: false,
  askQuestionDraft: '',
  adminError: '',
  adminLanguageFilter: 'en' as LanguageCode,
  adminQuestions: [] as AdminGalleryQuestion[],
  adminLinkedGroupIds: new Set<string>(),
  adminTranslatingId: '' as string,
  adminTranslationTarget: '' as LanguageCode | '',
  adminTranslationDraft: '',
  adminTranslationError: '',
  adminTranslationLoading: false,
  showQuestionGallery: false,
  galleryQuestions: [] as GalleryQuestion[],
  privateQuestions: [] as GalleryQuestion[],
  galleryFilter: 'all' as 'all' | 'public' | 'private',
  myGalleryError: '',
  showRoomSharingPanel: false,
  showManagePlayersPanel: false,
  rulesPanelOpen: false,
  roomCodePrefilledFromUrl: false,
  finalMatchup: null as FinalMatchup | null,
  guessFlowMode: 'sequential' as GuessFlowMode,
  matchingBoard: [] as MatchingSlot[],
  matchingAuthorIds: [] as string[],
  myMatches: [] as MyMatch[],
  matchingProgress: [] as MatchingProgressEntry[],
  matchingConfirmed: false,
  // Tap-to-place fallback: the name token currently "picked up", awaiting a tap on a slot.
  matchingSelectedTokenId: null as string | null,
}

let queuedAction: (() => void) | null = null
let shouldRestoreRoomSession = Boolean(storedRoomSession)
let isPageUnloading = false
let reconnectAttempt = 0
let reconnectTimer: number | null = null
let reconnectAlertShown = false

// Vite dev server (5173) proxies nothing, so dev must reach the API/WS server on its own port.
const DEV_API_PORT = import.meta.env.VITE_API_PORT || '8080'

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

function getRandomResultMessage(isCorrect: boolean): string {
  const correctMessages = [
    'resultOverlay.greatGuess',
    'resultOverlay.youWereCorrect',
    'resultOverlay.veryWellDone',
    'resultOverlay.excellent',
  ]
  const incorrectMessages = [
    'resultOverlay.wrongGuess',
    'resultOverlay.badGuess',
    'resultOverlay.youMissedIt',
    'resultOverlay.notSoCleverGuess',
  ]
  const messages = isCorrect ? correctMessages : incorrectMessages
  return t(messages[Math.floor(Math.random() * messages.length)])
}

function playCelebrationSound(isCorrect: boolean): void {
  try {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
    const now = audioContext.currentTime
    const duration = 0.3
    
    // Create an oscillator for the tone
    const oscillator = audioContext.createOscillator()
    const gainNode = audioContext.createGain()
    
    oscillator.connect(gainNode)
    gainNode.connect(audioContext.destination)
    
    if (isCorrect) {
      // Success sound: ascending ding (800Hz to 1000Hz)
      oscillator.frequency.setValueAtTime(800, now)
      oscillator.frequency.exponentialRampToValueAtTime(1000, now + duration * 0.6)
      oscillator.frequency.setValueAtTime(1000, now + duration * 0.6)
      oscillator.frequency.exponentialRampToValueAtTime(800, now + duration)
    } else {
      // Failure sound: descending buzz (300Hz to 150Hz)
      oscillator.frequency.setValueAtTime(300, now)
      oscillator.frequency.exponentialRampToValueAtTime(150, now + duration)
    }
    
    // Envelope: quick attack, natural decay
    gainNode.gain.setValueAtTime(0.3, now)
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + duration)
    
    oscillator.start(now)
    oscillator.stop(now + duration)
  } catch {
    // Audio context not available or blocked by browser, silently fail
  }
}

type ResultOverlayKind = 'success' | 'fail' | 'no-guess'

function renderResultCelebrationOverlay(kind: ResultOverlayKind, points = 0): string {
  const isSuccess = kind === 'success'
  const message = kind === 'no-guess' ? t('resultOverlay.noGuess') : getRandomResultMessage(isSuccess)
  const confettiParticles = isSuccess
    ? Array.from({ length: 15 }, (_, i) => `<div class="confetti-particle" style="left: ${Math.random() * 100}%; top: ${Math.random() * 100}%; --delay: ${i * 30}ms; --duration: ${2000 + Math.random() * 500}ms;"></div>`)
        .join('')
    : ''

  return `
    <div class="celebration-overlay celebration-overlay--${kind}">
      <div class="celebration-overlay-backdrop"></div>
      <div class="celebration-overlay-content">
        <div class="celebration-overlay-text">${message}</div>
        ${isSuccess ? `<div class="celebration-overlay-points">+${points} pts</div>` : ''}
        ${confettiParticles}
      </div>
    </div>
  `
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
  state.hostId = serverState.hostId ?? state.hostId
  state.hostName = serverState.hostName ?? state.hostName
  state.hostAvatar = serverState.hostAvatar ?? state.hostAvatar
  state.roundEndConfirmedIds = serverState.roundEndConfirmedIds ?? []
  state.answerRoundNumber = serverState.answerRoundNumber ?? state.answerRoundNumber
  state.question = serverState.question ?? state.question
  state.questionAuthorName = serverState.questionAuthorName ?? null
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
  state.guessCountdownEndsAt = serverState.guessCountdownEndsAt ?? null
  state.remainingAuthorIds = serverState.remainingAuthorIds ?? state.remainingAuthorIds
  state.hostIsPlayer = serverState.hostIsPlayer ?? state.hostIsPlayer
  state.pendingNextAskerId = serverState.pendingNextAskerId ?? null
  state.finalMatchup = serverState.finalMatchup ?? null
  state.allowPlayerSuggestions = serverState.allowPlayerSuggestions ?? state.allowPlayerSuggestions
  state.suggestedQuestions = serverState.suggestedQuestions ?? state.suggestedQuestions
  state.mySuggestedQuestions = serverState.mySuggestedQuestions ?? state.mySuggestedQuestions
  state.questionPoolMode = serverState.questionPoolMode ?? state.questionPoolMode
  state.poolQuestions = serverState.poolQuestions ?? state.poolQuestions
  state.myPoolQuestions = serverState.myPoolQuestions ?? state.myPoolQuestions
  state.poolQuestionCount = serverState.poolQuestionCount ?? state.poolQuestionCount
  state.poolTotalQuestions = serverState.poolTotalQuestions ?? state.poolTotalQuestions
  state.currentPoolQuestionIndex = serverState.currentPoolQuestionIndex ?? state.currentPoolQuestionIndex
  state.allPlayersReady = serverState.allPlayersReady ?? state.allPlayersReady
  state.canStartGame = serverState.canStartGame ?? state.canStartGame
  state.guessFlowMode = serverState.guessFlowMode ?? state.guessFlowMode
  state.matchingBoard = serverState.matchingBoard ?? state.matchingBoard
  state.matchingAuthorIds = serverState.matchingAuthorIds ?? state.matchingAuthorIds
  state.myMatches = serverState.myMatches ?? state.myMatches
  state.matchingProgress = serverState.matchingProgress ?? state.matchingProgress
  state.matchingConfirmed = serverState.matchingConfirmed ?? state.matchingConfirmed
  if (state.matchingConfirmed) {
    state.matchingSelectedTokenId = null
  }
  state.hasSubmittedAnswer = state.answers.some((answer) => answer.playerId === state.currentPlayerId)

  if (serverState.askingPlayerId !== undefined && serverState.askingPlayerId !== state.askingPlayerId) {
    state.askingPlayerId = serverState.askingPlayerId
    state.askerOverlayConfirmed = false
  }

  if (serverState.language) {
    state.language = serverState.language
    setLanguage(serverState.language)
  }
  
  // Reset selected guess if transitioning to a new guessing phase or if current guess is no longer in the guesses array
  if (state.phase === 'guessing') {
    const playerGuessInRound = state.guesses.find((guess) => guess.guesserId === state.currentPlayerId)
    state.selectedGuessId = playerGuessInRound?.guessedId ?? null
    state.selectedGuessSlot = playerGuessInRound?.answerSlot ?? null
  } else {
    state.selectedGuessId = null
    state.selectedGuessSlot = null
  }

  if (state.role === 'host' && serverState.hostId) {
    state.currentPlayerId = serverState.hostId
  } else if (!state.currentPlayerId || !state.players.some((player) => player.id === state.currentPlayerId)) {
    const matchingName = state.playerName.trim().toLowerCase()
    const matchedPlayer = state.players.find((player) => player.name.toLowerCase() === matchingName)
    state.currentPlayerId = matchedPlayer?.id ?? state.players[0]?.id ?? state.currentPlayerId
  }

  const myPlayerObj = state.players.find((player) => player.id === state.currentPlayerId)
  state.isPlayerReady = Boolean(myPlayerObj?.ready)

  if (state.myPoolQuestions.length < 3) {
    state.poolMaxReadyConfirmationSent = false
  }

  if (state.myPoolQuestions.length >= 3 && !state.isPlayerReady && !state.poolMaxReadyConfirmationSent) {
    state.poolMaxReadyConfirmationSent = true
    confirmNoMoreQuestions(true)
  }

  const isCurrentAsker = state.hostIsPlayer && !state.questionPoolMode && state.currentPlayerId === state.askingPlayerId
  const previousScreen = state.screen

  if (state.phase === 'lobby') {
    state.screen = 'lobby'
  } else if (state.phase === 'asking') {
    state.screen = isCurrentAsker ? 'ask-question' : 'waiting-for-question'
  } else if (state.phase === 'answer-collection') {
    if (state.questionPoolMode) {
      state.screen = state.role === 'host' && !state.hostIsPlayer ? 'host-managing' : 'player-answering'
    } else {
      state.screen = state.hostIsPlayer
        ? (isCurrentAsker ? 'host-managing' : 'player-answering')
        : (state.role === 'host' ? 'host-managing' : 'player-answering')
    }
  } else if (state.phase === 'guessing') {
    if (state.questionPoolMode) {
      state.screen = state.role === 'host' && !state.hostIsPlayer ? 'host-managing' : 'player-guessing'
    } else {
      state.screen = state.hostIsPlayer
        ? (isCurrentAsker ? 'host-managing' : 'player-guessing')
        : (state.role === 'host' ? 'host-managing' : 'player-guessing')
    }
  } else if (state.phase === 'matching') {
    state.screen = 'matching-board'
  } else if (state.phase === 'round-end') {
    state.screen = 'round-end'
  } else if (state.phase === 'game-end') {
    state.screen = 'game-end'
  }

  // Only replay the celebration overlay/sound the first time we land on round-end, not on every
  // subsequent re-render caused by other players confirming next round.
  if (state.screen === 'round-end' && previousScreen !== 'round-end') {
    state.roundEndOverlayShown = false
    const resultPlayerIds = state.roundResults
      .map((result) => result.guesserId)
      .filter((playerId): playerId is string => Boolean(playerId))
    state.selectedAllAtOnceResultsPlayerId = resultPlayerIds.includes(state.currentPlayerId)
      ? state.currentPlayerId
      : resultPlayerIds[0] ?? null
  }

  // Only clear the tap-to-place selection when freshly entering the board, not on every broadcast from other players.
  if (state.screen === 'matching-board' && previousScreen !== 'matching-board') {
    state.matchingSelectedTokenId = null
  }

  renderApp()
  manageGuessCountdown()
  manageIntroCountdown()
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

// Recomputed locally from an absolute deadline timestamp shared by host and players, so the "get ready" animation stays in sync without extra broadcasts.
let introCountdownHandle: number | null = null

function stopIntroCountdown(): void {
  if (introCountdownHandle !== null) {
    window.clearInterval(introCountdownHandle)
    introCountdownHandle = null
  }
}

function tickIntroCountdown(): void {
  if (state.phase !== 'guessing' || !state.guessCountdownEndsAt) {
    stopIntroCountdown()
    return
  }

  const remainingMs = state.guessCountdownEndsAt - Date.now()
  const overlay = root.querySelector<HTMLElement>('[data-role="guess-intro-overlay"]')

  if (remainingMs <= 0) {
    overlay?.classList.add('fading')
    stopIntroCountdown()
    return
  }

  const secondsLeft = Math.ceil(remainingMs / 1000)
  const messageElement = root.querySelector<HTMLElement>('[data-role="guess-intro-message"]')
  const numberElement = root.querySelector<HTMLElement>('[data-role="guess-intro-number"]')

  if (messageElement && numberElement) {
    if (secondsLeft > 3) {
      messageElement.hidden = false
      numberElement.hidden = true
    } else {
      messageElement.hidden = true
      numberElement.hidden = false
      if (numberElement.textContent !== String(secondsLeft)) {
        numberElement.textContent = String(secondsLeft)
        numberElement.classList.remove('pop')
        // Force a reflow so the pop animation restarts for each new number.
        void numberElement.offsetWidth
        numberElement.classList.add('pop')
      }
    }
  }
}

function manageIntroCountdown(): void {
  if (state.phase === 'guessing' && state.guessCountdownEndsAt) {
    if (introCountdownHandle === null) {
      tickIntroCountdown()
      introCountdownHandle = window.setInterval(tickIntroCountdown, 200)
    }
    return
  }

  stopIntroCountdown()
}

function renderGuessIntroOverlay(): string {
  if (!state.guessCountdownEndsAt || state.guessCountdownEndsAt <= Date.now()) {
    return ''
  }

  return `
    <div class="guess-intro-overlay" data-role="guess-intro-overlay">
      <p class="guess-intro-message" data-role="guess-intro-message">${t('guessIntro.getReady')}</p>
      <p class="guess-intro-number pop" data-role="guess-intro-number" hidden></p>
    </div>
  `
}

function createRoomSession(name: string, language: LanguageCode, avatar: string, guessTimeoutSeconds: number, addSelfAsPlayer: boolean, allowPlayerSuggestions: boolean, questionPoolMode: boolean = false, guessFlowMode: GuessFlowMode = 'sequential'): void {
  const nextName = name.trim() || t('prompts.defaultHostName')
  state.playerName = nextName
  state.role = 'host'
  state.language = language
  state.myAvatar = avatar
  state.guessTimeoutSeconds = guessTimeoutSeconds
  state.addSelfAsPlayer = addSelfAsPlayer
  state.questionPoolMode = questionPoolMode
  state.guessFlowMode = guessFlowMode
  // Mutually exclusive with host-as-player or question pool mode:
  state.allowPlayerSuggestions = (addSelfAsPlayer || questionPoolMode) ? false : allowPlayerSuggestions
  setLanguage(language)
  shouldRestoreRoomSession = false
  clearStoredRoomSession()
  state.screen = 'lobby'

  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'create-room', name: nextName, roomCode: state.roomCode, language, avatar, guessTimeoutSeconds, addSelfAsPlayer, allowPlayerSuggestions: state.allowPlayerSuggestions, questionPoolMode, guessFlowMode }))
    return
  }

  queuedAction = () => {
    socket.send(JSON.stringify({ type: 'create-room', name: nextName, roomCode: state.roomCode, language, avatar, guessTimeoutSeconds, addSelfAsPlayer, allowPlayerSuggestions: state.allowPlayerSuggestions, questionPoolMode, guessFlowMode }))
  }

  renderApp()
}

async function openHostFlow(): Promise<void> {
  await refreshAccountSession()
  if (state.account) {
    await fetchMyQuestions()
  }
  state.screen = 'host-setup'
  renderApp()
}

async function refreshAccountSession(): Promise<void> {
  try {
    const response = await fetch(buildApiUrl('/auth/session'), { credentials: 'include' })
    const payload = await response.json()
    state.account = payload.user ?? null
  } catch {
    state.account = null
  }
}

function goToMembershipToUnlockGallery(): void {
  try {
    window.sessionStorage.setItem(postLoginScreenStorageKey, 'host-setup')
  } catch {
    // Login will still work without the return-screen redirect if storage is unavailable.
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

  if (state.questionPoolMode) {
    sendSocketMessage('start-round', {})
    return
  }

  const isAsker = state.hostIsPlayer ? state.currentPlayerId === state.askingPlayerId : state.role === 'host'

  if (isAsker) {
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

function submitQuestion(questionText: string): void {
  if (!state.roomCode) {
    return
  }

  const trimmed = questionText.trim()

  if (!trimmed) {
    window.alert(t('prompts.typeQuestionFirst'))
    return
  }

  if (trimmed.length < 8) {
    window.alert(t('prompts.questionTooShort'))
    return
  }

  sendSocketMessage('submit-question', { question: trimmed })
}

function submitPoolQuestion(text: string): void {
  if (!state.roomCode) {
    return
  }

  const trimmed = text.trim()
  if (trimmed.length < 8 || trimmed.length > 220) {
    window.alert(t('prompts.questionTooShort'))
    return
  }

  sendSocketMessage('submit-pool-question', { text: trimmed })
}

function deletePoolQuestion(questionId: string): void {
  sendSocketMessage('delete-pool-question', { questionId })
}

function discardPoolQuestion(questionId: string): void {
  sendSocketMessage('discard-pool-question', { questionId })
}

function confirmNoMoreQuestions(isReady: boolean = true): void {
  sendSocketMessage('confirm-no-more-questions', { isReady })
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

function submitSuggestion(text: string): void {
  if (!state.roomCode) {
    return
  }

  const trimmed = text.trim()

  if (trimmed.length < 8 || trimmed.length > 220) {
    window.alert(t('prompts.questionTooShort'))
    return
  }

  sendSocketMessage('suggest-question', { text: trimmed })
}

function withdrawSuggestion(suggestionId: string): void {
  sendSocketMessage('delete-suggestion', { suggestionId })
}

function dismissSuggestion(suggestionId: string): void {
  sendSocketMessage('dismiss-suggestion', { suggestionId })
}

function handleGuess(guessId: string, answerSlot?: 'A' | 'B'): void {
  if (!state.roomCode || !state.currentPlayerId) {
    return
  }

  const existingGuess = state.guesses.find((guess) => guess.guesserId === state.currentPlayerId)
  if (state.selectedGuessId || existingGuess) {
    window.alert(t('prompts.guessAlreadyLocked'))
    return
  }

  state.selectedGuessId = guessId
  state.selectedGuessSlot = answerSlot ?? null
  sendSocketMessage('guess', { playerId: state.currentPlayerId, targetPlayerId: guessId, answerSlot })
}

function lockAnswers(): void {
  if (!state.roomCode) {
    return
  }

  sendSocketMessage('lock-answers')
}

function placeMatchToken(slotId: string, guessedId: string): void {
  if (!state.roomCode || !slotId || !guessedId || state.matchingConfirmed) {
    return
  }

  if (state.myMatches.some((match) => match.slotId === slotId || match.guessedId === guessedId)) {
    return
  }

  const guessedPlayer = state.players.find((player) => player.id === guessedId)
  state.myMatches = [...state.myMatches, { slotId, guessedId, guessedName: guessedPlayer?.name ?? '' }]
  state.matchingSelectedTokenId = null
  sendSocketMessage('submit-match', { slotId, guessedId })
  renderApp()
}

function removeMatchToken(slotId: string): void {
  if (!state.roomCode || !slotId || state.matchingConfirmed) {
    return
  }

  state.matchingSelectedTokenId = null
  sendSocketMessage('remove-match', { slotId })
}

function forceCompleteMatching(): void {
  if (!state.roomCode) {
    return
  }

  sendSocketMessage('force-complete-matching')
}

function calculateScores(): void {
  if (!state.roomCode) {
    return
  }

  sendSocketMessage('calculate-score')
}

function confirmNextRound(): void {
  if (!state.roomCode) {
    return
  }

  sendSocketMessage('confirm-next-round')
}

function forceAdvanceRound(): void {
  if (!state.roomCode) {
    return
  }

  sendSocketMessage('force-advance-round')
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

function kickPlayer(playerId: string, playerName: string): void {
  if (!playerId || !window.confirm(t('prompts.confirmKickPlayer', { name: playerName }))) {
    return
  }

  sendSocketMessage('kick-player', { playerId })
}

function renderIdentityBanner(): string {
  const displayName = state.playerName || t('common.guest')
  const isHostAndPlayer = state.role === 'host' && state.hostIsPlayer
  const roleLabel = state.role === 'host' ? (isHostAndPlayer ? t('common.hostAndPlayer') : t('common.host')) : t('common.player')
  const guessFlowBadge = state.role === 'host'
    ? `<span class="identity-flow-badge">${state.guessFlowMode === 'allAtOnce' ? t('common.guessFlowAllAtOnce') : t('common.guessFlowSequential')}</span>`
    : ''
  const avatar = state.myAvatar || formatPlayerInitials(displayName)
  const authBadge = state.role === 'host'
    ? `<span class="identity-auth-badge" title="${state.account ? state.account.email : ''}">${state.account ? t('common.hostLoggedIn') : t('common.hostNotLoggedIn')}</span>`
    : ''

  return `
    <div class="identity-banner">
      <span class="avatar">${avatar}</span>
      <span class="identity-label">${t('common.playingAs')}</span>
      <strong>${displayName}</strong>
      <span class="identity-role ${isHostAndPlayer ? 'identity-role--host-player' : ''}">${roleLabel}</span>
      ${guessFlowBadge}
      ${authBadge}
      <span class="connection-status" data-role="connection-status" role="status" aria-live="polite" hidden></span>
      ${state.role === 'host'
        ? `<button class="ghost-button" type="button" data-role="toggle-manage-players">${t('common.managePlayers')}</button>`
        : ''}
      ${state.role === 'host'
        ? `<button class="quit-button" type="button" data-role="close-room">${t('common.closeRoom')}</button>`
        : `<button class="quit-button" type="button" data-role="quit-room">${t('common.quit')}</button>`}
    </div>
    ${state.role === 'host' && state.showManagePlayersPanel ? renderManagePlayersPanel() : ''}
  `
}

// Host-only roster with per-player kick buttons; excludes the host's own row in host-as-player rooms.
function renderManagePlayersPanel(): string {
  const kickablePlayers = state.players.filter((player) => player.id !== state.hostId)

  return `
    <div class="panel manage-players-panel">
      <div class="section-head">
        <h2>${t('common.managePlayers')}</h2>
      </div>
      ${kickablePlayers.length > 0
        ? `
          <div class="result-list">
            ${kickablePlayers
              .map(
                (player) => `
                  <div class="result-row">
                    <span>${formatPlayerAvatar(player)} ${player.name}${player.connected === false ? ` <small>(${t('common.playerDisconnectedBadge')})</small>` : ''}</span>
                    <button type="button" class="ghost-button" data-role="kick-player" data-player-id="${player.id}" data-player-name="${player.name}">${t('common.kickPlayer')}</button>
                  </div>
                `,
              )
              .join('')}
          </div>
          `
        : `<div class="result-row"><span>${t('lobby.hostModerationEmpty')}</span></div>`}
    </div>
  `
}



function appendAccountBadge(): void {
  if (!state.account) {
    return
  }

  root.querySelector('.shell')?.insertAdjacentHTML('beforeend', `
    <div class="account-badge">
      <span class="account-badge-label">${t('common.loggedInAs')}</span>
      <strong>${state.account.email}</strong>
      <button class="account-logout" type="button" data-role="logout">${t('common.logout')}</button>
    </div>
  `)

  root.querySelector<HTMLButtonElement>('[data-role="logout"]')?.addEventListener('click', async () => {
    try {
      const response = await fetch(buildApiUrl('/auth/logout'), {
        method: 'POST',
        credentials: 'include',
      })

      if (!response.ok) {
        throw new Error('Logout failed')
      }

      state.account = null
      renderApp()
    } catch {
      window.alert(t('common.logoutFailed'))
    }
  })
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

        ${!state.account
          ? `<button class="ghost-button" type="button" data-role="welcome-login-hint">${t('welcome.guestHostHint')}</button>`
          : ''}
      </section>
    </main>
  `

  root.querySelector('[data-role="create-room"]')?.addEventListener('click', () => {
    state.customQuestion = ''
    state.selectedAvatar = AVATAR_OPTIONS[0]
    void openHostFlow()
  })

  root.querySelector('[data-role="welcome-login-hint"]')?.addEventListener('click', () => {
    goToMembershipToUnlockGallery()
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

        ${!state.account
          ? `<button class="ghost-button" type="button" data-role="host-setup-login-hint">${t('hostSetup.guestHostHint')}</button>`
          : ''}

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
          <label class="checkbox-field">
            <input id="host-setup-add-self" type="checkbox" ${state.addSelfAsPlayer ? 'checked' : ''} />
            <span>${t('hostSetup.addSelfLabel')}</span>
          </label>
          <small class="field-hint">${t('hostSetup.addSelfHint')}</small>
          <label class="checkbox-field">
            <input id="host-setup-allow-suggestions" type="checkbox" ${state.allowPlayerSuggestions ? 'checked' : ''} ${state.addSelfAsPlayer || state.questionPoolMode ? 'disabled' : ''} />
            <span>${t('hostSetup.allowSuggestionsLabel')}</span>
          </label>
          <small class="field-hint">${t('hostSetup.allowSuggestionsHint')}</small>
          <label class="checkbox-field">
            <input id="host-setup-question-pool" type="checkbox" ${state.questionPoolMode ? 'checked' : ''} />
            <span>${t('hostSetup.questionPoolLabel')}</span>
          </label>
          <small class="field-hint">${t('hostSetup.questionPoolHint')}</small>
          <label>${t('hostSetup.guessFlowLabel')}</label>
          <div class="radio-group" role="radiogroup" aria-label="${t('hostSetup.guessFlowLabel')}">
            <label class="radio-field">
              <input type="radio" name="host-setup-guess-flow" value="sequential" ${state.guessFlowMode !== 'allAtOnce' ? 'checked' : ''} />
              <span>${t('hostSetup.guessFlowSequentialLabel')}</span>
            </label>
            <label class="radio-field">
              <input type="radio" name="host-setup-guess-flow" value="allAtOnce" ${state.guessFlowMode === 'allAtOnce' ? 'checked' : ''} />
              <span>${t('hostSetup.guessFlowAllAtOnceLabel')}</span>
            </label>
          </div>
          <small class="field-hint">${t('hostSetup.guessFlowHint')}</small>
          <button class="primary-button" type="submit">${t('hostSetup.submit')}</button>
        </form>

        ${state.account
          ? `
            <div class="my-gallery-panel">
              <div class="section-head">
                <h2>${t('myGallery.title')}</h2>
              </div>
              <form id="my-gallery-add-form" class="membership-form">
                <label for="my-gallery-text">${t('myGallery.questionTextLabel')}</label>
                <textarea id="my-gallery-text" rows="3" maxlength="220"></textarea>
                <p class="membership-error" data-role="my-gallery-error" aria-live="polite">${state.myGalleryError}</p>
                <button class="primary-button" type="submit">${t('myGallery.addButton')}</button>
              </form>
              <div class="result-list">
                ${state.privateQuestions.length > 0
                  ? state.privateQuestions
                      .map(
                        (question) => `
                          <div class="result-row">
                            <span>${question.text}</span>
                            <button class="ghost-button" type="button" data-role="my-gallery-delete-question" data-question-id="${question.id}">${t('myGallery.deleteButton')}</button>
                          </div>
                        `,
                      )
                      .join('')
                  : `<div class="result-row"><span>${t('myGallery.emptyState')}</span></div>`}
              </div>
            </div>
            `
          : ''}

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

  // Track the pick so a later re-render (e.g. picking an avatar) doesn't revert the radio to sequential.
  root.querySelectorAll<HTMLInputElement>('input[name="host-setup-guess-flow"]').forEach((radio) => {
    radio.addEventListener('change', (event) => {
      state.guessFlowMode = (event.target as HTMLInputElement).value as GuessFlowMode
    })
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

  root.querySelector('[data-role="host-setup-login-hint"]')?.addEventListener('click', () => {
    goToMembershipToUnlockGallery()
  })

  wireMyGalleryManagement()

  // Mutually exclusive: a rotating asker already writes their own question, and question pool has its own gathering phase.
  const addSelfCheckbox = root.querySelector<HTMLInputElement>('#host-setup-add-self')
  const allowSuggestionsCheckbox = root.querySelector<HTMLInputElement>('#host-setup-allow-suggestions')
  const questionPoolCheckbox = root.querySelector<HTMLInputElement>('#host-setup-question-pool')

  const updateCheckboxStates = () => {
    if ((addSelfCheckbox?.checked || questionPoolCheckbox?.checked) && allowSuggestionsCheckbox) {
      allowSuggestionsCheckbox.checked = false
      allowSuggestionsCheckbox.disabled = true
      state.allowPlayerSuggestions = false
    } else if (allowSuggestionsCheckbox) {
      allowSuggestionsCheckbox.disabled = false
    }
  }

  // Track every pick immediately so a later re-render (e.g. picking an avatar) doesn't silently revert it.
  addSelfCheckbox?.addEventListener('change', () => {
    state.addSelfAsPlayer = addSelfCheckbox.checked
    updateCheckboxStates()
  })
  questionPoolCheckbox?.addEventListener('change', () => {
    state.questionPoolMode = questionPoolCheckbox.checked
    updateCheckboxStates()
  })
  allowSuggestionsCheckbox?.addEventListener('change', () => {
    state.allowPlayerSuggestions = allowSuggestionsCheckbox.checked
  })

  root.querySelector<HTMLFormElement>('#host-setup-form')?.addEventListener('submit', (event) => {
    event.preventDefault()
    const name = root.querySelector<HTMLInputElement>('#host-setup-name')?.value ?? ''
    const language = (root.querySelector<HTMLSelectElement>('#host-setup-language')?.value ?? 'en') as LanguageCode
    const addSelfAsPlayer = root.querySelector<HTMLInputElement>('#host-setup-add-self')?.checked ?? false
    const allowPlayerSuggestions = root.querySelector<HTMLInputElement>('#host-setup-allow-suggestions')?.checked ?? false
    const questionPoolMode = root.querySelector<HTMLInputElement>('#host-setup-question-pool')?.checked ?? false
    const guessFlowMode = (root.querySelector<HTMLInputElement>('input[name="host-setup-guess-flow"]:checked')?.value ?? 'sequential') as GuessFlowMode
    createRoomSession(name, language, state.selectedAvatar, state.guessTimeoutSeconds, addSelfAsPlayer, allowPlayerSuggestions, questionPoolMode, guessFlowMode)
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
    try {
      window.sessionStorage.removeItem(postLoginScreenStorageKey)
    } catch {
      // Nothing else is required when browser storage is unavailable.
    }
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

  // Fetch the other language's groupIds too, so rows that already have a linked translation can hide the Translate button.
  const otherLanguage = Object.keys(languages).find((code) => code !== state.adminLanguageFilter) as LanguageCode | undefined
  if (!otherLanguage) {
    state.adminLinkedGroupIds = new Set()
    return
  }
  try {
    const response = await fetch(buildApiUrl(`/questions?language=${otherLanguage}`), { credentials: 'include' })
    const payload = await response.json()
    const otherQuestions = (payload.questions ?? []) as AdminGalleryQuestion[]
    state.adminLinkedGroupIds = new Set(otherQuestions.map((question) => question.translationGroupId))
  } catch {
    state.adminLinkedGroupIds = new Set()
  }
}

async function fetchMyQuestions(): Promise<void> {
  try {
    const response = await fetch(buildApiUrl(`/my-questions?language=${state.language}`), { credentials: 'include' })
    const payload = await response.json()
    state.privateQuestions = payload.questions ?? []
  } catch {
    state.privateQuestions = []
  }
}

async function saveQuestionToMyGallery(text: string): Promise<void> {
  const trimmed = text.trim()
  if (trimmed.length < 8 || trimmed.length > 220) {
    window.alert(t('prompts.questionTooShort'))
    return
  }

  try {
    const response = await fetch(buildApiUrl('/my-questions'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: state.language, text: trimmed }),
    })
    const payload = await response.json()
    if (!response.ok) {
      window.alert(payload.error || t('prompts.questionSaveFailed'))
      return
    }

    await fetchMyQuestions()
    window.alert(t('prompts.questionSavedToGallery'))
  } catch {
    window.alert(t('prompts.questionSaveFailed'))
  }
}

function wireMyGalleryManagement(): void {
  if (!state.account) {
    return
  }

  const addForm = root.querySelector<HTMLFormElement>('#my-gallery-add-form')
  const errorElement = root.querySelector<HTMLElement>('[data-role="my-gallery-error"]')

  addForm?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const text = root.querySelector<HTMLTextAreaElement>('#my-gallery-text')?.value.trim() ?? ''

    state.myGalleryError = ''
    try {
      const response = await fetch(buildApiUrl('/my-questions'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: state.language, text }),
      })
      const payload = await response.json()
      if (!response.ok) {
        state.myGalleryError = payload.error || t('myGallery.addButton')
        renderApp()
        return
      }

      await fetchMyQuestions()
      renderApp()
    } catch {
      if (errorElement) {
        errorElement.textContent = t('membership.serviceUnavailable')
      }
    }
  })

  root.querySelectorAll<HTMLButtonElement>('[data-role="my-gallery-delete-question"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const questionId = button.dataset.questionId ?? ''
      await fetch(buildApiUrl(`/my-questions/${questionId}`), { method: 'DELETE', credentials: 'include' })
      await fetchMyQuestions()
      renderApp()
    })
  })
}

async function openQuestionGallery(): Promise<void> {
  try {
    const response = await fetch(buildApiUrl(`/questions?language=${state.language}`))
    const payload = await response.json()
    state.galleryQuestions = payload.questions ?? []
  } catch {
    state.galleryQuestions = []
  }

  if (state.account) {
    await fetchMyQuestions()
  }

  state.showQuestionGallery = true
  renderApp()
}

function getFilteredGalleryEntries(): Array<{ id: string; text: string; isPrivate: boolean }> {
  const publicEntries = state.galleryQuestions.map((question) => ({ ...question, isPrivate: false }))
  const privateEntries = state.privateQuestions.map((question) => ({ ...question, isPrivate: true }))
  const combined = [...publicEntries, ...privateEntries]

  if (state.galleryFilter === 'public') {
    return combined.filter((entry) => !entry.isPrivate)
  }
  if (state.galleryFilter === 'private') {
    return combined.filter((entry) => entry.isPrivate)
  }
  return combined
}

function renderGalleryPanel(): string {
  const entries = getFilteredGalleryEntries()
  const showFilter = state.privateQuestions.length > 0

  return `
    <div class="result-list">
      <div class="section-head">
        <h2>${t('lobby.galleryTitle')}</h2>
        <button class="ghost-button" type="button" data-role="close-gallery">${t('lobby.galleryClose')}</button>
      </div>
      ${showFilter
        ? `
          <div class="gallery-filter-group" role="group">
            <button type="button" class="pill-button ${state.galleryFilter === 'all' ? 'active' : ''}" data-role="gallery-filter" data-filter="all">${t('lobby.galleryFilterAll')}</button>
            <button type="button" class="pill-button ${state.galleryFilter === 'public' ? 'active' : ''}" data-role="gallery-filter" data-filter="public">${t('lobby.galleryFilterPublic')}</button>
            <button type="button" class="pill-button ${state.galleryFilter === 'private' ? 'active' : ''}" data-role="gallery-filter" data-filter="private">${t('lobby.galleryFilterPrivate')}</button>
          </div>
          `
        : ''}
      ${entries.length > 0
        ? entries
            .map(
              (question) => `
                <button type="button" class="result-row" data-role="select-gallery-question" data-question-text="${question.text.replace(/"/g, '&quot;')}">
                  <span>${question.text}${question.isPrivate ? ` <span class="card-tag">${t('myGallery.privateBadge')}</span>` : ''}</span>
                  <strong>${t('lobby.gallerySelect')}</strong>
                </button>
              `,
            )
            .join('')
        : `<div class="result-row"><span>${t('lobby.galleryEmpty')}</span></div>`}
    </div>
  `
}

function wireGalleryPanel(onSelect: (text: string) => void): void {
  root.querySelector('[data-role="close-gallery"]')?.addEventListener('click', () => {
    state.showQuestionGallery = false
    renderApp()
  })

  root.querySelectorAll<HTMLButtonElement>('[data-role="gallery-filter"]').forEach((button) => {
    button.addEventListener('click', () => {
      state.galleryFilter = (button.dataset.filter as 'all' | 'public' | 'private') ?? 'all'
      renderApp()
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-role="select-gallery-question"]').forEach((button) => {
    button.addEventListener('click', () => {
      onSelect(button.dataset.questionText ?? '')
      state.showQuestionGallery = false
      renderApp()
    })
  })
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

function renderAdminQuestionRow(question: AdminGalleryQuestion): string {
  const hasLinked = state.adminLinkedGroupIds.has(question.translationGroupId)
  const isTranslating = state.adminTranslatingId === question.id

  return `
    <div class="result-row">
      <span>${question.text}</span>
      <div class="admin-question-actions">
        ${hasLinked
          ? `<span class="chip">${t('adminGallery.linkedBadge')}</span>`
          : `<button class="secondary-button" type="button" data-role="admin-translate-question" data-question-id="${question.id}">${t('adminGallery.translateButton')}</button>`}
        <button class="ghost-button" type="button" data-role="admin-delete-question" data-question-id="${question.id}" data-linked="${hasLinked}">${t('adminGallery.deleteButton')}</button>
      </div>
    </div>
    ${isTranslating ? renderAdminTranslationBox() : ''}
  `
}

function renderAdminTranslationBox(): string {
  if (state.adminTranslationLoading) {
    return `<div class="result-row admin-translation-box"><span>${t('adminGallery.translationLoading')}</span></div>`
  }

  const targetLabel = state.adminTranslationTarget ? t(`languages.${state.adminTranslationTarget}`) : ''
  return `
    <div class="result-row admin-translation-box">
      <div class="host-question-form" style="width: 100%;">
        <label>${t('adminGallery.translationPreviewTitle', { language: targetLabel })}</label>
        ${state.adminTranslationError ? `<p class="membership-error">${state.adminTranslationError}</p>` : ''}
        <textarea rows="3" maxlength="220" data-role="admin-translation-draft">${state.adminTranslationDraft}</textarea>
        <div class="host-question-actions">
          <button class="primary-button" type="button" data-role="admin-translation-save">${t('adminGallery.saveTranslation')}</button>
          <button class="ghost-button" type="button" data-role="admin-translation-cancel">${t('adminGallery.cancelTranslation')}</button>
        </div>
      </div>
    </div>
  `
}

function cancelAdminTranslate(): void {
  state.adminTranslatingId = ''
  state.adminTranslationTarget = ''
  state.adminTranslationDraft = ''
  state.adminTranslationError = ''
  state.adminTranslationLoading = false
}

async function startAdminTranslate(questionId: string): Promise<void> {
  state.adminTranslatingId = questionId
  state.adminTranslationDraft = ''
  state.adminTranslationError = ''
  state.adminTranslationLoading = true
  renderApp()

  try {
    const response = await fetch(buildApiUrl('/admin/questions/translate-preview'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: questionId }),
    })
    const payload = await response.json()
    if (!response.ok) {
      state.adminTranslationError = payload.error || t('adminGallery.translationNotConfiguredWarning')
      return
    }
    state.adminTranslationTarget = payload.targetLanguage as LanguageCode
    state.adminTranslationDraft = payload.translatedText ?? ''
  } catch {
    state.adminTranslationError = t('adminGallery.translationNotConfiguredWarning')
  } finally {
    state.adminTranslationLoading = false
    renderApp()
  }
}

async function saveAdminTranslation(): Promise<void> {
  const source = state.adminQuestions.find((question) => question.id === state.adminTranslatingId)
  const text = state.adminTranslationDraft.trim()
  if (!source || !state.adminTranslationTarget || text.length < 8) {
    state.adminTranslationError = t('prompts.questionTooShort')
    renderApp()
    return
  }

  try {
    const response = await fetch(buildApiUrl('/admin/questions'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: state.adminTranslationTarget, text, translationGroupId: source.translationGroupId }),
    })
    const payload = await response.json()
    if (!response.ok) {
      state.adminTranslationError = payload.error || t('adminGallery.translationNotConfiguredWarning')
      renderApp()
      return
    }
    cancelAdminTranslate()
    await fetchAdminQuestions()
    renderApp()
  } catch {
    state.adminTranslationError = t('adminGallery.translationNotConfiguredWarning')
    renderApp()
  }
}

async function deleteAdminQuestionAndMaybeLinked(questionId: string, hasLinked: boolean): Promise<void> {
  const source = state.adminQuestions.find((question) => question.id === questionId)
  await fetch(buildApiUrl(`/admin/questions/${questionId}`), { method: 'DELETE', credentials: 'include' })

  if (!hasLinked || !source) {
    return
  }

  const otherLanguage = Object.keys(languages).find((code) => code !== state.adminLanguageFilter) as LanguageCode | undefined
  if (!otherLanguage) {
    return
  }

  try {
    const response = await fetch(buildApiUrl(`/questions?language=${otherLanguage}`), { credentials: 'include' })
    const payload = await response.json()
    const otherQuestions = (payload.questions ?? []) as AdminGalleryQuestion[]
    const linked = otherQuestions.find((question) => question.translationGroupId === source.translationGroupId)
    if (linked) {
      await fetch(buildApiUrl(`/admin/questions/${linked.id}`), { method: 'DELETE', credentials: 'include' })
    }
  } catch {
    // Best-effort cleanup; the source question is already deleted regardless.
  }
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
                .map((question) => renderAdminQuestionRow(question))
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
    cancelAdminTranslate()
    void fetchAdminQuestions().then(renderApp)
  })

  root.querySelectorAll<HTMLButtonElement>('[data-role="admin-delete-question"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const questionId = button.dataset.questionId ?? ''
      const hasLinked = button.dataset.linked === 'true'
      if (hasLinked && !window.confirm(t('adminGallery.deleteLinkedPrompt'))) {
        return
      }
      await deleteAdminQuestionAndMaybeLinked(questionId, hasLinked)
      await fetchAdminQuestions()
      renderApp()
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-role="admin-translate-question"]').forEach((button) => {
    button.addEventListener('click', () => {
      void startAdminTranslate(button.dataset.questionId ?? '')
    })
  })

  root.querySelector('[data-role="admin-translation-cancel"]')?.addEventListener('click', () => {
    cancelAdminTranslate()
    renderApp()
  })

  root.querySelector<HTMLTextAreaElement>('[data-role="admin-translation-draft"]')?.addEventListener('input', (event) => {
    state.adminTranslationDraft = (event.target as HTMLTextAreaElement).value
  })

  root.querySelector('[data-role="admin-translation-save"]')?.addEventListener('click', () => {
    void saveAdminTranslation()
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

// Host-only view of what players have suggested; used from the asker's lobby/ask-question panels.
function renderSuggestionsPanel(): string {
  return `
    <div class="result-list suggestions-panel">
      <div class="section-head">
        <h2>${t('lobby.suggestionsTitle')}</h2>
      </div>
      ${state.suggestedQuestions.length > 0
        ? state.suggestedQuestions
            .map(
              (suggestion) => `
                <div class="result-row suggestion-row">
                  <span>${suggestion.text} <small>— ${suggestion.playerName}</small></span>
                  <div class="suggestion-actions">
                    <button type="button" class="secondary-button" data-role="use-suggestion" data-question-text="${suggestion.text.replace(/"/g, '&quot;')}">${t('lobby.useSuggestion')}</button>
                    <button type="button" class="ghost-button" data-role="dismiss-suggestion" data-suggestion-id="${suggestion.id}">${t('lobby.dismissSuggestion')}</button>
                  </div>
                </div>
              `,
            )
            .join('')
        : `<div class="result-row"><span>${t('lobby.suggestionsEmpty')}</span></div>`}
    </div>
  `
}

// Player-facing input for suggesting a question, plus their own pending list; used across lobby/round-end/game-end.
function renderSuggestQuestionPanel(): string {
  return `
    <section class="panel suggest-question-panel">
      <div class="section-head">
        <h2>${t('lobby.suggestQuestionLabel')}</h2>
      </div>
      <form id="suggest-question-form" class="host-question-form">
        <textarea id="suggest-question-input" rows="2" maxlength="220" placeholder="${t('lobby.suggestQuestionPlaceholder')}">${state.suggestionDraft}</textarea>
        <div class="host-question-actions">
          <button class="primary-button" type="submit">${t('lobby.submitSuggestion')}</button>
        </div>
      </form>

      ${state.mySuggestedQuestions.length > 0
        ? `
          <div class="result-list">
            <div class="section-head">
              <h2>${t('lobby.mySuggestions')}</h2>
            </div>
            ${state.mySuggestedQuestions
              .map(
                (suggestion) => `
                  <div class="result-row suggestion-row">
                    <span>${suggestion.text}</span>
                    <button type="button" class="ghost-button" data-role="withdraw-suggestion" data-suggestion-id="${suggestion.id}">${t('lobby.withdrawSuggestion')}</button>
                  </div>
                `,
              )
              .join('')}
          </div>
          `
        : ''}
    </section>
  `
}

// Shared wiring for the suggestion panels rendered on lobby/round-end/game-end screens.
function wireSuggestionPanels(): void {
  root.querySelectorAll<HTMLButtonElement>('[data-role="use-suggestion"]').forEach((button) => {
    button.addEventListener('click', () => {
      state.customQuestion = button.dataset.questionText ?? ''
      renderApp()
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-role="dismiss-suggestion"]').forEach((button) => {
    button.addEventListener('click', () => {
      dismissSuggestion(button.dataset.suggestionId ?? '')
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-role="withdraw-suggestion"]').forEach((button) => {
    button.addEventListener('click', () => {
      withdrawSuggestion(button.dataset.suggestionId ?? '')
    })
  })

  const suggestForm = root.querySelector<HTMLFormElement>('#suggest-question-form')
  suggestForm?.addEventListener('submit', (event) => {
    event.preventDefault()
    const textarea = root.querySelector<HTMLTextAreaElement>('#suggest-question-input')
    const value = textarea?.value ?? ''
    submitSuggestion(value)
    state.suggestionDraft = ''
    renderApp()
  })
}

function renderQuestionPoolGatheringPanel(): string {
  const myCount = state.myPoolQuestions.length
  const isMaxReached = myCount >= 3

  if (isMaxReached && !state.isPlayerReady && !state.poolMaxReadyConfirmationSent) {
    state.poolMaxReadyConfirmationSent = true
    state.isPlayerReady = true
    queueMicrotask(() => confirmNoMoreQuestions(true))
  }

  const isReady = state.isPlayerReady

  return `
    <section class="panel question-pool-panel">
      <div class="section-head">
        <h2>${t('lobby.questionPoolTitle')}</h2>
        <span class="chip">${t('lobby.questionCountBadge', { count: state.poolQuestionCount })}</span>
      </div>
      <p class="subtitle">${t('lobby.questionPoolSubtitle')}</p>

      ${!isReady && !isMaxReached
        ? `
          <form id="pool-question-form" class="host-question-form" style="margin-top: 14px;">
            <label for="pool-question-input">${t('lobby.poolQuestionLabel', { count: myCount })}</label>
            <textarea id="pool-question-input" rows="2" maxlength="220" placeholder="${t('lobby.poolQuestionPlaceholder')}">${state.poolQuestionDraft}</textarea>
            <div class="host-question-actions">
              <button class="primary-button" type="submit">${t('lobby.submitPoolQuestion')}</button>
            </div>
          </form>
        `
        : isMaxReached && !isReady
          ? `<p class="field-hint" style="margin-top: 10px;">${t('lobby.maxQuestionsReached')}</p>`
          : ''}

      ${state.myPoolQuestions.length > 0
        ? `
          <div class="result-list" style="margin-top: 14px;">
            <div class="section-head">
              <h2>${t('lobby.myPoolQuestionsTitle')}</h2>
            </div>
            ${state.myPoolQuestions
              .map(
                (q) => `
                  <div class="result-row">
                    <span>${q.text}</span>
                    ${!isReady ? `<button type="button" class="ghost-button" data-role="delete-pool-question" data-question-id="${q.id}">${t('lobby.deleteQuestion')}</button>` : ''}
                  </div>
                `,
              )
              .join('')}
          </div>
        `
        : ''}

      <div class="pool-ready-box" style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px; padding: 14px; background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border); border-radius: 12px;">
        <div>
          <span>${isReady ? `✅ ${t('lobby.readyConfirmed')}` : `✍️ ${t('lobby.notReadyYet')}`}</span>
        </div>
        ${isReady
          ? `<button type="button" class="ghost-button" data-role="toggle-pool-ready" data-ready="false">${t('lobby.changeQuestions')}</button>`
          : `<button type="button" class="primary-button" data-role="toggle-pool-ready" data-ready="true">${t('lobby.noMoreQuestionsButton')}</button>`}
      </div>
    </section>
  `
}

function renderHostQuestionModerationPanel(): string {
  return `
    <section class="panel host-moderation-panel">
      <div class="section-head">
        <h2>${t('lobby.hostModerationTitle')}</h2>
        <span class="chip">${t('lobby.questionCountBadge', { count: state.poolQuestionCount })}</span>
      </div>
      <p class="subtitle">${t('lobby.hostModerationSubtitle')}</p>

      <div class="result-list" style="margin-top: 14px;">
        ${state.poolQuestions.length > 0
          ? state.poolQuestions
              .map(
                (q) => `
                  <div class="result-row">
                    <div>
                      <span>${q.text}</span>
                      <small style="display: block; color: var(--muted); margin-top: 2px;">— ${q.playerName}</small>
                    </div>
                    <button type="button" class="ghost-button" data-role="discard-pool-question" data-question-id="${q.id}">${t('lobby.discardQuestion')}</button>
                  </div>
                `,
              )
              .join('')
          : `<div class="result-row"><span>${t('lobby.hostModerationEmpty')}</span></div>`}
      </div>
    </section>
  `
}

function wireQuestionPoolPanels(): void {
  const poolForm = root.querySelector<HTMLFormElement>('#pool-question-form')
  poolForm?.addEventListener('submit', (event) => {
    event.preventDefault()
    const textarea = root.querySelector<HTMLTextAreaElement>('#pool-question-input')
    const value = textarea?.value?.trim() ?? ''
    if (value.length < 8) {
      window.alert(t('prompts.questionTooShort'))
      return
    }
    submitPoolQuestion(value)
    state.poolQuestionDraft = ''
    renderApp()
  })

  root.querySelectorAll<HTMLButtonElement>('[data-role="delete-pool-question"]').forEach((button) => {
    button.addEventListener('click', () => {
      deletePoolQuestion(button.dataset.questionId ?? '')
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-role="discard-pool-question"]').forEach((button) => {
    button.addEventListener('click', () => {
      discardPoolQuestion(button.dataset.questionId ?? '')
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-role="toggle-pool-ready"]').forEach((button) => {
    button.addEventListener('click', () => {
      const isReady = button.dataset.ready === 'true'
      confirmNoMoreQuestions(isReady)
    })
  })
}

// Collapsed by default; open state is tracked so it survives the full re-render renderLobby() triggers on every update.
function renderRulesPanel(heading: string, rules: string[]): string {
  return `
    <section class="panel">
      <details class="rules-panel" ${state.rulesPanelOpen ? 'open' : ''}>
        <summary class="rules-summary">
          <h2>${heading}</h2>
          <span class="rules-chevron">▸</span>
        </summary>
        <div class="rules-list">
          ${rules.map((rule, index) => `<div class="rule-item"><strong>${index + 1}.</strong><span>${rule}</span></div>`).join('')}
        </div>
      </details>
    </section>
  `
}

function renderLobby(): void {
  const leaderboard = [...state.players].sort((a, b) => b.score - a.score)
  const hostQuestionIsValid = state.customQuestion.trim().length >= 8
  const isAsker = state.hostIsPlayer ? state.currentPlayerId === state.askingPlayerId : state.role === 'host'
  const ruleKeyPrefix = state.role === 'host' && !state.hostIsPlayer ? 'host' : 'player'

  const canStartRound = state.questionPoolMode
    ? Boolean(state.canStartGame)
    : (isAsker ? hostQuestionIsValid : false)

  root.innerHTML = `
    <main class="shell">
      ${renderIdentityBanner()}
      <section class="panel hero-panel">
        <div class="hero-copy">
          <p class="eyebrow">${isAsker ? t('lobby.hostView') : t('lobby.playerView')}</p>
          <h1>${isAsker ? t('lobby.roomReady') : t('lobby.waitingInRoom')}</h1>
          <p class="subtitle">${t('lobby.roomCodeLine', { code: state.roomCode })}</p>
        </div>

        <div class="room-card">
          <span class="chip">${t('lobby.roomCodeChip')}</span>
          <strong>${state.roomCode}</strong>
          ${state.role === 'host' || (!state.questionPoolMode && isAsker)
            ? `
              <button class="primary-button start-round-button" type="button" data-role="start-round" ${canStartRound ? '' : 'disabled'}>${t('lobby.startRound')}</button>
              ${state.questionPoolMode
                ? (state.poolQuestionCount < 1
                    ? `<small class="field-hint" style="color: #f87171;">${t('lobby.needAtLeastOneQuestion')}</small>`
                    : (!state.allPlayersReady
                        ? `<small class="field-hint">${t('lobby.waitingForPlayersReady', { ready: state.players.filter((p) => p.ready).length, total: state.players.length })}</small>`
                        : `<small class="field-hint" style="color: #4ade80;">${t('lobby.readyToStart')}</small>`))
                : ''}
            `
            : `<div class="chip waiting-for-host">${state.questionPoolMode ? (state.allPlayersReady ? t('lobby.waitingForHost') : t('lobby.waitingForPlayersReady', { ready: state.players.filter((p) => p.ready).length, total: state.players.length })) : t('lobby.waitingForHost')}</div>`}
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
                  <div style="display: flex; flex-direction: column; gap: 2px;">
                    <span>${player.name}</span>
                    ${state.questionPoolMode
                      ? `<small style="font-size: 11px; color: ${player.ready ? '#4ade80' : 'var(--muted)'};">${player.ready ? `✅ ${t('lobby.playerReadyBadge')}` : `✍️ ${t('lobby.playerNotReadyBadge')}`} (${player.poolQuestionCount || 0}/3)</small>`
                      : ''}
                  </div>
                </div>
              `,
            )
            .join('')}
        </div>
      </section>

      ${state.questionPoolMode
        ? `
          ${state.role === 'host' ? renderHostQuestionModerationPanel() : ''}
          ${state.role !== 'host' || state.hostIsPlayer ? renderQuestionPoolGatheringPanel() : ''}

          ${renderRulesPanel(t('lobby.roomRules'), [
            state.role === 'host' ? t('lobby.poolRulesHost') : t('lobby.poolRulesPlayer'),
            t('lobby.playerRule2'),
            t('lobby.playerRule3'),
            t('lobby.playerRule4'),
          ])}
        `
        : isAsker
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
                  ${state.account ? `<button class="ghost-button" type="button" data-role="save-to-gallery">${t('lobby.saveToGallery')}</button>` : ''}
                </div>
              </form>

              ${state.showQuestionGallery ? renderGalleryPanel() : ''}

              ${state.allowPlayerSuggestions ? renderSuggestionsPanel() : ''}
            </section>

            ${renderRulesPanel(t('lobby.roomRules'), [
              t(`lobby.${ruleKeyPrefix}Rule1`),
              t(`lobby.${ruleKeyPrefix}Rule2`),
              t(`lobby.${ruleKeyPrefix}Rule3`),
              t(`lobby.${ruleKeyPrefix}Rule4`),
            ])}
            `
          : `
            ${renderRulesPanel(t('lobby.roomRules'), [
              t('lobby.playerRule1'),
              t('lobby.playerRule2'),
              t('lobby.playerRule3'),
              t('lobby.playerRule4'),
            ])}
            ${state.allowPlayerSuggestions && state.role === 'player' ? renderSuggestQuestionPanel() : ''}
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

  root.querySelectorAll<HTMLDetailsElement>('details.rules-panel').forEach((details) => {
    details.addEventListener('toggle', () => {
      state.rulesPanelOpen = details.open
    })
  })

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

  root.querySelector('[data-role="save-to-gallery"]')?.addEventListener('click', () => {
    void saveQuestionToMyGallery(root.querySelector<HTMLTextAreaElement>('#host-question')?.value ?? '')
  })

  wireGalleryPanel((text) => {
    state.customQuestion = text
  })

  wireSuggestionPanels()
  wireQuestionPoolPanels()
}

// Shows rotating asker in host-as-player rooms, or question progress in questionPoolMode.
function renderQuestionAskerTag(): string {
  if (state.questionPoolMode) {
    const total = state.poolTotalQuestions || state.poolQuestionCount || 1
    const current = Math.min(state.currentPoolQuestionIndex + 1, total)
    return `<p class="asker-tag">${t('game.questionProgress', { current, total })}</p>`
  }

  if (!state.hostIsPlayer) {
    return ''
  }

  const asker = state.players.find((player) => player.id === state.askingPlayerId)
  if (!asker) {
    return ''
  }

  return `<p class="asker-tag">${t('askQuestion.askedBy', { name: `${formatPlayerAvatar(asker)} ${asker.name}` })}</p>`
}

function renderAskQuestion(): void {
  if (!state.askerOverlayConfirmed) {
    root.innerHTML = `
      <main class="shell">
        ${renderIdentityBanner()}
        <div class="asker-overlay" data-role="asker-overlay">
          <section class="panel asker-overlay-panel">
            <p class="eyebrow">${t('askQuestion.overlayEyebrow')}</p>
            <h1>${t('askQuestion.overlayTitle')}</h1>
            <button class="primary-button" type="button" data-role="confirm-asker">${t('askQuestion.overlayConfirm')}</button>
          </section>
        </div>
      </main>
    `

    root.querySelector('[data-role="confirm-asker"]')?.addEventListener('click', () => {
      state.askerOverlayConfirmed = true
      renderApp()
    })
    return
  }

  root.innerHTML = `
    <main class="shell">
      ${renderIdentityBanner()}
      <section class="panel">
        <div class="section-head">
          <h2>${t('askQuestion.title')}</h2>
        </div>

        <form id="ask-question-form" class="host-question-form">
          <label for="ask-question-input">${t('lobby.questionLabel')}</label>
          <textarea id="ask-question-input" rows="3" maxlength="220" placeholder="${t('lobby.questionPlaceholder')}">${state.askQuestionDraft}</textarea>
          <div class="host-question-actions">
            <button class="primary-button" type="submit">${t('askQuestion.submit')}</button>
            <button class="ghost-button" type="button" data-role="browse-gallery">${t('lobby.browseGallery')}</button>
            ${state.account ? `<button class="ghost-button" type="button" data-role="save-to-gallery">${t('lobby.saveToGallery')}</button>` : ''}
          </div>
        </form>

        ${state.showQuestionGallery ? renderGalleryPanel() : ''}
      </section>
    </main>
  `

  const askQuestionForm = root.querySelector<HTMLFormElement>('#ask-question-form')
  askQuestionForm?.addEventListener('submit', (event) => {
    event.preventDefault()
    const textarea = root.querySelector<HTMLTextAreaElement>('#ask-question-input')
    submitQuestion(textarea?.value ?? '')
  })

  root.querySelector('[data-role="browse-gallery"]')?.addEventListener('click', () => {
    state.askQuestionDraft = root.querySelector<HTMLTextAreaElement>('#ask-question-input')?.value ?? state.askQuestionDraft
    void openQuestionGallery()
  })

  root.querySelector('[data-role="save-to-gallery"]')?.addEventListener('click', () => {
    void saveQuestionToMyGallery(root.querySelector<HTMLTextAreaElement>('#ask-question-input')?.value ?? '')
  })

  wireGalleryPanel((text) => {
    state.askQuestionDraft = text
  })
}

function renderWaitingForQuestion(): void {
  const asker = state.players.find((player) => player.id === state.askingPlayerId)
  const askerName = asker ? `${formatPlayerAvatar(asker)} ${asker.name}` : t('common.player')

  root.innerHTML = `
    <main class="shell">
      ${renderIdentityBanner()}
      <section class="panel summary-panel">
        <p class="eyebrow">${t('waitingForQuestion.eyebrow')}</p>
        <h1>${t('waitingForQuestion.message', { name: askerName })}</h1>
      </section>

      <section class="panel">
        <div class="section-head">
          <h2>${t('lobby.leaderboard')}</h2>
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
}

function renderHostManaging(): void {
  const visiblePlayers = state.players.filter((player) => player.id !== state.currentPlayerId)
  const guessMap = new Map(state.guesses.map((guess) => [guess.guesserId, guess]))
  // In host-as-player rooms without questionPoolMode, the current asker controls the round. In questionPoolMode, host controls.
  const canControlRound = state.questionPoolMode ? state.role === 'host' : (state.hostIsPlayer ? state.currentPlayerId === state.askingPlayerId : state.role === 'host')

  root.innerHTML = `
    <main class="shell">
      ${renderIdentityBanner()}
      <section class="panel round-panel">
        ${state.phase === 'guessing' ? renderGuessIntroOverlay() : ''}
        <div class="round-header">
          <div>
            <p class="eyebrow">${t('hostManaging.round', { number: state.answerRoundNumber })}</p>
            <h1>${state.question}</h1>
            ${renderQuestionAskerTag()}
          </div>
          ${state.phase === 'answer-collection' ? `<div class="timer-box">${t('hostManaging.answerCollection')}</div>` : renderGuessTimerBox(t('hostManaging.guessingPhase'))}
        </div>

        <div class="answer-reveal">
          <span>${state.phase === 'answer-collection' ? t('hostManaging.hiddenAnswer') : state.finalMatchup ? t('finalMatchup.eyebrow') : t('hostManaging.randomAnswer')}</span>
          <strong>${state.phase === 'answer-collection' ? t('hostManaging.waitingForReveal') : state.finalMatchup ? t('finalMatchup.matchThem') : state.selectedAnswer}</strong>
        </div>

        ${state.phase === 'answer-collection'
          ? `
            <div class="turn-box">
              <p>${t('hostManaging.answerCollection')}</p>
              <h2>${t('hostManaging.submittedCount', { count: state.answers.length })}</h2>
            </div>
            ${canControlRound ? `<button class="primary-button" type="button" data-role="lock-answers" ${state.answers.length >= 3 ? '' : 'disabled'}>${t('hostManaging.startGuessing')}</button>` : ''}
            `
          : state.finalMatchup
            ? `
              <div class="turn-box">
                <p>${t('finalMatchup.currentTurn')}</p>
                <h2>${t('finalMatchup.matchThem')}</h2>
              </div>

              ${state.finalMatchup.answers.map((answer) => `<div class="mini-card"><span>${t('finalMatchup.answerLabel', { slot: answer.slot })}</span><strong>"${answer.text}"</strong></div>`).join('')}

              <div class="guess-status-list">
                ${visiblePlayers
                  .filter((player) => !state.finalMatchup!.authorIds.includes(player.id))
                  .map((player) => {
                    const guess = guessMap.get(player.id)
                    return `
                      <div class="guess-status-row ${guess ? 'done' : 'waiting'}">
                        <span>${formatPlayerAvatar(player)} ${player.name}</span>
                        <strong>${guess ? t('finalMatchup.guessedLabel', { name: guess.guessedName, slot: guess.answerSlot ?? '' }) : t('hostManaging.notGuessedYet')}</strong>
                      </div>
                    `
                  })
                  .join('')}
              </div>
              ${canControlRound ? `<div class="host-actions-row"><button class="primary-button" type="button" data-role="calculate-score">${t('hostManaging.stopTimer')}</button></div>` : ''}
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
            ${canControlRound ? `<div class="host-actions-row"><button class="primary-button" type="button" data-role="calculate-score">${t('hostManaging.stopTimer')}</button></div>` : ''}
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
  const displayedQuestion = state.questionPoolMode && state.questionAuthorName
    ? t('playerAnswering.questionBy', { name: state.questionAuthorName, question: state.question })
    : state.question
  // In host-as-player rooms without questionPoolMode, the current asker controls the round. In questionPoolMode, host controls.
  const canControlRound = state.questionPoolMode ? state.role === 'host' : (state.hostIsPlayer ? state.currentPlayerId === state.askingPlayerId : state.role === 'host')

  const submittedPlayerIds = new Set(state.answers.map((entry) => entry.playerId))
  const remainingPlayers = state.players.filter((player) => {
    if (!state.questionPoolMode && state.askingPlayerId && player.id === state.askingPlayerId) {
      return false
    }
    return !submittedPlayerIds.has(player.id)
  })

  const remainingPlayersText = remainingPlayers
    .map((player) => `${formatPlayerAvatar(player)} ${player.name}`)
    .join(', ')

  const waitingMessage = remainingPlayers.length > 0
    ? t('playerAnswering.waitingForPlayers', { players: remainingPlayersText })
    : t('playerAnswering.allAnswersReady')

  root.innerHTML = `
    <main class="shell">
      ${renderIdentityBanner()}
      <section class="panel player-answer-panel">
        <p class="eyebrow">${t('hostManaging.round', { number: state.answerRoundNumber })}</p>
        <h1>${displayedQuestion}</h1>
        ${renderQuestionAskerTag()}

        ${alreadySubmitted
          ? `
            <div class="mini-card">
              <span>${t('playerAnswering.thanksSubmitted')}</span>
              <strong>${waitingMessage}</strong>
            </div>
          `
          : `
            <div class="answer-box">
              <label for="player-answer">${t('playerAnswering.writeAnswer')}</label>
              <textarea id="player-answer" rows="4" placeholder="${t('playerAnswering.answerPlaceholder')}"></textarea>
            </div>

            <button class="primary-button" type="button" data-role="submit-answer">${t('playerAnswering.submitAnswer')}</button>
          `}

        ${canControlRound
          ? `<div class="host-actions-row"><button class="primary-button" type="button" data-role="lock-answers" ${state.answers.length >= 3 ? '' : 'disabled'}>${t('hostManaging.startGuessing')}</button></div>`
          : ''}
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

  root.querySelector<HTMLButtonElement>('[data-role="lock-answers"]')?.addEventListener('click', () => {
    lockAnswers()
  })
}

function renderFinalMatchupGuessing(): void {
  const matchup = state.finalMatchup
  if (!matchup) {
    return
  }

  // In host-as-player rooms without questionPoolMode, the current asker controls the round. In questionPoolMode, host controls.
  const canControlRound = state.questionPoolMode ? state.role === 'host' : (state.hostIsPlayer ? state.currentPlayerId === state.askingPlayerId : state.role === 'host')
  // Both remaining authors already know the true pairing, so they sit this round out.
  const isExcludedAuthor = matchup.authorIds.includes(state.currentPlayerId)
  const authors = matchup.authorIds
    .map((id) => state.players.find((player) => player.id === id))
    .filter((player): player is Player => Boolean(player))
  const selectedGuessId = state.selectedGuessId
  const selectedSlot = state.selectedGuessSlot
  const guessIsLocked = Boolean(selectedGuessId)
  const currentPlayer = getCurrentPlayer()
  const currentPlayerRank = getCurrentPlayerRank()
  const placementLabel = currentPlayerRank === 1 ? t('playerGuessing.place1') : currentPlayerRank === 2 ? t('playerGuessing.place2') : currentPlayerRank === 3 ? t('playerGuessing.place3') : null

  root.innerHTML = `
    <main class="shell">
      ${renderIdentityBanner()}
      <section class="panel round-panel">
        ${renderGuessIntroOverlay()}
        <div class="round-header">
          <div>
            <p class="eyebrow">${t('finalMatchup.eyebrow')}</p>
            <h1>${state.question}</h1>
            ${renderQuestionAskerTag()}
          </div>
          ${renderGuessTimerBox(t('playerGuessing.guessingPhase'))}
        </div>

        <div class="turn-box">
          <p>${t('finalMatchup.currentTurn')}</p>
          <h2>${t('finalMatchup.matchThem')}</h2>
        </div>

        ${isExcludedAuthor
          ? `<div class="mini-card"><span>${t('finalMatchup.youAlreadyKnow')}</span></div>`
          : matchup.answers
              .map(
                (answer) => `
                  <div class="mini-card">
                    <span>${t('finalMatchup.answerLabel', { slot: answer.slot })}</span>
                    <strong>"${answer.text}"</strong>
                  </div>
                  <div class="guess-grid">
                    ${authors
                      .map(
                        (author) => `
                          <button type="button" class="guess-card ${selectedSlot === answer.slot && selectedGuessId === author.id ? 'selected' : ''} ${guessIsLocked ? 'locked' : ''}" data-guess-id="${author.id}" data-answer-slot="${answer.slot}">
                            <span>${formatPlayerAvatar(author)} ${author.name}</span>
                            <small>${t('finalMatchup.guessThisPerson')}</small>
                          </button>
                        `,
                      )
                      .join('')}
                  </div>
                `,
              )
              .join('')}

        <div class="guess-score-status">
          <div>
            <span>${t('playerGuessing.yourScore')}</span>
            <strong>${currentPlayer ? formatScore(currentPlayer.score) : t('playerGuessing.scoreLoading')}</strong>
          </div>
          ${placementLabel ? `<span class="score-placement rank-${currentPlayerRank}">${placementLabel}</span>` : ''}
        </div>

        ${canControlRound
          ? `<div class="host-actions-row"><button class="primary-button" type="button" data-role="calculate-score">${t('hostManaging.stopTimer')}</button></div>`
          : ''}
      </section>
    </main>
  `

  root.querySelectorAll<HTMLButtonElement>('[data-guess-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const guessId = button.dataset.guessId ?? ''
      const answerSlot = button.dataset.answerSlot as 'A' | 'B'
      handleGuess(guessId, answerSlot)
      renderApp()
    })
  })

  root.querySelector<HTMLButtonElement>('[data-role="calculate-score"]')?.addEventListener('click', () => {
    calculateScores()
  })
}

function renderPlayerGuessing(): void {
  if (state.finalMatchup) {
    renderFinalMatchupGuessing()
    return
  }

  // In host-as-player rooms without questionPoolMode, the current asker controls the round. In questionPoolMode, host controls.
  const canControlRound = state.questionPoolMode ? state.role === 'host' : (state.hostIsPlayer ? state.currentPlayerId === state.askingPlayerId : state.role === 'host')
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
        ${renderGuessIntroOverlay()}
        <div class="round-header">
          <div>
            <p class="eyebrow">${t('hostManaging.round', { number: state.answerRoundNumber })}</p>
            <h1>${state.question}</h1>
            ${renderQuestionAskerTag()}
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

        ${canControlRound
          ? `<div class="host-actions-row"><button class="primary-button" type="button" data-role="calculate-score">${t('hostManaging.stopTimer')}</button></div>`
          : ''}
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

  root.querySelector<HTMLButtonElement>('[data-role="calculate-score"]')?.addEventListener('click', () => {
    calculateScores()
  })
}

// Drag/tap state for the all-at-once matching board - module scope since it spans multiple pointer events across re-renders.
let matchingDragGhost: HTMLElement | null = null
let matchingDragState: { tokenId: string; startX: number; startY: number; moved: boolean; pointerId: number } | null = null

function renderMatchingBoard(): void {
  const myUsedTokenIds = new Set(state.myMatches.map((match) => match.guessedId))
  const canEditMatches = state.matchingProgress.some((entry) => entry.playerId === state.currentPlayerId) && !state.matchingConfirmed
  const isDoneGuessing = state.matchingConfirmed
  const availableTokens = state.matchingAuthorIds
    .map((id) => state.players.find((player) => player.id === id))
    .filter((player): player is Player => Boolean(player) && !myUsedTokenIds.has(player!.id) && canEditMatches)

  root.innerHTML = `
    <main class="shell">
      ${renderIdentityBanner()}
      <section class="panel round-panel">
        <div class="round-header">
          <div>
            <p class="eyebrow">${t('hostManaging.round', { number: state.answerRoundNumber })}</p>
            <h1>${state.question}</h1>
            ${renderQuestionAskerTag()}
          </div>
          <div class="timer-box">${t('matchingBoard.untimedLabel')}</div>
        </div>

        <div class="turn-box">
          <p>${t('matchingBoard.instructionsEyebrow')}</p>
          <h2>${t('matchingBoard.instructions')}</h2>
        </div>

        <div class="matching-board">
          <div class="matching-slots">
          ${state.matchingBoard
            .map((slot) => {
              const mine = state.myMatches.find((match) => match.slotId === slot.slotId)
              const placedPlayer = mine ? state.players.find((player) => player.id === mine.guessedId) : undefined
              return `
                <div class="matching-slot ${mine ? 'filled' : ''}" data-role="matching-slot" data-slot-id="${slot.slotId}">
                  <p class="matching-slot-text">"${slot.text}"</p>
                  <div class="matching-slot-target">
                    ${mine
                      ? `
                        <span class="matching-token placed">${formatPlayerAvatar(placedPlayer)} ${mine.guessedName}</span>
                        ${canEditMatches ? `<button class="matching-remove-match" type="button" data-role="remove-match" data-slot-id="${slot.slotId}" aria-label="${t('matchingBoard.removeMatch')}" title="${t('matchingBoard.removeMatch')}">X</button>` : ''}
                      `
                      : `<span class="matching-slot-placeholder">${t('matchingBoard.dropHere')}</span>`}
                  </div>
                </div>
              `
            })
            .join('')}
          </div>

          <div class="matching-token-pool" data-role="matching-token-pool">
          ${availableTokens
            .map(
              (player) => `
                <button type="button" class="matching-token ${state.matchingSelectedTokenId === player.id ? 'selected' : ''}" data-role="matching-token" data-token-id="${player.id}">
                    <span>${formatPlayerAvatar(player)} ${player.name}</span>
                    <small class="matching-token-drag-hint">${t('matchingBoard.dragMe')}</small>
                </button>
              `,
            )
            .join('')}
          </div>
        </div>

        <div class="guess-status-list">
          ${state.matchingProgress
            .map((entry) => {
              const player = state.players.find((candidate) => candidate.id === entry.playerId)
              const displayName = player ? player.name : (entry.playerId === state.hostId ? state.hostName : '')
              const displayAvatar = player ? formatPlayerAvatar(player) : (entry.playerId === state.hostId ? state.hostAvatar : '')
              return `
                <div class="guess-status-row ${entry.done ? 'done' : 'waiting'}">
                  <span>${displayAvatar} ${displayName}</span>
                  <strong>${entry.done ? t('matchingBoard.playerDone') : t('matchingBoard.playerWaiting')}</strong>
                </div>
              `
            })
            .join('')}
        </div>

        ${isDoneGuessing ? `<div class="mini-card"><span>${t('matchingBoard.youAreDone')}</span></div>` : ''}

        ${state.role === 'host'
          ? `<div class="host-actions-row"><button class="ghost-button" type="button" data-role="force-complete-matching">${t('matchingBoard.forceComplete')}</button></div>`
          : ''}
      </section>
    </main>
  `

  wireMatchingBoardInteractions()
}

function wireMatchingBoardInteractions(): void {
  const canEditMatches = state.matchingProgress.some((entry) => entry.playerId === state.currentPlayerId) && !state.matchingConfirmed

  root.querySelectorAll<HTMLButtonElement>('[data-role="matching-token"]').forEach((tokenEl) => {
    tokenEl.addEventListener('pointerdown', (event) => startMatchingTokenPointer(event, tokenEl))
  })

  root.querySelectorAll<HTMLElement>('[data-role="matching-slot"]').forEach((slotEl) => {
    slotEl.addEventListener('click', () => {
      if (!canEditMatches || slotEl.classList.contains('filled') || !state.matchingSelectedTokenId) {
        return
      }
      placeMatchToken(slotEl.dataset.slotId ?? '', state.matchingSelectedTokenId)
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-role="remove-match"]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      removeMatchToken(button.dataset.slotId ?? '')
    })
  })

  root.querySelector('[data-role="force-complete-matching"]')?.addEventListener('click', () => {
    forceCompleteMatching()
  })
}

// Unifies mouse+touch dragging via Pointer Events; a tap (no movement) toggles tap-to-place selection instead.
function startMatchingTokenPointer(event: PointerEvent, tokenEl: HTMLButtonElement): void {
  const tokenId = tokenEl.dataset.tokenId ?? ''
  if (!tokenId || state.matchingConfirmed) {
    return
  }

  matchingDragState = { tokenId, startX: event.clientX, startY: event.clientY, moved: false, pointerId: event.pointerId }

  const onMove = (moveEvent: PointerEvent) => {
    if (!matchingDragState || moveEvent.pointerId !== matchingDragState.pointerId) {
      return
    }

    const dx = moveEvent.clientX - matchingDragState.startX
    const dy = moveEvent.clientY - matchingDragState.startY

    if (!matchingDragState.moved && Math.hypot(dx, dy) > 6) {
      matchingDragState.moved = true
      const tokenRect = tokenEl.getBoundingClientRect()
      matchingDragGhost = tokenEl.cloneNode(true) as HTMLElement
      matchingDragGhost.classList.add('matching-token-ghost')
      matchingDragGhost.style.width = `${tokenRect.width}px`
      matchingDragGhost.style.height = `${tokenRect.height}px`
      document.body.appendChild(matchingDragGhost)
    }

    if (matchingDragState.moved && matchingDragGhost) {
      matchingDragGhost.style.left = `${moveEvent.clientX}px`
      matchingDragGhost.style.top = `${moveEvent.clientY}px`
      root.querySelectorAll('[data-role="matching-slot"]').forEach((el) => el.classList.remove('drag-over'))
      const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLElement>('[data-role="matching-slot"]')
      if (target && !target.classList.contains('filled')) {
        target.classList.add('drag-over')
      }
    }
  }

  const onUp = (upEvent: PointerEvent) => {
    if (!matchingDragState || upEvent.pointerId !== matchingDragState.pointerId) {
      return
    }

    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)

    const wasDrag = matchingDragState.moved
    const draggedTokenId = matchingDragState.tokenId
    matchingDragGhost?.remove()
    matchingDragGhost = null
    root.querySelectorAll('[data-role="matching-slot"]').forEach((el) => el.classList.remove('drag-over'))
    matchingDragState = null

    if (wasDrag) {
      const target = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest<HTMLElement>('[data-role="matching-slot"]')
      if (target && !target.classList.contains('filled')) {
        placeMatchToken(target.dataset.slotId ?? '', draggedTokenId)
      }
      return
    }

    // No movement - treat as a tap: toggle tap-to-place selection.
    state.matchingSelectedTokenId = state.matchingSelectedTokenId === draggedTokenId ? null : draggedTokenId
    renderApp()
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

function renderAllAtOnceResultsTabs(): string {
  const resultPlayerIds = [...new Set(
    state.roundResults
      .map((result) => result.guesserId)
      .filter((playerId): playerId is string => Boolean(playerId)),
  )]
  const activePlayerId = resultPlayerIds.includes(state.selectedAllAtOnceResultsPlayerId ?? '')
    ? state.selectedAllAtOnceResultsPlayerId!
    : resultPlayerIds[0]
  const activePlayer = state.players.find((player) => player.id === activePlayerId)
  const activeResults = state.roundResults.filter((result) => result.guesserId === activePlayerId)
  const totalPoints = activeResults.reduce((total, result) => total + result.points, 0)

  if (!activePlayerId || !activePlayer) {
    return ''
  }

  return `
    <div class="all-at-once-results-tabs" role="tablist" aria-label="${t('roundEnd.results')}">
      ${resultPlayerIds
        .map((playerId) => {
          const player = state.players.find((entry) => entry.id === playerId)
          if (!player) {
            return ''
          }
          const isActive = playerId === activePlayerId
          return `<button class="all-at-once-results-tab ${isActive ? 'active' : ''}" type="button" role="tab" aria-selected="${isActive}" data-role="all-at-once-result-tab" data-player-id="${playerId}">${formatPlayerAvatar(player)} ${player.name}</button>`
        })
        .join('')}
    </div>

    <div class="all-at-once-results-panel" role="tabpanel">
      <div class="all-at-once-results-total">
        <span>${t('roundEnd.pointsThisRound')}</span>
        <strong>${formatScore(totalPoints)}</strong>
      </div>
      <div class="result-list">
        ${activeResults
          .map(
            (result) => `
              <div class="result-row ${result.correct ? 'success' : 'fail'}">
                <span>${t('roundEnd.guessedPlayer', { guessed: result.guessedName })}</span>
                <strong>${result.correct ? t('roundEnd.pointsEarned', { points: result.points }) : t('roundEnd.noPoints')}</strong>
              </div>
            `,
          )
          .join('')}
      </div>
    </div>
  `
}

function renderRoundEnd(): void {
  const sortedPlayers = [...state.players].sort((a, b) => b.score - a.score)
  const roundsLeft = state.finalMatchup ? 0 : Math.max(0, state.answers.length - state.answerRoundNumber - 1)
  const myResult = state.roundResults.find((result) => result.guesserName === getCurrentPlayer()?.name)
  const isEligibleToGuess = state.role === 'player'
    && state.currentPlayerId !== state.askingPlayerId
    && (state.finalMatchup ? !state.finalMatchup.authorIds.includes(state.currentPlayerId) : state.currentPlayerId !== state.answerAuthorId)
  const overlayKind: ResultOverlayKind | null = state.guessFlowMode === 'allAtOnce' || state.finalMatchup?.autoRevealed
    ? null
    : myResult
      ? myResult.correct ? 'success' : 'fail'
      : isEligibleToGuess ? 'no-guess' : null
  // Only fire the overlay/sound once per round-end instance, not on every re-render triggered by others confirming.
  const shouldShowOverlay = Boolean(overlayKind) && !state.roundEndOverlayShown
  if (shouldShowOverlay) {
    state.roundEndOverlayShown = true
  }

  // Confirmers required to advance: host + every currently-connected player, deduped (host may already be a player).
  const confirmerMap = new Map<string, Player>()
  confirmerMap.set(state.hostId, { id: state.hostId, name: state.hostName || 'Host', score: 0, avatar: state.hostAvatar })
  state.players.forEach((player) => {
    if (player.connected !== false) {
      confirmerMap.set(player.id, player)
    }
  })
  const pendingConfirmers = [...confirmerMap.values()].filter((confirmer) => !state.roundEndConfirmedIds.includes(confirmer.id))
  const hasIConfirmed = state.roundEndConfirmedIds.includes(state.currentPlayerId)
  const isLastRound = state.answerRoundNumber >= state.answers.length
  const isLastPoolQuestion = state.questionPoolMode
    ? (state.currentPoolQuestionIndex ?? 0) >= (state.poolTotalQuestions ?? 0) - 1
    : false
  const confirmLabel = state.questionPoolMode
    ? isLastPoolQuestion ? t('roundEnd.confirmGoToFinalBoard') : t('roundEnd.confirmNextQuestion')
    : isLastRound ? t('roundEnd.confirmGoToFinalBoard') : t('roundEnd.confirmNextRound')
  const confirmButtonClass = state.questionPoolMode && !isLastPoolQuestion ? 'confirm-next-question-button' : ''
  const waitingMessage = pendingConfirmers.length > 0
    ? t('roundEnd.waitingForConfirmations', { players: pendingConfirmers.map((confirmer) => `${formatPlayerAvatar(confirmer)} ${confirmer.name}`).join(', ') })
    : t('roundEnd.allConfirmed')

  root.innerHTML = `
    <main class="shell">
      ${shouldShowOverlay ? renderResultCelebrationOverlay(overlayKind as ResultOverlayKind, myResult?.points) : ''}
      ${renderIdentityBanner()}
      <section class="panel summary-panel">
        <p class="eyebrow">${t('roundEnd.complete')}</p>
        <h1>${t('roundEnd.standings')}</h1>
        <p class="rounds-left">${t('roundEnd.roundsLeft', { count: roundsLeft })}</p>

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

        ${renderQuestionAskerTag()}

        ${state.guessFlowMode === 'allAtOnce'
          ? state.matchingBoard
              .map((slot) => {
                const author = state.players.find((player) => player.id === slot.authorId)
                return `
                  <div class="mini-card">
                    <span>${t('roundEnd.answerWas')}</span>
                    <strong>"${slot.text}"</strong>
                  </div>
                  <div class="mini-card">
                    <span>${t('roundEnd.writtenBy')}</span>
                    <strong>${author ? `${formatPlayerAvatar(author)} ${author.name}` : t('roundEnd.unknown')}</strong>
                  </div>
                `
              })
              .join('')
          : state.finalMatchup
          ? state.finalMatchup.answers
              .map((answer) => {
                const author = state.players.find((player) => player.id === state.finalMatchup?.truth?.[answer.slot])
                return `
                  <div class="mini-card">
                    <span>${t('finalMatchup.answerLabel', { slot: answer.slot })}</span>
                    <strong>"${answer.text}"</strong>
                  </div>
                  <div class="mini-card">
                    <span>${t('roundEnd.writtenBy')}</span>
                    <strong>${author ? `${formatPlayerAvatar(author)} ${author.name}` : t('roundEnd.unknown')}</strong>
                  </div>
                `
              })
              .join('')
          : `
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
          `}

        ${state.finalMatchup?.autoRevealed
          ? `<div class="mini-card"><span>${t('finalMatchup.autoRevealed')}</span></div>`
          : state.guessFlowMode === 'allAtOnce'
            ? renderAllAtOnceResultsTabs()
          : `
            <div class="result-list">
              ${state.roundResults
                .map(
                  (result) => `
                    <div class="result-row ${result.correct ? 'success' : 'fail'}">
                      <span>${result.answerSlot ? t('finalMatchup.guessedLine', { guesser: result.guesserName, guessed: result.guessedName, slot: result.answerSlot }) : t('roundEnd.guessedLine', { guesser: result.guesserName, guessed: result.guessedName })}</span>
                      <strong>${result.correct ? t('roundEnd.pointsEarned', { points: result.points }) : t('roundEnd.noPoints')}</strong>
                    </div>
                  `,
                )
                .join('')}
            </div>
          `}

        ${(() => {
          if (!myResult) {
            return ''
          }
          return `<div class="mini-card"><span>${myResult.correct ? t('roundEnd.earnedMore') : t('roundEnd.missedIt')}</span></div>`
        })()}

        <div class="mini-card round-end-confirm">
          <span>${waitingMessage}</span>
        </div>

        ${hasIConfirmed
          ? `<div class="mini-card"><span>${t('roundEnd.youConfirmed')}</span></div>`
          : `<button class="primary-button next-round ${confirmButtonClass}" type="button" data-role="confirm-next-round">${confirmLabel}</button>`}

        ${state.role === 'host'
          ? `<button class="secondary-button" type="button" data-role="force-advance-round">${t('roundEnd.forceAdvance')}</button>`
          : ''}
      </section>

      ${state.allowPlayerSuggestions && state.role === 'player' ? renderSuggestQuestionPanel() : ''}
    </main>
  `

  // Trigger result audio only the first time the overlay is shown for this round-end.
  if (shouldShowOverlay && myResult) {
    playCelebrationSound(myResult.correct)
  }

  root.querySelector<HTMLButtonElement>('[data-role="confirm-next-round"]')?.addEventListener('click', () => {
    confirmNextRound()
  })

  root.querySelector<HTMLButtonElement>('[data-role="force-advance-round"]')?.addEventListener('click', () => {
    forceAdvanceRound()
  })

  root.querySelectorAll<HTMLButtonElement>('[data-role="all-at-once-result-tab"]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedAllAtOnceResultsPlayerId = button.dataset.playerId ?? null
      renderApp()
    })
  })

  wireSuggestionPanels()
}

function renderGameEnd(): void {
  const sortedPlayers = [...state.players].sort((a, b) => b.score - a.score)
  const pendingNextAsker = state.players.find((player) => player.id === state.pendingNextAskerId)

  root.innerHTML = `
    <main class="shell">
      ${renderIdentityBanner()}
      <section class="panel summary-panel">
        <p class="eyebrow">${t('gameEnd.complete')}</p>
        <h1>${t('gameEnd.finished')}</h1>
        <p class="subtitle">${state.role === 'host' ? 'You can ask another question to continue playing.' : 'The host can ask another question to continue playing.'}</p>
        <div class="section-head">
          <h2>${t('gameEnd.finalScores')}</h2>
        </div>

        <div class="leaderboard">
          ${sortedPlayers
            .map(
              (player, index) => `
                <div class="leaderboard-row ${index === 0 ? 'winner' : index === 1 ? 'second' : index === 2 ? 'third' : ''}">
                  <span>${[t('gameEnd.gold'), t('gameEnd.silver'), t('gameEnd.bronze')][index] ?? `#${index + 1}`} ${formatPlayerAvatar(player)} ${player.name}</span>
                  <strong>${formatScore(player.score)}</strong>
                </div>
              `,
            )
            .join('')}
        </div>
      </section>

      ${pendingNextAsker ? `<section class="panel" role="status"><strong>${t('gameEnd.nextAsker', { name: pendingNextAsker.name })}</strong></section>` : ''}

      ${state.role === 'host' ? `<button class="primary-button next-round" type="button" data-role="new-game">${state.hostIsPlayer && !state.questionPoolMode ? t('gameEnd.continueNextQuestion') : t('gameEnd.newGame')}</button>` : ''}

      ${state.allowPlayerSuggestions && state.role === 'player' ? renderSuggestQuestionPanel() : ''}
    </main>
  `

  root.querySelector<HTMLButtonElement>('[data-role="new-game"]')?.addEventListener('click', () => {
    state.customQuestion = ''
    requestNewGame()
  })

  wireSuggestionPanels()
}

function renderApp(): void {
  // Screens outside an active room are never room-scoped, so they must not inherit a previous room's language.
  if (state.screen === 'welcome' || state.screen === 'host-setup' || state.screen === 'admin-login' || state.screen === 'admin-gallery') {
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

  if (state.screen === 'ask-question') {
    renderAskQuestion()
    return
  }

  if (state.screen === 'waiting-for-question') {
    renderWaitingForQuestion()
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

  if (state.screen === 'matching-board') {
    renderMatchingBoard()
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
  // Skip WebSocket connection in demo mode
  if ((window as any).__DEMO_MODE__) {
    console.log('⚠️ WebSocket skipped (demo mode)')
    return
  }

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

      if (payload.type === 'player-kicked') {
        window.alert(t('prompts.playerKicked', { name: payload.playerName }))
        return
      }

      if (payload.type === 'kicked') {
        clearStoredRoomSession()
        shouldRestoreRoomSession = false
        state.screen = 'welcome'
        state.roomCode = ''
        state.playerName = ''
        state.currentPlayerId = ''
        state.players = []
        setLanguage('en')
        window.alert(t('prompts.kickedFromRoom'))
        renderApp()
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

// Initialize WebSocket connection (skip in demo mode)
if (!(window as any).__DEMO_MODE__) {
  connectSocket()
}

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

async function initializeDemoMode(): Promise<void> {
  if (!(window as any).__DEMO_MODE__) {
    return
  }

  const demoStateKey = (window as any).__DEMO_STATE__
  if (!demoStateKey) {
    return
  }

  try {
    const response = await fetch('/demo-states.json')
    const allDemoStates: Record<string, any> = await response.json()
    const demoConfig = allDemoStates[demoStateKey]

    if (!demoConfig || !demoConfig.state) {
      console.error(`Demo state "${demoStateKey}" not found`)
      return
    }

    const demoRoomState = demoConfig.state

    // Set player session info from demo config
    state.role = demoConfig.role
    state.currentPlayerId = demoConfig.playerId
    state.playerName = demoConfig.playerName
    state.roomCode = demoConfig.roomCode
    state.myAvatar = demoConfig.state.players.find((p: Player) => p.id === demoConfig.playerId)?.avatar || '🎭'

    // Merge demo room state into app state
    state.phase = demoRoomState.phase
    state.answerRoundNumber = demoRoomState.answerRoundNumber
    state.question = demoRoomState.question
    state.selectedAnswer = demoRoomState.selectedAnswer
    state.answerAuthorId = demoRoomState.answerAuthorId
    state.activeGuesserIndex = demoRoomState.activeGuesserIndex
    state.players = demoRoomState.players
    state.answers = demoRoomState.answers
    state.guesses = demoRoomState.guesses
    state.roundResults = demoRoomState.roundResults
    state.timeLeft = demoRoomState.timeLeft
    state.language = demoRoomState.language
    state.guessTimeoutSeconds = demoRoomState.guessTimeoutSeconds
    state.hostIsPlayer = demoRoomState.hostIsPlayer ?? false
    state.askingPlayerId = demoRoomState.askingPlayerId ?? null
    state.pendingNextAskerId = demoRoomState.pendingNextAskerId ?? null
    state.finalMatchup = demoRoomState.finalMatchup ?? null
    // Demo-only: lets a fixture show either the "your turn" overlay or the question form beneath it.
    state.askerOverlayConfirmed = demoConfig.askerOverlayConfirmed ?? true
    
    // For guessing phases, compute realistic future deadlines (not static JSON timestamps)
    if (demoRoomState.phase === 'guessing' && demoRoomState.guessCountdownEndsAt) {
      // timeLeft tells us how many seconds remain
      const futureDeadline = Date.now() + (state.timeLeft * 1000)
      state.guessDeadlineMs = futureDeadline
      state.guessCountdownEndsAt = futureDeadline
    } else {
      state.guessDeadlineMs = demoRoomState.guessDeadlineMs
      state.guessCountdownEndsAt = demoRoomState.guessCountdownEndsAt
    }
    
    state.remainingAuthorIds = demoRoomState.remainingAuthorIds

    // Set screen based on phase, mirroring the asker-aware branching used for live rooms
    const isDemoCurrentAsker = Boolean(state.hostIsPlayer) && state.currentPlayerId === state.askingPlayerId
    if (demoRoomState.phase === 'lobby') {
      state.screen = 'lobby'
    } else if (demoRoomState.phase === 'asking') {
      state.screen = isDemoCurrentAsker ? 'ask-question' : 'waiting-for-question'
    } else if (demoRoomState.phase === 'answer-collection') {
      state.screen = state.hostIsPlayer ? (isDemoCurrentAsker ? 'host-managing' : 'player-answering') : (state.role === 'host' ? 'host-managing' : 'player-answering')
    } else if (demoRoomState.phase === 'guessing') {
      state.screen = state.hostIsPlayer ? (isDemoCurrentAsker ? 'host-managing' : 'player-guessing') : (state.role === 'host' ? 'host-managing' : 'player-guessing')
    } else if (demoRoomState.phase === 'round-end') {
      state.screen = 'round-end'
    } else if (demoRoomState.phase === 'game-end') {
      state.screen = 'game-end'
    } else {
      state.screen = 'welcome'
    }

    // Set language
    setLanguage(demoRoomState.language)

    // Start countdown timers for guessing phases
    if (state.phase === 'guessing' && state.guessCountdownEndsAt) {
      manageGuessCountdown()
    }

    console.log(`✅ Demo mode loaded: ${demoConfig.label}`)
  } catch (error) {
    console.error('Failed to initialize demo mode:', error)
  }
}

async function restorePostLoginScreenIfPending(): Promise<void> {
  let pendingScreen: string | null = null
  try {
    pendingScreen = window.sessionStorage.getItem(postLoginScreenStorageKey)
  } catch {
    return
  }

  if (pendingScreen !== 'host-setup') {
    return
  }

  try {
    window.sessionStorage.removeItem(postLoginScreenStorageKey)
  } catch {
    // Nothing else is required when browser storage is unavailable.
  }

  await refreshAccountSession()
  if (!state.account) {
    return
  }

  await fetchMyQuestions()
  state.screen = 'host-setup'
}

consumeEmailVerificationLink()
  .then(() => initializeDemoMode())
  .then(() => restorePostLoginScreenIfPending())
  .then(() => refreshAccountSession())
  .finally(() => {
    initializeRoomLinkIfProvided()
    renderApp()
  })
