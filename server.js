import appInsights from 'applicationinsights';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createAuthService } from './auth.js';
import { isAdminEmail } from './admins.js';
import { createQuestionService, minQuestionLength, maxQuestionLength, otherSupportedLanguages } from './questions.js';
import { createUserQuestionService } from './userQuestions.js';
import { sendVerificationEmail } from './emailService.js';
import { translateText } from './translationService.js';
import { logger } from './logger.js';

if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  appInsights.setup().setSendLiveMetrics(true).start();
  appInsights.defaultClient.context.tags[appInsights.defaultClient.context.keys.cloudRole] = 'guess-party';
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDirectory = path.join(__dirname, 'dist');
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = process.env.PORT || 8080;
const isProduction = process.env.NODE_ENV === 'production';
const appOrigin = process.env.APP_ORIGIN || 'http://localhost:5173';
const sessionCookieName = 'guess_party_session';
const authService = createAuthService({
  onAccountStatsChanged: ({ totalAccounts, verifiedAccounts }) => {
    logger.metric('registered-accounts', totalAccounts);
    logger.metric('verified-accounts', verifiedAccounts);
  },
  sendVerificationEmail: ({ email, token }) => {
    const link = `${appOrigin}/?verify=${encodeURIComponent(token)}`;

    sendVerificationEmail({ email, link })
      .then((sent) => {
        if (!sent && !isProduction) {
          logger.info('verification-link-dev-fallback', { link });
        }
      })
      .catch((error) => {
        logger.error('verification-email-send-failed', { error });
      });
  },
});
const initialAccountStats = authService.getAccountStats();
logger.metric('registered-accounts', initialAccountStats.totalAccounts);
logger.metric('verified-accounts', initialAccountStats.verifiedAccounts);
const questionService = createQuestionService();
const userQuestionService = createUserQuestionService();

process.on('uncaughtException', (error) => {
  logger.error('uncaught-exception', { error });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled-rejection', { error: reason instanceof Error ? reason : new Error(String(reason)) });
});
const questionBank = [
  'What is the best way to spend a perfect family night?',
  'What is the most fun way to surprise a friend on a weekend?',
  'What would you choose for the ultimate comfort day?',
  'What is the one thing that makes a group hangout unforgettable?',
  'What is the most comforting thing to do on a rainy day?',
  'What would make a surprise birthday unforgettable?',
];

const rooms = new Map();
const reconnectGracePeriodMs = 30 * 60 * 1000;
const supportedLanguages = new Set(['en', 'he']);
const GUESS_TIMEOUT_SECONDS = 20;
const MIN_GUESS_TIMEOUT_SECONDS = 20;
const MAX_GUESS_TIMEOUT_SECONDS = 60;
// Celebratory "get ready to guess" countdown played before the real per-answer guess timer is armed.
const GUESS_COUNTDOWN_MS = 4000;
// Points for a correct guess by arrival order (1st correct guess, 2nd, ...); last value is the floor for the rest.
const SPEED_TIERS = [120, 100, 80, 60, 40];
// Fixed allow-list: never trust arbitrary client-supplied avatar strings.
const AVATAR_OPTIONS = [
  '🦊', '🐸', '🐧', '🐼', '🐨', '🦁', '🐵', '🐯',
  '🐮', '🐷', '🐙', '🦄', '🐝', '🦋', '🐢', '🐳',
  '🦖', '🌵', '🍕', '🎧', '🚀', '⭐', '🎲', '🎨',
];
const defaultAvatar = AVATAR_OPTIONS[0];

function normalizeLanguage(language) {
  return supportedLanguages.has(language) ? language : 'en';
}

function normalizeAvatar(avatar) {
  return AVATAR_OPTIONS.includes(avatar) ? avatar : defaultAvatar;
}

function createRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';

  for (let index = 0; index < 6; index += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

function safePlayer(player, room = null) {
  return {
    id: player.id,
    name: player.name,
    score: player.score,
    avatar: player.avatar,
    ready: Boolean(player.ready),
    connected: !player.disconnectedAt,
    poolQuestionCount: room && room.poolQuestions ? room.poolQuestions.filter((q) => q.playerId === player.id).length : 0,
  };
}

// Required round-end confirmers = host + every currently-connected player (disconnected players never block auto-advance).
function getRoundEndConfirmerIds(room) {
  const ids = new Set([room.hostId]);
  room.players.forEach((player) => {
    if (!player.disconnectedAt) {
      ids.add(player.id);
    }
  });
  return ids;
}

function hasAllRoundEndConfirmed(room) {
  const required = getRoundEndConfirmerIds(room);
  return [...required].every((id) => room.roundEndConfirmedIds.includes(id));
}

function canConfirmNextRound(room, playerId) {
  return Boolean(room && room.phase === 'round-end' && playerId && getRoundEndConfirmerIds(room).has(playerId));
}

function publicSuggestion(suggestion) {
  return {
    id: suggestion.id,
    playerId: suggestion.playerId,
    playerName: suggestion.playerName,
    text: suggestion.text,
  };
}

function publicPoolQuestion(item) {
  return {
    id: item.id,
    playerId: item.playerId,
    playerName: item.playerName,
    text: item.text,
    createdAt: item.createdAt,
  };
}

function canSubmitPoolQuestion(room, playerId) {
  if (!room || !room.questionPoolMode || room.phase !== 'lobby' || !playerId) {
    return false;
  }
  const isHost = room.hostId === playerId;
  const player = findPlayerById(room, playerId);
  if (!isHost && !player) {
    return false;
  }
  const existingCount = (room.poolQuestions || []).filter((q) => q.playerId === playerId).length;
  return existingCount < 3;
}

function addPoolQuestion(room, playerId, playerName, text) {
  if (!canSubmitPoolQuestion(room, playerId)) {
    return null;
  }
  const trimmed = String(text || '').trim();
  if (trimmed.length < minQuestionLength || trimmed.length > maxQuestionLength) {
    return null;
  }

  const question = {
    id: crypto.randomUUID(),
    playerId,
    playerName: playerName || 'Player',
    text: trimmed,
    createdAt: Date.now(),
  };
  room.poolQuestions.push(question);
  return question;
}

function canDeletePoolQuestion(room, questionId, playerId) {
  if (!room || !room.questionPoolMode || room.phase !== 'lobby' || !playerId || !questionId) {
    return false;
  }
  const existing = (room.poolQuestions || []).find((q) => q.id === questionId);
  return Boolean(existing && existing.playerId === playerId);
}

function deletePoolQuestion(room, questionId) {
  if (!room || !room.poolQuestions) {
    return null;
  }
  const index = room.poolQuestions.findIndex((q) => q.id === questionId);
  if (index === -1) {
    return null;
  }
  const [removed] = room.poolQuestions.splice(index, 1);
  return removed;
}

function canDiscardPoolQuestion(room, playerId) {
  return Boolean(room && room.questionPoolMode && room.phase === 'lobby' && playerId && room.hostId === playerId);
}

function discardPoolQuestion(room, questionId) {
  if (!room || !room.poolQuestions) {
    return null;
  }
  const index = room.poolQuestions.findIndex((q) => q.id === questionId);
  if (index === -1) {
    return null;
  }
  const [removed] = room.poolQuestions.splice(index, 1);
  return removed;
}

function setPlayerReady(room, playerId, isReady = true) {
  if (!room || room.phase !== 'lobby' || !playerId) {
    return false;
  }
  const player = findPlayerById(room, playerId);
  if (player) {
    player.ready = Boolean(isReady);
    return true;
  }
  if (room.hostId === playerId) {
    room.hostReady = Boolean(isReady);
    return true;
  }
  return false;
}

function canStartGame(room) {
  if (!room || room.phase !== 'lobby') {
    return false;
  }
  // Must match startRound()'s own player-count thresholds, which relax the
  // host-as-player minimum of 4 down to 3 when questionPoolMode is on.
  const minPlayers = room.hostIsPlayer && !room.questionPoolMode ? 4 : 3;
  if (room.players.length < minPlayers) {
    return false;
  }
  if (room.questionPoolMode) {
    if (!room.poolQuestions || room.poolQuestions.length < 1) {
      return false;
    }
    const allPlayersReady = room.players.length > 0 && room.players.every((p) => Boolean(p.ready));
    if (!allPlayersReady) {
      return false;
    }
  }
  return true;
}

function addSuggestedQuestion(room, playerId, playerName, text) {
  const trimmed = String(text || '').trim();
  if (trimmed.length < minQuestionLength || trimmed.length > maxQuestionLength) {
    return null;
  }

  const suggestion = {
    id: crypto.randomUUID(),
    playerId,
    playerName,
    text: trimmed,
    createdAt: Date.now(),
  };
  room.suggestedQuestions.push(suggestion);
  return suggestion;
}

function removeSuggestedQuestion(room, suggestionId) {
  const index = room.suggestedQuestions.findIndex((entry) => entry.id === suggestionId);
  if (index === -1) {
    return null;
  }
  const [removed] = room.suggestedQuestions.splice(index, 1);
  return removed;
}

function canSuggestQuestion(room, playerId) {
  return Boolean(room && room.allowPlayerSuggestions && playerId && findPlayerById(room, playerId));
}

function canDeleteSuggestion(room, suggestionId, playerId) {
  if (!room || !playerId) {
    return false;
  }
  const existing = room.suggestedQuestions.find((entry) => entry.id === suggestionId);
  return Boolean(existing && existing.playerId === playerId);
}

function canDismissSuggestion(room, playerId) {
  return Boolean(room && playerId && room.hostId === playerId);
}

function normalizeGuessFlowMode(value) {
  return value === 'allAtOnce' ? 'allAtOnce' : 'sequential';
}

// Fisher-Yates - unlike `.sort(() => Math.random() - 0.5)`, this is an unbiased shuffle (matters most for small N).
function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// All non-asker players take part in matching (host included only when hostIsPlayer put them in room.players).
function getEligibleMatcherIds(room) {
  return room.players.filter((player) => player.id !== room.askingPlayerId).map((player) => player.id);
}

function isMatchingComplete(room) {
  const eligibleIds = getEligibleMatcherIds(room);
  if (eligibleIds.length === 0) {
    return true;
  }
  return eligibleIds.every((id) => room.matchingConfirmedIds.includes(id));
}

function canSubmitMatch(room, guesserId, slotId, guessedId) {
  if (!room || room.phase !== 'matching' || !guesserId || !slotId || !guessedId) {
    return false;
  }
  if (!getEligibleMatcherIds(room).includes(guesserId)) {
    return false;
  }
  if (room.matchingConfirmedIds.includes(guesserId)) {
    return false;
  }
  const slot = room.matchingBoard.find((entry) => entry.slotId === slotId);
  if (!slot) {
    return false;
  }
  // The name-token pool is exactly this round's answer authors, not every player in the room.
  const authorIds = new Set(room.matchingBoard.map((entry) => entry.authorId));
  if (!authorIds.has(guessedId)) {
    return false;
  }
  const alreadyPlacedThisSlot = room.matches.some((match) => match.guesserId === guesserId && match.slotId === slotId);
  const tokenAlreadyUsed = room.matches.some((match) => match.guesserId === guesserId && match.guessedId === guessedId);
  return !alreadyPlacedThisSlot && !tokenAlreadyUsed;
}

function submitMatch(room, guesserId, slotId, guessedId) {
  if (!canSubmitMatch(room, guesserId, slotId, guessedId)) {
    return false;
  }
  const guessedPlayer = findPlayerById(room, guessedId);
  room.matches.push({
    guesserId,
    slotId,
    guessedId,
    guessedName: guessedPlayer.name,
    submittedAt: null,
  });

  const myMatches = room.matches.filter((match) => match.guesserId === guesserId);
  if (myMatches.length === room.matchingBoard.length) {
    const completedAt = Date.now();
    myMatches.forEach((match) => {
      match.submittedAt = completedAt;
    });
    room.matchingConfirmedIds.push(guesserId);
  }

  return true;
}

function removeMatch(room, guesserId, slotId) {
  if (!room || room.phase !== 'matching' || !guesserId || !slotId) {
    return false;
  }
  if (!getEligibleMatcherIds(room).includes(guesserId) || room.matchingConfirmedIds.includes(guesserId)) {
    return false;
  }
  const matchIndex = room.matches.findIndex((match) => match.guesserId === guesserId && match.slotId === slotId);
  if (matchIndex < 0) {
    return false;
  }
  room.matches.splice(matchIndex, 1);
  return true;
}

function canForceCompleteMatching(room, playerId) {
  return Boolean(room && room.phase === 'matching' && playerId && room.hostId === playerId);
}

// Per answer, correct guessers are ranked by placement speed: fastest of K correct gets K points, slowest gets 1.
function calculateAllAtOnceScores(room) {
  if (room.phase !== 'matching') {
    return;
  }

  const pointsByMatch = new Map();
  room.matchingBoard.forEach((slot) => {
    const correctMatches = room.matches
      .filter((match) => room.matchingConfirmedIds.includes(match.guesserId))
      .filter((match) => match.slotId === slot.slotId && match.guessedId === slot.authorId)
      .sort((a, b) => a.submittedAt - b.submittedAt);
    const total = correctMatches.length;
    correctMatches.forEach((match, index) => {
      const points = total - index;
      pointsByMatch.set(match, points);
      const guesser = findPlayerById(room, match.guesserId);
      if (guesser) {
        guesser.score += points;
      }
    });
  });

  room.roundResults = room.matches.filter((match) => room.matchingConfirmedIds.includes(match.guesserId)).map((match) => {
    const slot = room.matchingBoard.find((entry) => entry.slotId === match.slotId);
    const guesser = findPlayerById(room, match.guesserId);
    return {
      guesserId: match.guesserId,
      guesserName: guesser ? guesser.name : '',
      guessedName: match.guessedName,
      correct: Boolean(slot) && match.guessedId === slot.authorId,
      points: pointsByMatch.get(match) || 0,
    };
  });

  room.phase = 'round-end';
  room.timeLeft = 0;
  room.roundEndConfirmedIds = [];
  broadcastRoom(room);
}

// Builds the single combined matching round for a question in allAtOnce mode (replaces the per-answer answerQueue flow).
function buildMatchingBoard(room) {
  room.matchingBoard = shuffle(
    room.answers.map((answer) => ({ slotId: crypto.randomUUID(), text: answer.text, authorId: answer.playerId })),
  );
  // Shuffled independently from the slot order above, so the name-token pool never lines up 1:1 with the answers.
  room.matchingTokenOrder = shuffle(room.matchingBoard.map((slot) => slot.authorId));
  room.matches = [];
  room.matchingConfirmedIds = [];
  room.answerQueue = [];
  room.currentAnswer = null;
  room.answerAuthorId = null;
  room.selectedAnswer = '';
  room.finalMatchup = null;
  room.answerRoundNumber = room.answers.length;
  room.timeLeft = 0;
  room.phase = 'matching';
  clearGuessTimeout(room);
  clearGuessCountdown(room);
  broadcastRoom(room);
}

// Only answer authors are eligible, excluding those revealed in an earlier round and the current asker.
function getEligibleGuessTargetIds(room) {
  if (room.finalMatchup) {
    return new Set(room.finalMatchup.authorIds);
  }

  const revealedAuthorIds = new Set(
    room.answers
      .map((answer) => answer.playerId)
      .filter((playerId) => {
        if (room.currentAnswer && playerId === room.currentAnswer.playerId) {
          return false;
        }
        return !room.answerQueue.some((queued) => queued.playerId === playerId);
      }),
  );

  return new Set(
    room.answers
      .map((answer) => answer.playerId)
      .filter((id) => !revealedAuthorIds.has(id) && id !== room.askingPlayerId),
  );
}

function makeRoomState(room, viewerPlayerId = null) {
  const isHostViewer = viewerPlayerId !== null && viewerPlayerId === room.hostId;
  return {
    code: room.code,
    phase: room.phase,
    answerRoundNumber: room.answerRoundNumber,
    question: room.question,
    questionAuthorName: room.phase === 'answer-collection' && room.questionPoolMode
      ? room.questionPool?.[room.currentPoolQuestionIndex]?.playerName || null
      : null,
    // Withheld while guessing is live, otherwise a client could read the correct author off the network payload.
    answerAuthorId: room.phase === 'guessing' ? null : room.answerAuthorId,
    selectedAnswer: room.selectedAnswer,
    activeGuesserIndex: room.activeGuesserIndex,
    timeLeft: room.timeLeft,
    players: room.players.map((p) => safePlayer(p, room)),
    answers: room.answers,
    guesses: room.guesses,
    roundResults: room.roundResults,
    hostId: room.hostId,
    hostName: room.hostName,
    hostAvatar: room.hostAvatar,
    language: room.language,
    roundEndConfirmedIds: room.roundEndConfirmedIds || [],
    guessTimeoutSeconds: room.guessTimeoutSeconds,
    guessDeadlineMs: room.guessDeadlineMs,
    guessCountdownEndsAt: room.guessCountdownEndsAt,
    remainingAuthorIds: [...getEligibleGuessTargetIds(room)],
    hostIsPlayer: room.hostIsPlayer,
    askingPlayerId: room.askingPlayerId,
    pendingNextAskerId: room.pendingNextAskerId,
    allowPlayerSuggestions: room.allowPlayerSuggestions,
    // Host-only: the full pending list. Other players only ever see their own submissions.
    suggestedQuestions: isHostViewer ? room.suggestedQuestions.map(publicSuggestion) : [],
    mySuggestedQuestions: room.allowPlayerSuggestions
      ? room.suggestedQuestions.filter((entry) => entry.playerId === viewerPlayerId).map(publicSuggestion)
      : [],
    questionPoolMode: Boolean(room.questionPoolMode),
    // Host-only: the full pool list for inspection/moderation. Other players only see their own.
    poolQuestions: isHostViewer ? (room.poolQuestions || []).map(publicPoolQuestion) : [],
    myPoolQuestions: room.questionPoolMode
      ? (room.poolQuestions || []).filter((entry) => entry.playerId === viewerPlayerId).map(publicPoolQuestion)
      : [],
    poolQuestionCount: room.poolQuestions ? room.poolQuestions.length : 0,
    poolTotalQuestions: room.questionPool ? room.questionPool.length : 0,
    currentPoolQuestionIndex: room.currentPoolQuestionIndex || 0,
    allPlayersReady: room.players.length > 0 && room.players.every((p) => Boolean(p.ready)),
    canStartGame: canStartGame(room),
    guessFlowMode: room.guessFlowMode || 'sequential',
    // Text only while matching is live - authorId is withheld so a client can't read the answer off the network payload.
    matchingBoard: (room.matchingBoard || []).map((slot) => (
      room.phase === 'matching'
        ? { slotId: slot.slotId, text: slot.text }
        : { slotId: slot.slotId, text: slot.text, authorId: slot.authorId }
    )),
    // The name-token pool (who wrote an answer this round) - independently shuffled from matchingBoard's slot
    // order (see buildMatchingBoard), so token position never reveals the correct slot by alignment.
    matchingAuthorIds: room.matchingTokenOrder || [],
    myMatches: (room.matches || [])
      .filter((match) => match.guesserId === viewerPlayerId)
      .map((match) => ({ slotId: match.slotId, guessedId: match.guessedId, guessedName: match.guessedName })),
    matchingConfirmed: (room.matchingConfirmedIds || []).includes(viewerPlayerId),
    // Done/not-done only - never expose other players' in-progress placements.
    matchingProgress: room.phase === 'matching'
      ? getEligibleMatcherIds(room).map((id) => ({
          playerId: id,
          done: (room.matchingConfirmedIds || []).includes(id),
        }))
      : [],
    finalMatchup: room.finalMatchup
      ? {
          answers: room.finalMatchup.answers,
          authorIds: room.finalMatchup.authorIds,
          autoRevealed: room.finalMatchup.autoRevealed,
          truth: room.phase === 'guessing' ? null : room.finalMatchup.truth,
        }
      : null,
  };
}

function broadcastRoom(room) {
  room.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: 'room-state', state: makeRoomState(room, client.playerId) }));
    }
  });
}

