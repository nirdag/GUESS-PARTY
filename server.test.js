import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  findPlayerById,
  addPlayerToRoom,
  leaveRoom,
  closeRoom,
  calculateRoundScores,
  evaluateGuess,
  lockAnswers,
  prepareCurrentAnswer,
  advanceGuessRound,
  submitAnswer,
  createRoom,
  findRoomByCode,
  reconnectRoom,
  expireDisconnectedMemberships,
  reconnectGracePeriodMs,
  startRound,
  startNewGame,
  makeRoomState,
  normalizeAvatar,
  AVATAR_OPTIONS,
  armGuessTimeout,
  clearGuessTimeout,
  GUESS_TIMEOUT_SECONDS,
} from './server.js';

// Mock room/player creation for testing
function createTestRoom() {
  return {
    code: 'TEST12',
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
    hostId: `TEST12-host-${Date.now()}`,
    hostName: 'Host',
    playerTurnIndex: 0,
    guessTimeoutEnabled: false,
    guessDeadlineMs: null,
    guessTimeoutHandle: null,
  };
}

function createTestPlayer(id, name) {
  return { id, name, score: 0 };
}

// ============================================
// TESTS START HERE
// ============================================

describe('CRITICAL: Scoring Logic', () => {
  let room;

  beforeEach(() => {
    room = createTestRoom();
  });

  it('calculateRoundScores awards 120 points for correct guess', () => {
    const player1 = createTestPlayer('p1', 'Alice');
    const player2 = createTestPlayer('p2', 'Bob');
    room.players = [player1, player2];

    room.answerQueue = [{ playerId: 'p1', text: 'test answer', playerName: 'Alice' }];
    room.currentAnswer = room.answerQueue[0];
    room.phase = 'guessing';
    room.guesses = [
      { guesserId: 'p2', guesserName: 'Bob', guessedId: 'p1', guessedName: 'Alice' },
    ];

    calculateRoundScores(room);

    expect(player2.score).toBe(120);
    expect(room.roundResults[0].points).toBe(120);
    expect(room.roundResults[0].correct).toBe(true);
  });

  it('calculateRoundScores awards 0 points for incorrect guess', () => {
    const player1 = createTestPlayer('p1', 'Alice');
    const player2 = createTestPlayer('p2', 'Bob');
    const player3 = createTestPlayer('p3', 'Charlie');
    room.players = [player1, player2, player3];

    room.answerQueue = [{ playerId: 'p1', text: 'test answer', playerName: 'Alice' }];
    room.currentAnswer = room.answerQueue[0];
    room.phase = 'guessing';
    room.guesses = [
      { guesserId: 'p2', guesserName: 'Bob', guessedId: 'p3', guessedName: 'Charlie' },
    ];

    calculateRoundScores(room);

    expect(player2.score).toBe(0);
    expect(room.roundResults[0].points).toBe(0);
    expect(room.roundResults[0].correct).toBe(false);
  });

  it('calculateRoundScores handles multiple guesses', () => {
    const player1 = createTestPlayer('p1', 'Alice');
    const player2 = createTestPlayer('p2', 'Bob');
    const player3 = createTestPlayer('p3', 'Charlie');
    room.players = [player1, player2, player3];

    room.answerQueue = [{ playerId: 'p1', text: 'test answer', playerName: 'Alice' }];
    room.currentAnswer = room.answerQueue[0];
    room.phase = 'guessing';
    room.guesses = [
      { guesserId: 'p2', guesserName: 'Bob', guessedId: 'p1', guessedName: 'Alice' },
      { guesserId: 'p3', guesserName: 'Charlie', guessedId: 'p3', guessedName: 'Charlie' },
    ];

    calculateRoundScores(room);

    expect(player2.score).toBe(120);
    expect(player3.score).toBe(0);
    expect(room.roundResults).toHaveLength(2);
  });

  it('calculateRoundScores transitions to round-end phase', () => {
    const player1 = createTestPlayer('p1', 'Alice');
    room.players = [player1];

    room.answerQueue = [{ playerId: 'p1', text: 'test', playerName: 'Alice' }];
    room.currentAnswer = room.answerQueue[0];
    room.phase = 'guessing';
    room.guesses = [];

    calculateRoundScores(room);

    expect(room.phase).toBe('round-end');
  });

  it('calculateRoundScores does nothing if not in guessing phase', () => {
    room.phase = 'answer-collection';
    room.answerQueue = [];

    calculateRoundScores(room);

    expect(room.phase).toBe('answer-collection');
    expect(room.roundResults).toHaveLength(0);
  });

  it('scores persist across multiple answer rounds', () => {
    const player1 = createTestPlayer('p1', 'Alice');
    const player2 = createTestPlayer('p2', 'Bob');
    room.players = [player1, player2];

    // Round 1
    room.answerQueue = [
      { playerId: 'p1', text: 'answer1', playerName: 'Alice' },
      { playerId: 'p2', text: 'answer2', playerName: 'Bob' },
    ];
    room.currentAnswer = room.answerQueue[0];
    room.phase = 'guessing';
    room.guesses = [{ guesserId: 'p2', guesserName: 'Bob', guessedId: 'p1', guessedName: 'Alice' }];

    calculateRoundScores(room);
    expect(player2.score).toBe(120);

    // Round 2
    room.currentAnswer = room.answerQueue[1];
    room.phase = 'guessing';
    room.guesses = [{ guesserId: 'p1', guesserName: 'Alice', guessedId: 'p2', guessedName: 'Bob' }];

    calculateRoundScores(room);

    expect(player1.score).toBe(120);
    expect(player2.score).toBe(120);
  });
});

