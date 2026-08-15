import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createAuthService } from './auth.js';
import { sendVerificationEmail } from './emailService.js';

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
  sendVerificationEmail: ({ email, token }) => {
    const link = `${appOrigin}/?verify=${encodeURIComponent(token)}`;

    sendVerificationEmail({ email, link })
      .then((sent) => {
        if (!sent && !isProduction) {
          console.log(`Verification link for ${email}: ${link}`);
        }
      })
      .catch((error) => {
        console.error('Failed to send verification email:', error);
      });
  },
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

function normalizeLanguage(language) {
  return supportedLanguages.has(language) ? language : 'en';
}

function createRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';

  for (let index = 0; index < 6; index += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

function safePlayer(player) {
  return {
    id: player.id,
    name: player.name,
    score: player.score,
  };
}

function makeRoomState(room) {
  return {
    code: room.code,
    phase: room.phase,
    answerRoundNumber: room.answerRoundNumber,
    question: room.question,
    answerAuthorId: room.answerAuthorId,
    selectedAnswer: room.selectedAnswer,
    activeGuesserIndex: room.activeGuesserIndex,
    timeLeft: room.timeLeft,
    players: room.players.map(safePlayer),
    answers: room.answers,
    guesses: room.guesses,
    roundResults: room.roundResults,
    hostId: room.hostId,
    language: room.language,
  };
}

function broadcastRoom(room) {
  const payload = JSON.stringify({ type: 'room-state', state: makeRoomState(room) });

  room.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(payload);
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
    if (!socket.user || room.hostAccountId !== socket.user.id || room.hostReconnectToken !== reconnectToken) {
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

function createRoom({ hostName, hostAccountId = null, language = 'en' }) {
  const code = createRoomCode();
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
    hostId: `${code}-host-${Date.now()}`,
    hostAccountId,
    hostName: (hostName || 'Host').trim() || 'Host',
    hostReconnectToken: createReconnectToken(),
    hostDisconnectedAt: null,
    playerTurnIndex: 0,
    language: normalizeLanguage(language),
  };

  rooms.set(code, room);
  return room;
}

function addPlayerToRoom(room, name) {
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
    reconnectToken: createReconnectToken(),
    disconnectedAt: null,
  };

  room.players.push(player);
  return player;
}

function startRound(room, customQuestion = '') {
  if (room.players.length < 1) {
    return;
  }

  const trimmedQuestion = (customQuestion || '').trim();
  const selectedQuestion = trimmedQuestion || questionBank[Math.floor(Math.random() * questionBank.length)];

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

  room.players.forEach((player) => {
    player.score = player.score || 0;
  });

  broadcastRoom(room);
}

function startNewGame(room) {
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
  // player scores are intentionally left untouched so totals keep aggregating across games

  broadcastRoom(room);
}

function prepareCurrentAnswer(room) {
  if (room.answerQueue.length === 0) {
    room.currentAnswer = null;
    room.phase = 'game-end';
    room.timeLeft = 0;
    room.answerAuthorId = null;
    room.selectedAnswer = '';
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
  broadcastRoom(room);
}

function lockAnswers(room) {
  if (room.phase !== 'answer-collection' || room.answers.length === 0) {
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
  if (room.phase !== 'guessing' || !room.currentAnswer) {
    return;
  }

  const answerEntry = room.currentAnswer;
  const correctPlayerId = answerEntry.playerId;

  room.roundResults = room.guesses.map((guess) => {
    const guesser = findPlayerById(room, guess.guesserId);
    const isCorrect = guess.guessedId === correctPlayerId;
    const points = isCorrect ? 120 : 0;

    if (guesser && isCorrect) {
      guesser.score += points;
    }

    return {
      guesserName: guess.guesserName,
      guessedName: guess.guessedName,
      correct: isCorrect,
      points,
    };
  });

  room.phase = 'round-end';
  room.timeLeft = 0;
  broadcastRoom(room);
}

function advanceGuessRound(room) {
  if (room.phase !== 'round-end') {
    return;
  }

  if (room.answerQueue.length === 0) {
    room.phase = 'game-end';
    room.timeLeft = 0;
    room.answerAuthorId = null;
    room.selectedAnswer = '';
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

function evaluateGuess(room, guesserId, guessTargetId) {
  if (room.phase !== 'guessing') {
    return;
  }

  const currentAnswer = room.currentAnswer;
  const guesser = findPlayerById(room, guesserId);
  const target = findPlayerById(room, guessTargetId);

  if (!currentAnswer || !guesser || !target) {
    return;
  }

  if (guesserId === room.hostId || guesserId === currentAnswer.playerId || guessTargetId === guesserId) {
    return;
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
  });

  broadcastRoom(room);
}

app.use(cors({ origin: appOrigin, credentials: true }));
app.use(express.json());

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
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(201).json({ user: result.user, emailVerificationRequired: true });
});

app.post('/auth/login', authRateLimiter, (req, res) => {
  const result = authService.login(req.body?.email, req.body?.password);
  if (result.error) {
    res.status(result.code === 'EMAIL_NOT_VERIFIED' ? 403 : 401).json({ error: result.error, code: result.code });
    return;
  }
  setSessionCookie(res, result.token);
  res.json({ user: result.user });
});

app.post('/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[sessionCookieName];
  authService.logout(token);
  clearSessionCookie(res);
  res.status(204).end();
});

app.get('/auth/session', (req, res) => {
  res.json({ user: requestUser(req) });
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

wss.on('connection', (socket, request) => {
  socket.user = requestUser(request);
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
          socket.send(JSON.stringify({ type: 'room-state', state: makeRoomState(room) }));
          broadcastRoom(room);
          break;
        }

        case 'create-room': {
          if (!socket.user) {
            socket.send(JSON.stringify({ type: 'error', code: 'AUTH_REQUIRED', message: 'Log in to create a room.' }));
            return;
          }
          const roomData = createRoom({ hostName: message.name || 'Host', hostAccountId: socket.user.id, language: message.language });
          attachSocketToRoom(roomData, socket, roomData.hostId);
          sendRoomSession(socket, roomData, 'host', roomData.hostId, roomData.hostName, roomData.hostReconnectToken);
          socket.send(JSON.stringify({ type: 'room-state', state: makeRoomState(roomData) }));
          break;
        }

        case 'join-room': {
          const targetRoom = findRoomByCode(message.roomCode);
          if (!targetRoom) {
            socket.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
            return;
          }

          const player = addPlayerToRoom(targetRoom, message.name || 'Guest');
          if (!player) {
            socket.send(JSON.stringify({ type: 'error', message: 'Duplicate player name or invalid input' }));
            return;
          }

          attachSocketToRoom(targetRoom, socket, player.id);
          sendRoomSession(socket, targetRoom, 'player', player.id, player.name, player.reconnectToken);
          broadcastRoom(targetRoom);
          break;
        }

        case 'start-round': {
          if (!room || room.hostAccountId !== socket.user?.id) {
            return;
          }

          startRound(room, message.question || '');
          break;
        }

        case 'reveal-answer': {
          if (!room || room.hostAccountId !== socket.user?.id) {
            return;
          }
          revealAnswer(room);
          break;
        }

        case 'lock-answers': {
          if (!room || room.hostAccountId !== socket.user?.id) {
            return;
          }
          lockAnswers(room);
          break;
        }

        case 'calculate-score': {
          if (!room || room.hostAccountId !== socket.user?.id) {
            return;
          }
          calculateRoundScores(room);
          break;
        }

        case 'advance-answer': {
          if (!room || room.hostAccountId !== socket.user?.id) {
            return;
          }
          advanceGuessRound(room);
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
          evaluateGuess(room, socket.playerId, message.targetPlayerId);
          break;
        }

        case 'next-round': {
          if (!room || room.hostAccountId !== socket.user?.id) {
            return;
          }
          startRound(room);
          break;
        }

        case 'new-game': {
          if (!room || room.hostAccountId !== socket.user?.id) {
            return;
          }
          startNewGame(room);
          break;
        }

        default: {
          socket.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
        }
      }
    } catch (error) {
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

    broadcastRoom(room);
  });
});

const membershipCleanup = setInterval(expireDisconnectedMemberships, 60 * 1000);
membershipCleanup.unref();

// Only start server if not running in test environment
if (process.env.NODE_ENV !== 'test' && !globalThis.__VITEST__) {
  server.listen(PORT, () => {
    console.log(`Guess Party server listening on http://localhost:${PORT}`);
  });
}

// Export functions for testing
export {
  findPlayerById,
  addPlayerToRoom,
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
  makeRoomState,
};

// Graceful shutdown for testing
if (import.meta.env?.VITEST) {
  server.close();
}