function findRoomByCode(code) {
  return rooms.get(code);
}

function findPlayerById(room, playerId) {
  return room.players.find((player) => player.id === playerId);
}

function createReconnectToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sendRoomSession(socket, room, role, playerId, playerName, reconnectToken) {
  socket.send(JSON.stringify({
    type: 'room-session',
    session: {
      roomCode: room.code,
      role,
      playerId,
      playerName,
      reconnectToken,
    },
  }));
}

function attachSocketToRoom(room, socket, playerId) {
  room.clients.forEach((client) => {
    if (client !== socket && client.playerId === playerId) {
      room.clients.delete(client);
      client.close();
    }
  });

  socket.roomCode = room.code;
  socket.playerId = playerId;
  room.clients.add(socket);
}

function reconnectRoom(room, socket, { role, reconnectToken }) {
  if (role === 'host') {
    // Token-only, symmetric with player reconnect below - works for both guest and authenticated hosts.
    if (!room.hostReconnectToken || room.hostReconnectToken !== reconnectToken) {
      return null;
    }

    room.hostDisconnectedAt = null;
    attachSocketToRoom(room, socket, room.hostId);
    return {
      role: 'host',
      playerId: room.hostId,
      playerName: room.hostName,
      reconnectToken: room.hostReconnectToken,
    };
  }

  if (role !== 'player') {
    return null;
  }

  const player = room.players.find((entry) => entry.reconnectToken === reconnectToken);
  if (!player) {
    return null;
  }

  player.disconnectedAt = null;
  attachSocketToRoom(room, socket, player.id);
  return {
    role: 'player',
    playerId: player.id,
    playerName: player.name,
    reconnectToken: player.reconnectToken,
  };
}

function expireDisconnectedMemberships(now = Date.now()) {
  rooms.forEach((room) => {
    const hostExpired = room.hostDisconnectedAt && now - room.hostDisconnectedAt >= reconnectGracePeriodMs;
    if (hostExpired) {
      room.hostId = null;
      room.hostReconnectToken = null;
      room.hostDisconnectedAt = null;
    }

    const previousPlayerCount = room.players.length;
    room.players = room.players.filter((player) => !player.disconnectedAt || now - player.disconnectedAt < reconnectGracePeriodMs);

    if (!room.hostId && room.players.length === 0) {
      rooms.delete(room.code);
      return;
    }

    if (hostExpired || room.players.length !== previousPlayerCount) {
      broadcastRoom(room);
    }
  });
}

function nextTurn(room) {
  if (room.phase !== 'answer') {
    return;
  }

  const currentIndex = room.playerTurnIndex;
  room.playerTurnIndex = currentIndex + 1;

  if (room.playerTurnIndex >= room.players.length) {
    room.phase = 'guess';
    room.timeLeft = 12;
    room.guessDeadlineMs = Date.now() + 12000;
    broadcastRoom(room);
  }
}

function normalizeGuessTimeoutSeconds(value) {
  const seconds = Number(value);
  if (Number.isInteger(seconds) && seconds >= MIN_GUESS_TIMEOUT_SECONDS && seconds <= MAX_GUESS_TIMEOUT_SECONDS) {
    return seconds;
  }
  return GUESS_TIMEOUT_SECONDS;
}