describe('CRITICAL: Guess Validation', () => {
  let room;

  beforeEach(() => {
    room = createTestRoom();
  });

  it('evaluateGuess prevents host from guessing', () => {
    const player1 = createTestPlayer('p1', 'Alice');
    room.players = [player1];
    room.hostId = 'host-123';
    room.answerQueue = [{ playerId: 'p1', text: 'test', playerName: 'Alice' }];
    room.phase = 'guessing';
    room.currentAnswer = room.answerQueue[0];

    evaluateGuess(room, 'host-123', 'p1');

    expect(room.guesses).toHaveLength(0);
  });

  it('evaluateGuess prevents self-guessing', () => {
    const player1 = createTestPlayer('p1', 'Alice');
    room.players = [player1];
    room.hostId = 'host-123';
    room.answerQueue = [{ playerId: 'p1', text: 'test', playerName: 'Alice' }];
    room.phase = 'guessing';
    room.currentAnswer = room.answerQueue[0];

    evaluateGuess(room, 'p1', 'p1');

    expect(room.guesses).toHaveLength(0);
  });

  it('evaluateGuess prevents answer author from guessing on their own answer', () => {
    const player1 = createTestPlayer('p1', 'Alice');
    const player2 = createTestPlayer('p2', 'Bob');
    room.players = [player1, player2];
    room.hostId = 'host-123';
    room.answerQueue = [{ playerId: 'p1', text: 'test', playerName: 'Alice' }];
    room.phase = 'guessing';
    room.currentAnswer = room.answerQueue[0];

    // p1 (answer author) tries to guess p2 - should be prevented
    evaluateGuess(room, 'p1', 'p2');

    expect(room.guesses).toHaveLength(0);
  });

  it('evaluateGuess prevents duplicate guesses in same round', () => {
    const player1 = createTestPlayer('p1', 'Alice');
    const player2 = createTestPlayer('p2', 'Bob');
    const player3 = createTestPlayer('p3', 'Charlie');
    room.players = [player1, player2, player3];
    room.hostId = 'host-123';
    room.answerQueue = [{ playerId: 'p1', text: 'test', playerName: 'Alice' }];
    room.phase = 'guessing';
    room.currentAnswer = room.answerQueue[0];

    evaluateGuess(room, 'p2', 'p3');
    expect(room.guesses).toHaveLength(1);

    evaluateGuess(room, 'p2', 'p1');
    expect(room.guesses).toHaveLength(1);
    expect(room.guesses[0].guessedId).toBe('p3');
  });

  it('evaluateGuess records valid guess', () => {
    const player1 = createTestPlayer('p1', 'Alice');
    const player2 = createTestPlayer('p2', 'Bob');
    const player3 = createTestPlayer('p3', 'Charlie');
    room.players = [player1, player2, player3];
    room.hostId = 'host-123';
    room.answerQueue = [{ playerId: 'p1', text: 'test', playerName: 'Alice' }];
    room.phase = 'guessing';
    room.currentAnswer = room.answerQueue[0];

    evaluateGuess(room, 'p2', 'p3');

    expect(room.guesses).toHaveLength(1);
    expect(room.guesses[0].guesserId).toBe('p2');
    expect(room.guesses[0].guessedId).toBe('p3');
  });

  it('evaluateGuess does nothing if not in guessing phase', () => {
    const player1 = createTestPlayer('p1', 'Alice');
    const player2 = createTestPlayer('p2', 'Bob');
    room.players = [player1, player2];
    room.hostId = 'host-123';
    room.answerQueue = [{ playerId: 'p1', text: 'test' }];
    room.phase = 'answer-collection';
    room.currentAnswer = room.answerQueue[0];

    evaluateGuess(room, 'p2', 'p1');

    expect(room.guesses).toHaveLength(0);
  });
});

