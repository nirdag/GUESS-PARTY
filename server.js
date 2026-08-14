import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { WebSocketServer } from 'ws';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = process.env.PORT || 8080;
const questionBank = [
  'What is the best way to spend a perfect family night?',
  'What is the most fun way to surprise a friend on a weekend?',
  'What would you choose for the ultimate comfort day?',
  'What is the one thing that makes a group hangout unforgettable?',
  'What is the most comforting thing to do on a rainy day?',
  'What would make a surprise birthday unforgettable?',
];

const rooms = new Map();

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

function createRoom({ hostName }) {
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
    currentAnswerIndex: 0,
    roundResults: [],
    hostId: `${code}-host-${Date.now()}`,
    hostName: (hostName || 'Host').trim() || 'Host',
    playerTurnIndex: 0,
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
  room.currentAnswerIndex = 0;
  room.roundResults = [];
  room.activeGuesserIndex = 0;
  room.playerTurnIndex = 0;
  room.timeLeft = 0;

  room.players.forEach((player) => {
    player.score = player.score || 0;
  });

  broadcastRoom(room);
}

function prepareCurrentAnswer(room) {
  const currentAnswer = room.answerQueue[room.currentAnswerIndex];

  if (!currentAnswer) {
    room.phase = 'game-end';
    room.timeLeft = 0;
    room.answerAuthorId = null;
    room.selectedAnswer = '';
    broadcastRoom(room);
    return;
  }

  room.answerAuthorId = currentAnswer.playerId;
  room.selectedAnswer = currentAnswer.text;
  room.guesses = [];
  room.activeGuesserIndex = 0;
  room.answerRoundNumber = room.currentAnswerIndex + 1;
  room.timeLeft = 0;
  broadcastRoom(room);
}

function lockAnswers(room) {
  if (room.phase !== 'answer-collection' || room.answers.length === 0) {
    return;
  }

  room.answerQueue = room.answers.map((answer) => ({ ...answer }));
  room.currentAnswerIndex = 0;
  room.phase = 'guessing';
  prepareCurrentAnswer(room);
}

function moveToNextAnswer(room) {
  const nextIndex = room.currentAnswerIndex + 1;

  if (nextIndex >= room.answerQueue.length) {
    room.phase = 'leaderboard';
    room.timeLeft = 0;
    room.answerAuthorId = null;
    room.selectedAnswer = '';
    room.roundNumber = room.answerQueue.length;
    broadcastRoom(room);
    return;
  }

  room.currentAnswerIndex = nextIndex;
  prepareCurrentAnswer(room);
}

function calculateRoundScores(room) {
  if (room.phase !== 'guessing' || !room.answerQueue[room.currentAnswerIndex]) {
    return;
  }

  const answerEntry = room.answerQueue[room.currentAnswerIndex];
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
  room.answerRoundNumber = room.currentAnswerIndex + 1;
  broadcastRoom(room);
}

function advanceGuessRound(room) {
  if (room.phase !== 'round-end') {
    return;
  }

  const nextIndex = room.currentAnswerIndex + 1;

  if (nextIndex >= room.answerQueue.length) {
    room.phase = 'game-end';
    room.timeLeft = 0;
    room.answerAuthorId = null;
    room.selectedAnswer = '';
    broadcastRoom(room);
    return;
  }

  room.currentAnswerIndex = nextIndex;
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
  if (!room.answerQueue[room.currentAnswerIndex]) {
    room.currentAnswerIndex = 0;
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

  const currentAnswer = room.answerQueue[room.currentAnswerIndex];
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

app.use(cors());
app.use(express.json());

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

wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      const room = message.roomCode ? findRoomByCode(message.roomCode) : null;

      switch (message.type) {
        case 'create-room': {
          const roomData = createRoom({ hostName: message.name || 'Host' });
          socket.roomCode = roomData.code;
          socket.playerId = roomData.hostId;
          roomData.clients.add(socket);
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

          socket.roomCode = targetRoom.code;
          socket.playerId = player.id;
          targetRoom.clients.add(socket);
          broadcastRoom(targetRoom);
          break;
        }

        case 'start-round': {
          if (!room) {
            return;
          }

          startRound(room, message.question || '');
          break;
        }

        case 'reveal-answer': {
          if (!room) {
            return;
          }
          revealAnswer(room);
          break;
        }

        case 'lock-answers': {
          if (!room) {
            return;
          }
          lockAnswers(room);
          break;
        }

        case 'calculate-score': {
          if (!room) {
            return;
          }
          calculateRoundScores(room);
          break;
        }

        case 'advance-answer': {
          if (!room) {
            return;
          }
          advanceGuessRound(room);
          break;
        }

        case 'submit-answer': {
          if (!room) {
            return;
          }
          submitAnswer(room, message.playerId || socket.playerId, message.answerText);
          break;
        }

        case 'guess': {
          if (!room) {
            return;
          }
          evaluateGuess(room, message.playerId || socket.playerId, message.targetPlayerId);
          break;
        }

        case 'next-round': {
          if (!room) {
            return;
          }
          startRound(room);
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

    if (room.players.length > 0 && socket.playerId) {
      room.players = room.players.filter((player) => player.id !== socket.playerId);
    }

    if (room.hostId === socket.playerId) {
      room.hostId = null;
    }

    if (room.players.length === 0 && !room.hostId) {
      rooms.delete(room.code);
      return;
    }

    broadcastRoom(room);
  });
});

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
};

// Graceful shutdown for testing
if (import.meta.env.VITEST) {
  server.close();
}