function createRoom({ hostName, hostAccountId = null, language = 'en', hostAvatar, guessTimeoutSeconds, addSelfAsPlayer = false, allowPlayerSuggestions = false, questionPoolMode = false, guessFlowMode = 'sequential' }) {
  const code = createRoomCode();
  const hostId = `${code}-host-${Date.now()}`;
  const normalizedHostName = (hostName || 'Host').trim() || 'Host';
  const normalizedHostAvatar = normalizeAvatar(hostAvatar);
  const isQuestionPoolMode = Boolean(questionPoolMode);
  const room = {
    code,
    phase: 'lobby',
    answerRoundNumber: 0,
    question: '',
    answerAuthorId: null,
    selectedAnswer: '',
    activeGuesserIndex: 0,
    timeLeft: 0,
    clients: new Set(),
    players: [],
    answers: [],
    guesses: [],
    answerQueue: [],
    currentAnswer: null,
    roundResults: [],
    hostId,
    hostAccountId,
    hostName: normalizedHostName,
    hostAvatar: normalizedHostAvatar,
    hostReconnectToken: createReconnectToken(),
    hostDisconnectedAt: null,
    playerTurnIndex: 0,
    language: normalizeLanguage(language),
    guessTimeoutSeconds: normalizeGuessTimeoutSeconds(guessTimeoutSeconds),
    guessDeadlineMs: null,
    guessTimeoutHandle: null,
    guessCountdownEndsAt: null,
    guessCountdownHandle: null,
    gameStartedAt: null,
    questionsPlayedThisGame: 0,
    hostIsPlayer: Boolean(addSelfAsPlayer),
    // Host asks the first question in host-as-player rooms; set up-front so the lobby UI already knows the asker.
    askingPlayerId: (addSelfAsPlayer && !isQuestionPoolMode) ? hostId : null,
    lastAskerId: (addSelfAsPlayer && !isQuestionPoolMode) ? hostId : null,
    pendingNextAskerId: null,
    // Mutually exclusive with hostIsPlayer or questionPoolMode:
    allowPlayerSuggestions: (addSelfAsPlayer || isQuestionPoolMode) ? false : Boolean(allowPlayerSuggestions),
    suggestedQuestions: [],
    questionPoolMode: isQuestionPoolMode,
    poolQuestions: [],
    questionPool: [],
    currentPoolQuestionIndex: 0,
    hostReady: false,
    roundEndConfirmedIds: [],
    guessFlowMode: normalizeGuessFlowMode(guessFlowMode),
    matchingBoard: [],
    matchingTokenOrder: [],
    matches: [],
    matchingConfirmedIds: [],
  };

  if (room.hostIsPlayer) {
    room.players.push({
      id: hostId,
      name: normalizedHostName,
      score: 0,
      avatar: normalizedHostAvatar,
      reconnectToken: null,
      disconnectedAt: null,
      ready: false,
    });
  }

  room.finalMatchup = null;
  rooms.set(code, room);
  return room;
}

function clearGuessTimeout(room) {
  if (room.guessTimeoutHandle) {
    clearTimeout(room.guessTimeoutHandle);
    room.guessTimeoutHandle = null;
  }
  room.guessDeadlineMs = null;
}

function clearGuessCountdown(room) {
  if (room.guessCountdownHandle) {
    clearTimeout(room.guessCountdownHandle);
    room.guessCountdownHandle = null;
  }
  room.guessCountdownEndsAt = null;
}

function armGuessTimeout(room) {
  clearGuessTimeout(room);
  room.guessDeadlineMs = Date.now() + room.guessTimeoutSeconds * 1000;
  room.guessTimeoutHandle = setTimeout(() => {
    calculateRoundScores(room);
  }, room.guessTimeoutSeconds * 1000);
  room.guessTimeoutHandle.unref?.();
}