describe('HIGH: Game Flow Transitions', () => {
  let room;

  beforeEach(() => {
    room = createTestRoom();
  });

  it('lockAnswers transitions from answer-collection to guessing', () => {
    const player1 = createTestPlayer('p1', 'Alice');
    room.players = [player1];
    room.phase = 'answer-collection';
    room.answers = [{ playerId: 'p1', playerName: 'Alice', text: 'test answer' }];

    lockAnswers(room);

    expect(room.phase).toBe('guessing');
    expect(room.answerQueue).toHaveLength(0);
    expect(room.currentAnswer).toEqual(room.answers[0]);
  });

  it('lockAnswers does nothing if no answers submitted', () => {
    room.phase = 'answer-collection';
    room.answers = [];

    lockAnswers(room);

    expect(room.phase).toBe('answer-collection');
  });

  it('prepareCurrentAnswer displays answer', () => {
    room.answerQueue = [{ playerId: 'p1', text: 'test answer', playerName: 'Alice' }];
    prepareCurrentAnswer(room);

    expect(room.selectedAnswer).toBe('test answer');
    expect(room.answerAuthorId).toBe('p1');
    expect(room.phase).not.toBe('game-end');
  });

  it('prepareCurrentAnswer transitions to game-end when queue exhausted', () => {
    room.answerQueue = [];
    prepareCurrentAnswer(room);

    expect(room.phase).toBe('game-end');
    expect(room.selectedAnswer).toBe('');
  });

  it('advanceGuessRound moves to next answer', () => {
    room.phase = 'round-end';
    room.answerQueue = [
      { playerId: 'p1', text: 'answer1', playerName: 'Alice' },
      { playerId: 'p2', text: 'answer2', playerName: 'Bob' },
    ];
    room.currentAnswer = room.answerQueue.shift();
    advanceGuessRound(room);

    expect(room.phase).toBe('guessing');
    expect(room.answerQueue).toHaveLength(0);
  });

  it('advanceGuessRound transitions to game-end when last answer played', () => {
    room.phase = 'round-end';
    room.answerQueue = [{ playerId: 'p1', text: 'answer1', playerName: 'Alice' }];
    room.currentAnswer = room.answerQueue.shift();
    advanceGuessRound(room);

    expect(room.phase).toBe('game-end');
  });

  it('advanceGuessRound resets guesses for new round', () => {
    room.phase = 'round-end';
    room.answerQueue = [
      { playerId: 'p1', text: 'answer1', playerName: 'Alice' },
      { playerId: 'p2', text: 'answer2', playerName: 'Bob' },
    ];
    room.guesses = [{ guesserId: 'p1', guesserName: 'Alice', guessedId: 'p2' }];

    advanceGuessRound(room);

    expect(room.guesses).toHaveLength(0);
  });
});