function addPlayerToRoom(room, name, avatar) {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    return null;
  }

  const isDuplicate = room.players.some(
    (player) => player.name.toLowerCase() === trimmed.toLowerCase(),
  );

  if (isDuplicate) {
    return null;
  }

  const player = {
    id: `${room.code}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: trimmed,
    score: 0,
    avatar: normalizeAvatar(avatar),
    reconnectToken: createReconnectToken(),
    disconnectedAt: null,
    ready: false,
  };

  room.players.push(player);
  return player;
}

function leaveRoom(room, playerId) {
  const playerIndex = room.players.findIndex((player) => player.id === playerId);
  if (playerIndex === -1) {
    return null;
  }

  const [removedPlayer] = room.players.splice(playerIndex, 1);

  if (room.phase === 'lobby' && room.poolQuestions) {
    room.poolQuestions = room.poolQuestions.filter((q) => q.playerId !== playerId);
  }

  [...room.clients].forEach((client) => {
    if (client.playerId === playerId) {
      room.clients.delete(client);
      client.roomCode = null;
      client.playerId = null;
    }
  });

  if (!room.hostId && room.players.length === 0) {
    rooms.delete(room.code);
  }

  return removedPlayer;
}

// Host-initiated removal of an unresponsive player, distinct from a voluntary leave-room.
function kickPlayer(room, playerId) {
  const player = findPlayerById(room, playerId);
  if (!player) {
    return null;
  }

  const wasCurrentAsker = room.hostIsPlayer && !room.questionPoolMode && room.phase === 'asking' && room.askingPlayerId === playerId;
  const wasCurrentAnswerOwner = room.phase === 'guessing' && room.currentAnswer && room.currentAnswer.playerId === playerId;

  // Capture sockets before leaveRoom() detaches them, so the kicked client can still be notified.
  const targetClients = [...room.clients].filter((client) => client.playerId === playerId);

  const removedPlayer = leaveRoom(room, playerId);
  if (!removedPlayer) {
    return null;
  }

  targetClients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: 'kicked' }));
    }
  });

  if (wasCurrentAnswerOwner) {
    // Same as a guess-timeout: score whatever guesses already came in, then proceed to round-end.
    calculateRoundScores(room);
  } else if (wasCurrentAsker) {
    if (room.players.length >= 4) {
      const nextAskerId = pickNextAsker(room);
      room.askingPlayerId = nextAskerId;
      room.lastAskerId = nextAskerId;
      room.pendingNextAskerId = null;
    } else {
      room.phase = 'game-end';
      room.timeLeft = 0;
    }
  }

  return removedPlayer;
}

function closeRoom(room) {
  if (!room || rooms.get(room.code) !== room) {
    return false;
  }

  emitGameEndedIfInProgress(room);
  clearGuessTimeout(room);
  clearGuessCountdown(room);
  rooms.delete(room.code);
  room.hostReconnectToken = null;
  room.hostDisconnectedAt = null;
  room.players.forEach((player) => {
    player.reconnectToken = null;
    player.disconnectedAt = null;
  });

  [...room.clients].forEach((client) => {
    client.roomCode = null;
    client.playerId = null;

    if (client.readyState !== 1) {
      client.close();
      return;
    }

    // Wait for the send to actually flush before closing, otherwise close() can race ahead of it
    // (e.g. under permessage-deflate/backpressure) and the client never sees the room-closed message.
    client.send(JSON.stringify({ type: 'room-closed' }), () => {
      client.close();
    });
  });

  room.clients.clear();
  return true;
}

function startRound(room, customQuestion = '') {
  if (room.players.length < 1) {
    return;
  }
  // Guessing requires at least 3 submitted answers, so at least that many non-asker players are needed.
  if (room.hostIsPlayer && !room.questionPoolMode && room.players.length < 4) {
    return;
  }
  if (!room.hostIsPlayer && room.players.length < 3) {
    return;
  }

  let trimmedQuestion = (customQuestion || '').trim();

  if (room.phase === 'lobby') {
    if (room.questionPoolMode) {
      if (!canStartGame(room)) {
        return;
      }
      room.questionPool = shuffle(room.poolQuestions);
      room.currentPoolQuestionIndex = 0;
      trimmedQuestion = room.questionPool[0]?.text || '';
    }

    room.gameStartedAt = Date.now();
    room.questionsPlayedThisGame = 0;
    if (room.hostIsPlayer && !room.questionPoolMode) {
      room.askingPlayerId = room.hostId;
      room.lastAskerId = room.hostId;
    } else if (room.questionPoolMode) {
      room.askingPlayerId = null;
      room.lastAskerId = null;
    }
    logger.event('game-started', { roomCode: room.code, participantCount: room.players.length });
  }

  const selectedQuestion = trimmedQuestion || (room.questionPool && room.questionPool[room.currentPoolQuestionIndex]?.text) || questionBank[Math.floor(Math.random() * questionBank.length)];

  room.questionsPlayedThisGame += 1;
  room.pendingNextAskerId = null;
  room.answerRoundNumber = 1;
  room.phase = 'answer-collection';
  room.question = selectedQuestion;
  room.selectedAnswer = '';
  room.answerAuthorId = null;
  room.answers = [];
  room.guesses = [];
  room.answerQueue = [];
  room.currentAnswer = null;
  room.roundResults = [];
  room.activeGuesserIndex = 0;
  room.playerTurnIndex = 0;
  room.timeLeft = 0;
  room.finalMatchup = null;
  room.matchingBoard = [];
  room.matchingTokenOrder = [];
  room.matches = [];

  room.players.forEach((player) => {
    player.score = player.score || 0;
  });

  // The question actually used is no longer pending, whether it came from the textarea or a picked suggestion.
  room.suggestedQuestions = room.suggestedQuestions.filter((entry) => entry.text !== selectedQuestion);

  broadcastRoom(room);
}

// Score leader asks the next question; ties prefer someone other than whoever asked most recently.
function pickNextAsker(room) {
  const maxScore = Math.max(...room.players.map((player) => player.score));
  const leaders = room.players.filter((player) => player.score === maxScore);

  if (leaders.length === 1) {
    return leaders[0].id;
  }

  const withoutLastAsker = leaders.filter((player) => player.id !== room.lastAskerId);
  return (withoutLastAsker[0] || leaders[0]).id;
}

// Between questions in a host-as-player room: hands the "ask" duty to the score leader without resetting the game.
function continueToNextQuestion(room) {
  // Same minimum as startRound: guessing needs at least 3 non-asker players.
  if (room.players.length < 4) {
    return;
  }

  clearGuessTimeout(room);
  clearGuessCountdown(room);

  const nextAskerId = pickNextAsker(room);
  room.askingPlayerId = nextAskerId;
  room.lastAskerId = nextAskerId;
  room.pendingNextAskerId = null;
  room.phase = 'asking';
  room.answerRoundNumber = 0;
  room.answerAuthorId = null;
  room.selectedAnswer = '';
  room.activeGuesserIndex = 0;
  room.playerTurnIndex = 0;
  room.timeLeft = 0;
  room.answers = [];
  room.guesses = [];
  room.answerQueue = [];
  room.currentAnswer = null;
  room.roundResults = [];
  room.finalMatchup = null;
  room.matchingBoard = [];
  room.matchingTokenOrder = [];
  room.matches = [];

  broadcastRoom(room);
}

function startNewGame(room) {
  emitGameEndedIfInProgress(room);
  clearGuessTimeout(room);
  clearGuessCountdown(room);
  room.phase = 'lobby';
  room.answerRoundNumber = 0;
  room.question = '';
  room.answerAuthorId = null;
  room.selectedAnswer = '';
  room.activeGuesserIndex = 0;
  room.playerTurnIndex = 0;
  room.timeLeft = 0;
  room.answers = [];
  room.guesses = [];
  room.answerQueue = [];
  room.currentAnswer = null;
  room.roundResults = [];
  room.finalMatchup = null;
  room.matchingBoard = [];
  room.matchingTokenOrder = [];
  room.matches = [];
  room.poolQuestions = [];
  room.questionPool = [];
  room.currentPoolQuestionIndex = 0;
  room.hostReady = false;
  room.players.forEach((player) => {
    player.ready = false;
  });
  // player scores are intentionally left untouched so totals keep aggregating across games

  broadcastRoom(room);
}

// Fires once per game regardless of which of the 3 end triggers (game-end/new-game/close-room) hits first.
function emitGameEndedIfInProgress(room) {
  if (!room.gameStartedAt) {
    return;
  }

  logger.event('game-ended', {
    roomCode: room.code,
    durationMs: Date.now() - room.gameStartedAt,
    participantCount: room.players.length,
    questionsPlayed: room.questionsPlayedThisGame,
  });
  room.gameStartedAt = null;
}

function prepareCurrentAnswer(room) {
  if (room.answerQueue.length === 0) {
    room.currentAnswer = null;
    room.phase = 'game-end';
    room.pendingNextAskerId = room.hostIsPlayer ? pickNextAsker(room) : null;
    room.timeLeft = 0;
    room.answerAuthorId = null;
    room.selectedAnswer = '';
    room.finalMatchup = null;
    clearGuessTimeout(room);
    clearGuessCountdown(room);
    emitGameEndedIfInProgress(room);
    broadcastRoom(room);
    return;
  }

  // Exactly 2 answers left would otherwise mean a single-candidate, zero-suspense final guess - pair them up instead.
  if (room.answerQueue.length === 2) {
    const [answerA, answerB] = room.answerQueue.splice(0, 2);
    room.currentAnswer = null;
    room.answerAuthorId = null;
    room.selectedAnswer = '';
    room.guesses = [];
    room.activeGuesserIndex = 0;
    room.answerRoundNumber = room.answers.length;
    room.timeLeft = 0;
    room.finalMatchup = {
      answers: [
        { slot: 'A', text: answerA.text },
        { slot: 'B', text: answerB.text },
      ],
      // Shuffled so the display order never hints at the true pairing.
      authorIds: Math.random() < 0.5 ? [answerA.playerId, answerB.playerId] : [answerB.playerId, answerA.playerId],
      truth: { A: answerA.playerId, B: answerB.playerId },
      autoRevealed: false,
    };

    const eligibleGuesserCount = room.players.filter(
      (player) => player.id !== room.askingPlayerId && player.id !== answerA.playerId && player.id !== answerB.playerId,
    ).length;

    clearGuessTimeout(room);
    clearGuessCountdown(room);

    if (eligibleGuesserCount === 0) {
      // Both remaining authors already know the pairing and nobody else is left to guess - nothing to score.
      room.finalMatchup.autoRevealed = true;
      room.roundResults = [];
      room.phase = 'round-end';
      room.roundEndConfirmedIds = [];
      broadcastRoom(room);
      return;
    }

    room.guessCountdownEndsAt = Date.now() + GUESS_COUNTDOWN_MS;
    room.guessCountdownHandle = setTimeout(() => {
      room.guessCountdownHandle = null;
      room.guessCountdownEndsAt = null;
      armGuessTimeout(room);
      broadcastRoom(room);
    }, GUESS_COUNTDOWN_MS);
    room.guessCountdownHandle.unref?.();
    broadcastRoom(room);
    return;
  }

  const randomIndex = Math.floor(Math.random() * room.answerQueue.length);
  const [currentAnswer] = room.answerQueue.splice(randomIndex, 1);

  room.currentAnswer = currentAnswer;

  room.answerAuthorId = currentAnswer.playerId;
  room.selectedAnswer = currentAnswer.text;
  room.guesses = [];
  room.activeGuesserIndex = 0;
  room.answerRoundNumber = (room.answers.length || room.answerQueue.length + 1) - room.answerQueue.length;
  room.timeLeft = 0;

  // Play a celebratory countdown before the real guess timer starts, so players don't lose guessing time to it.
  clearGuessTimeout(room);
  clearGuessCountdown(room);
  room.guessCountdownEndsAt = Date.now() + GUESS_COUNTDOWN_MS;
  room.guessCountdownHandle = setTimeout(() => {
    room.guessCountdownHandle = null;
    room.guessCountdownEndsAt = null;
    armGuessTimeout(room);
    broadcastRoom(room);
  }, GUESS_COUNTDOWN_MS);
  room.guessCountdownHandle.unref?.();
  broadcastRoom(room);
}

function lockAnswers(room) {
  // A pool of 1-2 answers can only ever produce trivial single-candidate guesses - require at least 3.
  if (room.phase !== 'answer-collection' || room.answers.length < 3) {
    return;
  }

  if (room.guessFlowMode === 'allAtOnce') {
    buildMatchingBoard(room);
    return;
  }

  room.answerQueue = room.answers.map((answer) => ({ ...answer }));
  room.currentAnswer = null;
  room.phase = 'guessing';
  prepareCurrentAnswer(room);
}

function moveToNextAnswer(room) {
  if (room.answerQueue.length === 0) {
    room.phase = 'leaderboard';
    room.timeLeft = 0;
    room.answerAuthorId = null;
    room.selectedAnswer = '';
    room.roundNumber = room.answerQueue.length;
    broadcastRoom(room);
    return;
  }

  prepareCurrentAnswer(room);
}

function calculateRoundScores(room) {
  clearGuessTimeout(room);
  clearGuessCountdown(room);

  if (room.phase !== 'guessing' || (!room.currentAnswer && !room.finalMatchup)) {
    return;
  }

  const correctPlayerId = room.finalMatchup ? null : room.currentAnswer.playerId;

  let correctRank = 0;
  room.roundResults = room.guesses.map((guess) => {
    const guesser = findPlayerById(room, guess.guesserId);
    const targetAuthorId = room.finalMatchup ? room.finalMatchup.truth[guess.answerSlot] : correctPlayerId;
    const isCorrect = guess.guessedId === targetAuthorId;
    let points = 0;

    if (isCorrect) {
      points = SPEED_TIERS[Math.min(correctRank, SPEED_TIERS.length - 1)];
      correctRank += 1;
    }

    if (guesser && isCorrect) {
      guesser.score += points;
    }

    return {
      guesserName: guess.guesserName,
      guessedName: guess.guessedName,
      correct: isCorrect,
      points,
      ...(room.finalMatchup ? { answerSlot: guess.answerSlot } : {}),
    };
  });

  room.phase = 'round-end';
  room.timeLeft = 0;
  room.roundEndConfirmedIds = [];
  broadcastRoom(room);
}

function advanceGuessRound(room) {
  if (room.phase !== 'round-end') {
    return;
  }

  if (room.answerQueue.length === 0) {
    if (room.questionPoolMode && room.questionPool && room.questionPool.length > 0) {
      room.currentPoolQuestionIndex += 1;
      if (room.currentPoolQuestionIndex < room.questionPool.length) {
        startRound(room, room.questionPool[room.currentPoolQuestionIndex].text);
        return;
      }
    }
    room.phase = 'game-end';
    room.pendingNextAskerId = room.hostIsPlayer ? pickNextAsker(room) : null;
    room.timeLeft = 0;
    room.answerAuthorId = null;
    room.selectedAnswer = '';
    room.finalMatchup = null;
    emitGameEndedIfInProgress(room);
    broadcastRoom(room);
    return;
  }

  room.phase = 'guessing';
  room.guesses = [];
  room.roundResults = [];
  prepareCurrentAnswer(room);
}

function revealAnswer(room) {
  room.phase = 'guessing';
  room.timeLeft = 0;
  if (!room.answerQueue.length) {
    room.answerQueue = room.answers.map((answer) => ({ ...answer }));
  }
  prepareCurrentAnswer(room);
}

function submitAnswer(room, playerId, answerText) {
  if (room.phase !== 'answer-collection') {
    return;
  }

  if (!room.questionPoolMode && playerId === room.askingPlayerId) {
    return;
  }

  const player = findPlayerById(room, playerId);
  if (!player) {
    return;
  }

  const trimmed = (answerText || '').trim();
  if (!trimmed) {
    return;
  }

  const alreadySubmitted = room.answers.some((entry) => entry.playerId === player.id);
  if (alreadySubmitted) {
    return;
  }

  room.answers.push({
    playerId: player.id,
    playerName: player.name,
    text: trimmed,
  });

  broadcastRoom(room);
}

function evaluateGuess(room, guesserId, guessTargetId, answerSlot) {
  if (room.phase !== 'guessing') {
    return;
  }

  const guesser = findPlayerById(room, guesserId);
  const target = findPlayerById(room, guessTargetId);

  if (!guesser || !target || guesserId === room.askingPlayerId || guessTargetId === guesserId) {
    return;
  }

  if (room.finalMatchup) {
    // Both remaining authors already know the true pairing, so they can't guess this round.
    if (
      (answerSlot !== 'A' && answerSlot !== 'B')
      || room.finalMatchup.authorIds.includes(guesserId)
      || !room.finalMatchup.authorIds.includes(guessTargetId)
    ) {
      return;
    }
  } else {
    if (!room.currentAnswer || guesserId === room.currentAnswer.playerId) {
      return;
    }

    // Reject guesses against players already revealed as the correct answer in an earlier round.
    if (!getEligibleGuessTargetIds(room).has(guessTargetId)) {
      return;
    }
  }

  const existingGuess = room.guesses.find((entry) => entry.guesserId === guesserId);
  if (existingGuess) {
    return;
  }

  room.guesses.push({
    guesserId: guesser.id,
    guesserName: guesser.name,
    guessedId: target.id,
    guessedName: target.name,
    correct: false,
    points: 0,
    ...(room.finalMatchup ? { answerSlot } : {}),
  });

  broadcastRoom(room);
}

app.use(cors({ origin: appOrigin, credentials: true }));
app.use(express.json());

app.use((req, res, next) => {
  // Skip static asset GETs (dist/) to keep signal-to-noise high; API/health/rooms paths are what matter operationally.
  if (req.path === '/' || (req.method === 'GET' && !req.path.startsWith('/auth/') && req.path !== '/health' && req.path !== '/rooms')) {
    next();
    return;
  }

  const startedAt = Date.now();
  res.on('finish', () => {
    logger.info('http-request', {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });
  next();
});

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter(([key, value]) => key && value),
  );
}

function setSessionCookie(response, token) {
  const flags = [
    `${sessionCookieName}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${60 * 60 * 24 * 30}`,
  ];
  if (isProduction) flags.push('Secure');
  response.setHeader('Set-Cookie', flags.join('; '));
}

function clearSessionCookie(response) {
  response.setHeader('Set-Cookie', `${sessionCookieName}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function requestUser(request) {
  return authService.getUserBySession(parseCookies(request.headers.cookie)[sessionCookieName]);
}

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

app.post('/auth/signup', authRateLimiter, (req, res) => {
  const result = authService.signUp(req.body?.email, req.body?.password);
  if (result.error) {
    logger.warn('auth-signup-failed', { code: result.code });
    res.status(400).json({ error: result.error });
    return;
  }
  logger.event('auth-signup-succeeded', { userId: result.user?.id });
  res.status(201).json({ user: result.user, emailVerificationRequired: true });
});

app.post('/auth/login', authRateLimiter, (req, res) => {
  const result = authService.login(req.body?.email, req.body?.password);
  if (result.error) {
    logger.warn('auth-login-failed', { code: result.code });
    res.status(result.code === 'EMAIL_NOT_VERIFIED' ? 403 : 401).json({ error: result.error, code: result.code });
    return;
  }
  logger.event('auth-login-succeeded', { userId: result.user?.id });
  setSessionCookie(res, result.token);
  res.json({ user: result.user });
});

app.post('/auth/e2e-login', (req, res) => {
  if (process.env.NODE_ENV === 'production' || process.env.E2E_TEST_MODE !== 'true') {
    res.status(404).end();
    return;
  }

  const result = authService.ensureVerifiedUser(req.body?.email, req.body?.password);
  if (result.error) {
    res.status(400).json({ error: result.error });
    return;
  }

  const loginResult = authService.login(req.body?.email, req.body?.password);
  if (loginResult.error) {
    res.status(401).json({ error: loginResult.error });
    return;
  }

  setSessionCookie(res, loginResult.token);
  res.json({ user: loginResult.user });
});

app.post('/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[sessionCookieName];
  authService.logout(token);
  clearSessionCookie(res);
  res.status(204).end();
});