describe('HIGH: Guess Round Timeout', () => {
  let room;

  beforeEach(() => {
    vi.useFakeTimers();
    room = createTestRoom();
  });

  afterEach(() => {
    clearGuessTimeout(room);
    vi.useRealTimers();
  });

  it('armGuessTimeout does nothing when the room has the timer disabled', () => {
    room.guessTimeoutEnabled = false;
    armGuessTimeout(room);

    expect(room.guessTimeoutHandle).toBeNull();
    expect(room.guessDeadlineMs).toBeNull();
  });

  it('armGuessTimeout schedules a deadline and auto-calls calculateRoundScores when enabled', () => {
    room.guessTimeoutEnabled = true;
    room.phase = 'guessing';
    room.currentAnswer = { playerId: 'p1', text: 'test answer' };
    room.guesses = [];

    armGuessTimeout(room);

    expect(room.guessDeadlineMs).toBeGreaterThan(Date.now());
    expect(room.guessTimeoutHandle).not.toBeNull();

    vi.advanceTimersByTime(GUESS_TIMEOUT_SECONDS * 1000);

    expect(room.phase).toBe('round-end');
  });

  it('calculateRoundScores clears a pending auto-timeout so it never double-fires', () => {
    room.guessTimeoutEnabled = true;
    room.phase = 'guessing';
    room.currentAnswer = { playerId: 'p1', text: 'test answer' };
    room.guesses = [];

    armGuessTimeout(room);
    calculateRoundScores(room);

    expect(room.guessTimeoutHandle).toBeNull();
    expect(room.phase).toBe('round-end');

    // Advancing time must not throw or re-run scoring against the already-ended round.
    vi.advanceTimersByTime(GUESS_TIMEOUT_SECONDS * 1000);
    expect(room.phase).toBe('round-end');
  });

  it('prepareCurrentAnswer arms a fresh timeout for each new guessing round when enabled', () => {
    room.guessTimeoutEnabled = true;
    room.answerQueue = [{ playerId: 'p1', text: 'test answer', playerName: 'Alice' }];

    prepareCurrentAnswer(room);

    expect(room.guessDeadlineMs).not.toBeNull();
    expect(room.guessTimeoutHandle).not.toBeNull();
  });

  it('prepareCurrentAnswer clears the timeout when the answer queue is exhausted', () => {
    room.guessTimeoutEnabled = true;
    room.answerQueue = [];

    prepareCurrentAnswer(room);

    expect(room.phase).toBe('game-end');
    expect(room.guessDeadlineMs).toBeNull();
    expect(room.guessTimeoutHandle).toBeNull();
  });
});

describe('CRITICAL: Start New Game', () => {
  let room;

  beforeEach(() => {
    room = createTestRoom();
  });

  it('startNewGame resets round state to lobby but keeps player scores', () => {
    const player1 = createTestPlayer('p1', 'Alice');
    const player2 = createTestPlayer('p2', 'Bob');
    player1.score = 240;
    player2.score = 120;
    room.players = [player1, player2];
    room.phase = 'game-end';
    room.question = 'Old question?';
    room.answers = [{ playerId: 'p1', playerName: 'Alice', text: 'old answer' }];
    room.guesses = [{ guesserId: 'p2', guesserName: 'Bob', guessedId: 'p1', guessedName: 'Alice' }];
    room.answerQueue = [{ playerId: 'p2', text: 'old answer 2', playerName: 'Bob' }];
    room.roundResults = [{ guesserName: 'Bob', guessedName: 'Alice', correct: true, points: 120 }];
    room.answerAuthorId = 'p1';
    room.selectedAnswer = 'old answer';
    room.answerRoundNumber = 2;

    startNewGame(room);

    expect(room.phase).toBe('lobby');
    expect(room.question).toBe('');
    expect(room.answers).toHaveLength(0);
    expect(room.guesses).toHaveLength(0);
    expect(room.answerQueue).toHaveLength(0);
    expect(room.roundResults).toHaveLength(0);
    expect(room.answerAuthorId).toBeNull();
    expect(room.selectedAnswer).toBe('');
    expect(room.answerRoundNumber).toBe(0);
    expect(player1.score).toBe(240);
    expect(player2.score).toBe(120);
  });

  it('host can start a fresh round with a new question after startNewGame', () => {
    const player1 = createTestPlayer('p1', 'Alice');
    player1.score = 360;
    room.players = [player1];
    room.phase = 'game-end';

    startNewGame(room);
    startRound(room, 'Brand new question here');

    expect(room.phase).toBe('answer-collection');
    expect(room.question).toBe('Brand new question here');
    expect(player1.score).toBe(360);
  });
});

describe('HIGH: Player Management', () => {
  let room;

  beforeEach(() => {
    room = createTestRoom();
  });

  it('addPlayerToRoom adds valid player', () => {
    const player = addPlayerToRoom(room, 'Alice');

    expect(player).not.toBeNull();
    expect(player.name).toBe('Alice');
    expect(player.score).toBe(0);
    expect(room.players).toHaveLength(1);
  });

  it('addPlayerToRoom rejects duplicate names (case-insensitive)', () => {
    addPlayerToRoom(room, 'Alice');
    const duplicate = addPlayerToRoom(room, 'alice');

    expect(duplicate).toBeNull();
    expect(room.players).toHaveLength(1);
  });

  it('addPlayerToRoom rejects empty names', () => {
    const empty = addPlayerToRoom(room, '');
    const spaces = addPlayerToRoom(room, '   ');

    expect(empty).toBeNull();
    expect(spaces).toBeNull();
    expect(room.players).toHaveLength(0);
  });

  it('addPlayerToRoom trims whitespace', () => {
    const player = addPlayerToRoom(room, '  Alice  ');

    expect(player.name).toBe('Alice');
  });

  it('addPlayerToRoom stores a valid avatar', () => {
    const player = addPlayerToRoom(room, 'Alice', AVATAR_OPTIONS[3]);

    expect(player.avatar).toBe(AVATAR_OPTIONS[3]);
  });

  it('addPlayerToRoom falls back to the default avatar for an unlisted value', () => {
    const player = addPlayerToRoom(room, 'Alice', '💀');

    expect(player.avatar).toBe(AVATAR_OPTIONS[0]);
  });
});

describe('MEDIUM: Avatar Normalization', () => {
  it('normalizeAvatar accepts a value from the allow-list', () => {
    expect(normalizeAvatar(AVATAR_OPTIONS[5])).toBe(AVATAR_OPTIONS[5]);
  });

  it('normalizeAvatar falls back to the default for invalid input', () => {
    expect(normalizeAvatar('not-an-emoji')).toBe(AVATAR_OPTIONS[0]);
    expect(normalizeAvatar(undefined)).toBe(AVATAR_OPTIONS[0]);
  });
});

describe('HIGH: Leave Room', () => {
  let room;

  beforeEach(() => {
    room = createTestRoom();
  });

  it('leaveRoom removes the player and their socket from the room', () => {
    const player = addPlayerToRoom(room, 'Alice');
    const socket = { playerId: player.id, readyState: 1 };
    room.clients.add(socket);

    const removed = leaveRoom(room, player.id);

    expect(removed.id).toBe(player.id);
    expect(room.players).toHaveLength(0);
    expect(room.clients.has(socket)).toBe(false);
    expect(socket.roomCode).toBeNull();
    expect(socket.playerId).toBeNull();
  });

  it('leaveRoom returns null for an unknown player id', () => {
    const removed = leaveRoom(room, 'not-a-real-id');

    expect(removed).toBeNull();
  });

  it('leaveRoom does not remove the host', () => {
    addPlayerToRoom(room, 'Alice');

    const removed = leaveRoom(room, room.hostId);

    expect(removed).toBeNull();
    expect(room.players).toHaveLength(1);
  });
});

describe('HIGH: Close Room', () => {
  function createTestSocket() {
    return {
      readyState: 1,
      sent: [],
      closeCalls: 0,
      send(message, callback) {
        this.sent.push(JSON.parse(message));
        callback?.();
      },
      close() {
        this.closeCalls += 1;
      },
    };
  }

  it('deletes the room, notifies every client, and invalidates reconnect sessions', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account' });
    const player = addPlayerToRoom(room, 'Alice');
    const playerReconnectToken = player.reconnectToken;
    const hostSocket = createTestSocket();
    const playerSocket = createTestSocket();
    hostSocket.playerId = room.hostId;
    playerSocket.playerId = player.id;
    room.clients.add(hostSocket);
    room.clients.add(playerSocket);

    const result = closeRoom(room);

    expect(result).toBe(true);
    expect(findRoomByCode(room.code)).toBeUndefined();
    expect(hostSocket.sent).toEqual([{ type: 'room-closed' }]);
    expect(playerSocket.sent).toEqual([{ type: 'room-closed' }]);
    expect(hostSocket.closeCalls).toBe(1);
    expect(playerSocket.closeCalls).toBe(1);
    expect(room.clients).toHaveLength(0);
    expect(reconnectRoom(room, hostSocket, { role: 'host', reconnectToken: 'old-token' })).toBeNull();
    expect(reconnectRoom(room, playerSocket, { role: 'player', reconnectToken: playerReconnectToken })).toBeNull();
  });

  it('does not close an unknown room', () => {
    const result = closeRoom(createTestRoom());

    expect(result).toBe(false);
  });
});