app.get('/auth/session', (req, res) => {
  const user = requestUser(req);
  res.json({ user: user ? { ...user, isAdmin: isAdminEmail(user.email) } : null });
});

function requireAdmin(req, res, next) {
  const user = requestUser(req);
  if (!user || !isAdminEmail(user.email)) {
    res.status(403).json({ error: 'Admin access required.' });
    return;
  }
  next();
}

function requireAuth(req, res, next) {
  const user = requestUser(req);
  if (!user) {
    res.status(401).json({ error: 'Log in required.' });
    return;
  }
  req.authUser = user;
  next();
}

app.get('/questions', (req, res) => {
  res.json({ questions: questionService.listQuestions(normalizeLanguage(req.query.language)) });
});

app.post('/admin/questions', requireAdmin, (req, res) => {
  const result = questionService.addQuestion(req.body?.language, req.body?.text, req.body?.translationGroupId);
  if (result.error) {
    res.status(400).json({ error: result.error });
    return;
  }
  const isLinkedTranslation = Boolean(req.body?.translationGroupId) && req.body.translationGroupId !== result.question.id;
  logger.event('admin-question-added', { language: req.body?.language, isLinkedTranslation });
  res.status(201).json({ question: result.question });
});

app.post('/admin/questions/translate-preview', requireAdmin, async (req, res) => {
  const source = questionService.getQuestionById(req.body?.id);
  if (!source) {
    res.status(404).json({ error: 'Question not found.' });
    return;
  }

  const [targetLanguage] = otherSupportedLanguages(source.language);
  if (!targetLanguage) {
    res.status(400).json({ error: 'No other supported language to translate into.' });
    return;
  }

  const result = await translateText(source.text, source.language, targetLanguage);
  if (result.error) {
    res.status(502).json({ error: result.error });
    return;
  }

  res.json({ targetLanguage, translatedText: result.text });
});

app.delete('/admin/questions/:id', requireAdmin, (req, res) => {
  const deleted = questionService.deleteQuestion(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Question not found.' });
    return;
  }
  logger.event('admin-question-deleted', { id: req.params.id });
  res.status(204).end();
});

app.get('/my-questions', requireAuth, (req, res) => {
  res.json({ questions: userQuestionService.listUserQuestions(req.authUser.id, normalizeLanguage(req.query.language)) });
});