describe('HIGH: Answer Submission', () => {
  let room;

  beforeEach(() => {
    room = createTestRoom();
  });

  it('submitAnswer adds answer in collection phase', () => {
    const player = createTestPlayer('p1', 'Alice');
    room.players = [player];
    room.phase = 'answer-collection';

    submitAnswer(room, 'p1', 'This is my answer');

    expect(room.answers).toHaveLength(1);
    expect(room.answers[0].text).toBe('This is my answer');
  });

  it('submitAnswer rejects duplicate from same player', () => {
    const player = createTestPlayer('p1', 'Alice');
    room.players = [player];
    room.phase = 'answer-collection';

    submitAnswer(room, 'p1', 'First answer');
    submitAnswer(room, 'p1', 'Second answer');

    expect(room.answers).toHaveLength(1);
  });

  it('submitAnswer rejects empty answers', () => {
    const player = createTestPlayer('p1', 'Alice');
    room.players = [player];
    room.phase = 'answer-collection';

    submitAnswer(room, 'p1', '');
    submitAnswer(room, 'p1', '   ');

    expect(room.answers).toHaveLength(0);
  });

  it('submitAnswer does nothing if not in answer-collection phase', () => {
    const player = createTestPlayer('p1', 'Alice');
    room.players = [player];
    room.phase = 'guessing';

    submitAnswer(room, 'p1', 'Answer text');

    expect(room.answers).toHaveLength(0);
  });

  it('submitAnswer trims whitespace', () => {
    const player = createTestPlayer('p1', 'Alice');
    room.players = [player];
    room.phase = 'answer-collection';

    submitAnswer(room, 'p1', '  My answer text  ');

    expect(room.answers[0].text).toBe('My answer text');
  });
});

describe('MEDIUM: Room Management', () => {
  let room;

  beforeEach(() => {
    room = createTestRoom();
  });

  it('findPlayerById locates player by ID', () => {
    const player1 = createTestPlayer('p1', 'Alice');
    const player2 = createTestPlayer('p2', 'Bob');
    room.players = [player1, player2];

    const found = findPlayerById(room, 'p2');

    expect(found).toBe(player2);
  });

  it('findPlayerById returns undefined if player not found', () => {
    const player1 = createTestPlayer('p1', 'Alice');
    room.players = [player1];

    const found = findPlayerById(room, 'nonexistent');

    expect(found).toBeUndefined();
  });
});

describe('MEDIUM: Room Language', () => {
  it('defaults a new room to English when no language is given', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account' });

    expect(room.language).toBe('en');
    expect(makeRoomState(room).language).toBe('en');
  });

  it('stores a supported language chosen by the host', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', language: 'he' });

    expect(room.language).toBe('he');
    expect(makeRoomState(room).language).toBe('he');
  });

  it('falls back to English for an unsupported language code', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', language: 'fr' });

    expect(room.language).toBe('en');
  });
});

describe('CRITICAL: Room Reconnection', () => {
  function createTestSocket(user = null) {
    return {
      user,
      sent: [],
      close() {},
      send(message) {
        this.sent.push(message);
      },
    };
  }

  it('restores a disconnected player with the same identity and score', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account' });
    const player = addPlayerToRoom(room, 'Alice');
    player.score = 120;
    player.disconnectedAt = Date.now();
    const socket = createTestSocket();

    const membership = reconnectRoom(room, socket, { role: 'player', reconnectToken: player.reconnectToken });

    expect(membership).toMatchObject({ role: 'player', playerId: player.id, playerName: 'Alice' });
    expect(socket.playerId).toBe(player.id);
    expect(player.disconnectedAt).toBeNull();
    expect(room.players).toHaveLength(1);
    expect(room.players[0].score).toBe(120);
  });

  it('restores a host only when their authenticated account and token match', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account' });
    room.hostDisconnectedAt = Date.now();
    const socket = createTestSocket({ id: 'host-account' });

    const membership = reconnectRoom(room, socket, { role: 'host', reconnectToken: room.hostReconnectToken });

    expect(membership).toMatchObject({ role: 'host', playerId: room.hostId });
    expect(room.hostDisconnectedAt).toBeNull();
    expect(socket.playerId).toBe(room.hostId);
  });

  it('rejects a player reconnect attempt with an invalid token', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account' });
    const player = addPlayerToRoom(room, 'Alice');
    const socket = createTestSocket();

    const membership = reconnectRoom(room, socket, { role: 'player', reconnectToken: 'invalid-token' });

    expect(membership).toBeNull();
    expect(socket.playerId).toBeUndefined();
    expect(player.disconnectedAt).toBeNull();
  });

  it('expires disconnected memberships after the reconnect grace period', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account' });
    const player = addPlayerToRoom(room, 'Alice');
    const expiredAt = Date.now() - reconnectGracePeriodMs;
    room.hostDisconnectedAt = expiredAt;
    player.disconnectedAt = expiredAt;

    expireDisconnectedMemberships(Date.now());

    expect(findRoomByCode(room.code)).toBeUndefined();
  });
});