app.post('/my-questions', requireAuth, (req, res) => {
  const result = userQuestionService.addUserQuestion(req.authUser.id, req.body?.language, req.body?.text);
  if (result.error) {
    res.status(400).json({ error: result.error });
    return;
  }
  logger.event('user-question-added', { userId: req.authUser.id, language: req.body?.language });
  res.status(201).json({ question: result.question });
});

app.delete('/my-questions/:id', requireAuth, (req, res) => {
  const deleted = userQuestionService.deleteUserQuestion(req.authUser.id, req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Question not found.' });
    return;
  }
  logger.event('user-question-deleted', { userId: req.authUser.id, id: req.params.id });
  res.status(204).end();
});

app.post('/auth/verify-email', (req, res) => {
  if (!authService.verifyEmail(req.body?.token)) {
    res.status(400).json({ error: 'This verification link is invalid or expired.' });
    return;
  }
  res.json({ verified: true });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

app.get('/rooms', (req, res) => {
  const summary = [...rooms.values()].map((room) => ({
    code: room.code,
    players: room.players.length,
    phase: room.phase,
    roundNumber: room.roundNumber,
  }));

  res.json(summary);
});

// Serve the built frontend (single App Service hosts both frontend and API/WS).
app.use(express.static(distDirectory));
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/auth/') || req.path === '/health' || req.path === '/rooms') {
    next();
    return;
  }

  res.sendFile(path.join(distDirectory, 'index.html'), (err) => {
    if (err) next(err);
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('unhandled-request-error', { error: err, path: req.path, method: req.method });
  res.status(500).json({ error: 'Internal server error' });
});

wss.on('connection', (socket, request) => {
  socket.user = requestUser(request);

  socket.on('error', (error) => {
    logger.error('websocket-error', { error, roomCode: socket.roomCode, playerId: socket.playerId });
  });

  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      const room = message.roomCode ? findRoomByCode(message.roomCode) : null;

      switch (message.type) {
        case 'reconnect-room': {
          if (!room) {
            socket.send(JSON.stringify({ type: 'error', code: 'ROOM_SESSION_EXPIRED', message: 'This room is no longer available.' }));
            return;
          }

          const membership = reconnectRoom(room, socket, message);
          if (!membership) {
            socket.send(JSON.stringify({ type: 'error', code: 'ROOM_SESSION_INVALID', message: 'This room session cannot be restored.' }));
            return;
          }

          sendRoomSession(socket, room, membership.role, membership.playerId, membership.playerName, membership.reconnectToken);
          socket.send(JSON.stringify({ type: 'room-state', state: makeRoomState(room, membership.playerId) }));
          broadcastRoom(room);
          break;
        }

        case 'create-room': {
          const roomData = createRoom({
            hostName: message.name || 'Host',
            hostAccountId: socket.user?.id ?? null,
            language: message.language,
            hostAvatar: message.avatar,
            guessTimeoutSeconds: message.guessTimeoutSeconds,
            addSelfAsPlayer: message.addSelfAsPlayer,
            allowPlayerSuggestions: message.allowPlayerSuggestions,
            questionPoolMode: message.questionPoolMode,
            guessFlowMode: message.guessFlowMode,
          });
          attachSocketToRoom(roomData, socket, roomData.hostId);
          sendRoomSession(socket, roomData, 'host', roomData.hostId, roomData.hostName, roomData.hostReconnectToken);
          socket.send(JSON.stringify({ type: 'room-state', state: makeRoomState(roomData, roomData.hostId) }));
          logger.event('room-created', { roomCode: roomData.code, language: roomData.language });
          break;
        }

        case 'join-room': {
          const targetRoom = findRoomByCode(message.roomCode);
          if (!targetRoom) {
            socket.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
            return;
          }

          const player = addPlayerToRoom(targetRoom, message.name || 'Guest', message.avatar);
          if (!player) {
            socket.send(JSON.stringify({ type: 'error', message: 'Duplicate player name or invalid input' }));
            return;
          }

          attachSocketToRoom(targetRoom, socket, player.id);
          sendRoomSession(socket, targetRoom, 'player', player.id, player.name, player.reconnectToken);
          logger.event('room-joined', { roomCode: targetRoom.code, playerId: player.id });
          broadcastRoom(targetRoom);
          break;
        }

        case 'leave-room': {
          if (!room || !socket.playerId || room.hostId === socket.playerId) {
            return;
          }

          const removedPlayer = leaveRoom(room, socket.playerId);
          if (!removedPlayer) {
            return;
          }

          socket.send(JSON.stringify({ type: 'left-room' }));
          logger.event('room-left', { roomCode: room.code, playerId: removedPlayer.id });

          if (rooms.get(message.roomCode)) {
            broadcastRoom(room);
            room.clients.forEach((client) => {
              if (client.readyState === 1) {
                client.send(JSON.stringify({ type: 'player-left', playerName: removedPlayer.name }));
              }
            });
          }
          break;
        }

        case 'close-room': {
          if (!room || room.hostId !== socket.playerId) {
            return;
          }

          logger.event('room-closed', { roomCode: room.code });
          closeRoom(room);
          break;
        }

        case 'kick-player': {
          if (!room || room.hostId !== socket.playerId) {
            return;
          }

          if (!message.playerId || message.playerId === room.hostId) {
            return;
          }

          const kickedPlayer = kickPlayer(room, message.playerId);
          if (!kickedPlayer) {
            return;
          }

          logger.event('player-kicked', { roomCode: room.code, playerId: kickedPlayer.id });
          broadcastRoom(room);
          room.clients.forEach((client) => {
            if (client.readyState === 1) {
              client.send(JSON.stringify({ type: 'player-kicked', playerName: kickedPlayer.name }));
            }
          });
          break;
        }

        case 'start-round': {
          // In host-as-player rooms without questionPoolMode, the current asker starts the round.
          const canStartRound = room && (
            room.questionPoolMode
              ? room.hostId === socket.playerId
              : (room.hostIsPlayer
                  ? socket.playerId === room.askingPlayerId
                  : room.hostId === socket.playerId)
          );
          if (!canStartRound) {
            return;
          }

          if (room.phase === 'lobby' && !canStartGame(room)) {
            socket.send(JSON.stringify({ type: 'error', message: 'Cannot start game yet. Ensure all players are ready and at least one question is submitted.' }));
            return;
          }

          logger.event('round-started', { roomCode: room.code });
          startRound(room, message.question || '');
          break;
        }

        case 'reveal-answer': {
          if (!room || room.hostId !== socket.playerId) {
            return;
          }
          revealAnswer(room);
          break;
        }

        case 'suggest-question': {
          if (!canSuggestQuestion(room, socket.playerId)) {
            return;
          }
          const player = findPlayerById(room, socket.playerId);
          const suggestion = addSuggestedQuestion(room, socket.playerId, player.name, message.text);
          if (!suggestion) {
            socket.send(JSON.stringify({ type: 'error', message: 'Question must be between 8 and 220 characters.' }));
            return;
          }
          logger.event('question-suggested', { roomCode: room.code, playerId: socket.playerId });
          broadcastRoom(room);
          break;
        }

        case 'delete-suggestion': {
          if (!canDeleteSuggestion(room, message.suggestionId, socket.playerId)) {
            return;
          }
          removeSuggestedQuestion(room, message.suggestionId);
          broadcastRoom(room);
          break;
        }

        case 'dismiss-suggestion': {
          if (!canDismissSuggestion(room, socket.playerId)) {
            return;
          }
          removeSuggestedQuestion(room, message.suggestionId);
          broadcastRoom(room);
          break;
        }

        case 'submit-pool-question': {
          if (!canSubmitPoolQuestion(room, socket.playerId)) {
            return;
          }
          const isHost = socket.playerId === room.hostId;
          const player = findPlayerById(room, socket.playerId);
          const playerName = player ? player.name : (isHost ? room.hostName : 'Player');
          const question = addPoolQuestion(room, socket.playerId, playerName, message.text);
          if (!question) {
            socket.send(JSON.stringify({ type: 'error', message: 'Question must be between 8 and 220 characters.' }));
            return;
          }
          logger.event('pool-question-submitted', { roomCode: room.code, playerId: socket.playerId });
          broadcastRoom(room);
          break;
        }

        case 'delete-pool-question': {
          if (!canDeletePoolQuestion(room, message.questionId, socket.playerId)) {
            return;
          }
          deletePoolQuestion(room, message.questionId);
          logger.event('pool-question-deleted', { roomCode: room.code, playerId: socket.playerId, questionId: message.questionId });
          broadcastRoom(room);
          break;
        }

        case 'discard-pool-question': {
          if (!canDiscardPoolQuestion(room, socket.playerId)) {
            return;
          }
          const discarded = discardPoolQuestion(room, message.questionId);
          if (discarded) {
            logger.event('pool-question-discarded', { roomCode: room.code, questionId: message.questionId });
            broadcastRoom(room);
          }
          break;
        }

        case 'confirm-no-more-questions': {
          if (!room || room.phase !== 'lobby' || !socket.playerId) {
            return;
          }
          const isReady = message.isReady !== undefined ? Boolean(message.isReady) : true;
          setPlayerReady(room, socket.playerId, isReady);
          logger.event('player-ready-toggled', { roomCode: room.code, playerId: socket.playerId, isReady });
          broadcastRoom(room);
          break;
        }

        case 'lock-answers': {
          // In host-as-player rooms without questionPoolMode, the current asker locks answers.
          const canLockAnswers = room && (
            room.questionPoolMode
              ? room.hostId === socket.playerId
              : (room.hostIsPlayer
                  ? socket.playerId === room.askingPlayerId
                  : room.hostId === socket.playerId)
          );
          if (!canLockAnswers) {
            return;
          }
          lockAnswers(room);
          break;
        }

        case 'calculate-score': {
          // In host-as-player rooms without questionPoolMode, the current asker stops the timer.
          const canCalculateScore = room && (
            room.questionPoolMode
              ? room.hostId === socket.playerId
              : (room.hostIsPlayer
                  ? socket.playerId === room.askingPlayerId
                  : room.hostId === socket.playerId)
          );
          if (!canCalculateScore) {
            return;
          }
          calculateRoundScores(room);
          break;
        }

        case 'confirm-next-round': {
          if (!canConfirmNextRound(room, socket.playerId)) {
            return;
          }
          if (!room.roundEndConfirmedIds.includes(socket.playerId)) {
            room.roundEndConfirmedIds.push(socket.playerId);
          }
          logger.event('round-end-confirmed', { roomCode: room.code, playerId: socket.playerId });
          broadcastRoom(room);
          if (hasAllRoundEndConfirmed(room)) {
            advanceGuessRound(room);
          }
          break;
        }

        case 'force-advance-round': {
          if (!room || room.phase !== 'round-end' || room.hostId !== socket.playerId) {
            return;
          }
          logger.event('round-force-advanced', { roomCode: room.code });
          advanceGuessRound(room);
          break;
        }

        case 'submit-match': {
          if (!room) {
            return;
          }
          const placed = submitMatch(room, socket.playerId, message.slotId, message.guessedId);
          if (!placed) {
            return;
          }
          broadcastRoom(room);
          if (isMatchingComplete(room)) {
            logger.event('matching-round-completed', { roomCode: room.code });
            calculateAllAtOnceScores(room);
          }
          break;
        }

        case 'remove-match': {
          if (!room || !removeMatch(room, socket.playerId, message.slotId)) {
            return;
          }
          broadcastRoom(room);
          break;
        }

        case 'force-complete-matching': {
          if (!canForceCompleteMatching(room, socket.playerId)) {
            return;
          }
          logger.event('matching-force-completed', { roomCode: room.code });
          calculateAllAtOnceScores(room);
          break;
        }

        case 'submit-question': {
          if (!room || !room.hostIsPlayer || room.phase !== 'asking' || socket.playerId !== room.askingPlayerId) {
            return;
          }
          logger.event('question-submitted', { roomCode: room.code, askingPlayerId: room.askingPlayerId });
          startRound(room, message.question || '');
          break;
        }

        case 'submit-answer': {
          if (!room) {
            return;
          }
          submitAnswer(room, socket.playerId, message.answerText);
          break;
        }

        case 'guess': {
          if (!room) {
            return;
          }
          evaluateGuess(room, socket.playerId, message.targetPlayerId, message.answerSlot);
          break;
        }

        case 'next-round': {
          if (!room || room.hostId !== socket.playerId) {
            return;
          }
          startRound(room);
          break;
        }

        case 'new-game': {
          if (!room || room.hostId !== socket.playerId) {
            return;
          }
          if (room.hostIsPlayer && !room.questionPoolMode) {
            continueToNextQuestion(room);
          } else {
            startNewGame(room);
          }
          break;
        }

        default: {
          socket.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
        }
      }
    } catch (error) {
      logger.warn('websocket-invalid-payload', { error, roomCode: socket.roomCode, playerId: socket.playerId });
      socket.send(JSON.stringify({ type: 'error', message: 'Invalid payload' }));
    }
  });

  socket.on('close', () => {
    if (!socket.roomCode) {
      return;
    }

    const room = findRoomByCode(socket.roomCode);
    if (!room) {
      return;
    }

    room.clients.delete(socket);

    const replacementConnectionExists = [...room.clients].some((client) => client.playerId === socket.playerId);
    if (replacementConnectionExists) {
      return;
    }

    if (room.hostId === socket.playerId) {
      room.hostDisconnectedAt = Date.now();
    } else {
      const player = findPlayerById(room, socket.playerId);
      if (player) {
        player.disconnectedAt = Date.now();
      }
    }

    logger.info('websocket-closed', { roomCode: room.code, playerId: socket.playerId });
    broadcastRoom(room);
  });
});

const membershipCleanup = setInterval(expireDisconnectedMemberships, 60 * 1000);
membershipCleanup.unref();

const activityMetrics = setInterval(() => {
  const totalPlayers = [...rooms.values()].reduce((sum, room) => sum + room.players.length, 0);
  const gamesInProgress = [...rooms.values()].filter((room) => room.gameStartedAt).length;
  appInsights.defaultClient?.trackMetric({ name: 'active-rooms', value: rooms.size });
  appInsights.defaultClient?.trackMetric({ name: 'connected-players', value: totalPlayers });
  appInsights.defaultClient?.trackMetric({ name: 'games-in-progress', value: gamesInProgress });
}, 60 * 1000);
activityMetrics.unref();

// Only start server if not running in test environment
if (process.env.NODE_ENV !== 'test' && !globalThis.__VITEST__) {
  server.listen(PORT, () => {
    logger.info('server-started', { port: PORT });
  });
}

// Export functions for testing
export {
  findPlayerById,
  addPlayerToRoom,
  leaveRoom,
  kickPlayer,
  closeRoom,
  calculateRoundScores,
  evaluateGuess,
  lockAnswers,
  prepareCurrentAnswer,
  advanceGuessRound,
  submitAnswer,
  createRoom,
  createRoomCode,
  findRoomByCode,
  reconnectRoom,
  expireDisconnectedMemberships,
  reconnectGracePeriodMs,
  startRound,
  startNewGame,
  pickNextAsker,
  continueToNextQuestion,
  emitGameEndedIfInProgress,
  makeRoomState,
  getEligibleGuessTargetIds,
  normalizeAvatar,
  normalizeGuessTimeoutSeconds,
  AVATAR_OPTIONS,
  armGuessTimeout,
  clearGuessTimeout,
  clearGuessCountdown,
  GUESS_TIMEOUT_SECONDS,
  GUESS_COUNTDOWN_MS,
  addSuggestedQuestion,
  removeSuggestedQuestion,
  canSuggestQuestion,
  canDeleteSuggestion,
  canDismissSuggestion,
  canSubmitPoolQuestion,
  addPoolQuestion,
  canDeletePoolQuestion,
  deletePoolQuestion,
  canDiscardPoolQuestion,
  discardPoolQuestion,
  setPlayerReady,
  canStartGame,
  broadcastRoom,
  getRoundEndConfirmerIds,
  hasAllRoundEndConfirmed,
  canConfirmNextRound,
  normalizeGuessFlowMode,
  shuffle,
  getEligibleMatcherIds,
  isMatchingComplete,
  canSubmitMatch,
  submitMatch,
  removeMatch,
  canForceCompleteMatching,
  calculateAllAtOnceScores,
  buildMatchingBoard,
};

// Graceful shutdown for testing
if (import.meta.env?.VITEST) {
  server.close();
}
