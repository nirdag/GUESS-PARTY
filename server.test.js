import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from './logger.js';
import {
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
    guessTimeoutSeconds: 20,
    guessDeadlineMs: null,
    guessTimeoutHandle: null,
    guessCountdownEndsAt: null,
    guessCountdownHandle: null,
    gameStartedAt: null,
    questionsPlayedThisGame: 0,
    allowPlayerSuggestions: false,
    suggestedQuestions: [],
    roundEndConfirmedIds: [],
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

  it('calculateRoundScores awards decreasing points to later correct guessers in the same round', () => {
    const player1 = createTestPlayer('p1', 'Alice');
    const player2 = createTestPlayer('p2', 'Bob');
    const player3 = createTestPlayer('p3', 'Charlie');
    const player4 = createTestPlayer('p4', 'Dana');
    room.players = [player1, player2, player3, player4];

    room.answerQueue = [{ playerId: 'p1', text: 'test answer', playerName: 'Alice' }];
    room.currentAnswer = room.answerQueue[0];
    room.phase = 'guessing';
    room.guesses = [
      { guesserId: 'p2', guesserName: 'Bob', guessedId: 'p1', guessedName: 'Alice' },
      { guesserId: 'p3', guesserName: 'Charlie', guessedId: 'p1', guessedName: 'Alice' },
      { guesserId: 'p4', guesserName: 'Dana', guessedId: 'p1', guessedName: 'Alice' },
    ];

    calculateRoundScores(room);

    expect(room.roundResults.map((result) => result.points)).toEqual([120, 100, 80]);
    expect(player2.score).toBe(120);
    expect(player3.score).toBe(100);
    expect(player4.score).toBe(80);
  });

  it('calculateRoundScores floors points at the last speed tier once guessers run out of tiers', () => {
    const players = ['p2', 'p3', 'p4', 'p5', 'p6', 'p7'].map((id, index) => createTestPlayer(id, `Player${index}`));
    room.players = [createTestPlayer('p1', 'Alice'), ...players];

    room.answerQueue = [{ playerId: 'p1', text: 'test answer', playerName: 'Alice' }];
    room.currentAnswer = room.answerQueue[0];
    room.phase = 'guessing';
    room.guesses = players.map((player) => ({
      guesserId: player.id,
      guesserName: player.name,
      guessedId: 'p1',
      guessedName: 'Alice',
    }));

    calculateRoundScores(room);

    expect(room.roundResults.map((result) => result.points)).toEqual([120, 100, 80, 60, 40, 40]);
  });

  it('calculateRoundScores does not consume a speed tier for incorrect guesses', () => {
    const player1 = createTestPlayer('p1', 'Alice');
    const player2 = createTestPlayer('p2', 'Bob');
    const player3 = createTestPlayer('p3', 'Charlie');
    room.players = [player1, player2, player3];

    room.answerQueue = [{ playerId: 'p1', text: 'test answer', playerName: 'Alice' }];
    room.currentAnswer = room.answerQueue[0];
    room.phase = 'guessing';
    room.guesses = [
      { guesserId: 'p2', guesserName: 'Bob', guessedId: 'p3', guessedName: 'Charlie' },
      { guesserId: 'p3', guesserName: 'Charlie', guessedId: 'p1', guessedName: 'Alice' },
    ];

    calculateRoundScores(room);

    expect(room.roundResults.map((result) => result.points)).toEqual([0, 120]);
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
    room.answers = [
      { playerId: 'p1', text: 'test', playerName: 'Alice' },
      { playerId: 'p3', text: 'other answer', playerName: 'Charlie' },
    ];
    room.answerQueue = [{ playerId: 'p3', text: 'other answer', playerName: 'Charlie' }];
    room.phase = 'guessing';
    room.currentAnswer = room.answers[0];

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
    room.answers = [
      { playerId: 'p1', text: 'test', playerName: 'Alice' },
      { playerId: 'p3', text: 'other answer', playerName: 'Charlie' },
    ];
    room.answerQueue = [{ playerId: 'p3', text: 'other answer', playerName: 'Charlie' }];
    room.phase = 'guessing';
    room.currentAnswer = room.answers[0];

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
    room.players = [createTestPlayer('p1', 'Alice'), createTestPlayer('p2', 'Bob'), createTestPlayer('p3', 'Carol')];
    room.phase = 'answer-collection';
    room.answers = [
      { playerId: 'p1', playerName: 'Alice', text: 'test answer' },
      { playerId: 'p2', playerName: 'Bob', text: 'answer two' },
      { playerId: 'p3', playerName: 'Carol', text: 'answer three' },
    ];

    lockAnswers(room);

    expect(room.phase).toBe('guessing');
    expect(room.answerQueue).toHaveLength(2);
    expect(room.answers).toContainEqual(room.currentAnswer);
  });

  it('lockAnswers does nothing with fewer than 3 submitted answers', () => {
    room.players = [createTestPlayer('p1', 'Alice'), createTestPlayer('p2', 'Bob')];
    room.phase = 'answer-collection';
    room.answers = [
      { playerId: 'p1', playerName: 'Alice', text: 'test answer' },
      { playerId: 'p2', playerName: 'Bob', text: 'answer two' },
    ];

    lockAnswers(room);

    expect(room.phase).toBe('answer-collection');
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

  it('calculateRoundScores resets roundEndConfirmedIds for the new round-end', () => {
    const player1 = createTestPlayer('p1', 'Alice');
    room.players = [player1];
    room.answerQueue = [{ playerId: 'p1', text: 'test', playerName: 'Alice' }];
    room.currentAnswer = room.answerQueue[0];
    room.phase = 'guessing';
    room.guesses = [];
    room.roundEndConfirmedIds = [room.hostId, 'p1'];

    calculateRoundScores(room);

    expect(room.roundEndConfirmedIds).toEqual([]);
  });
});

describe('HIGH: Round-end confirmations', () => {
  let room;

  beforeEach(() => {
    room = createTestRoom();
    room.phase = 'round-end';
    room.players = [createTestPlayer('p1', 'Alice'), createTestPlayer('p2', 'Bob')];
  });

  it('getRoundEndConfirmerIds includes the host and all connected players', () => {
    const ids = getRoundEndConfirmerIds(room);
    expect(ids).toEqual(new Set([room.hostId, 'p1', 'p2']));
  });

  it('getRoundEndConfirmerIds excludes disconnected players', () => {
    room.players[1].disconnectedAt = Date.now();
    const ids = getRoundEndConfirmerIds(room);
    expect(ids).toEqual(new Set([room.hostId, 'p1']));
  });

  it('hasAllRoundEndConfirmed is false until every required id has confirmed', () => {
    room.roundEndConfirmedIds = [room.hostId, 'p1'];
    expect(hasAllRoundEndConfirmed(room)).toBe(false);

    room.roundEndConfirmedIds = [room.hostId, 'p1', 'p2'];
    expect(hasAllRoundEndConfirmed(room)).toBe(true);
  });

  it('hasAllRoundEndConfirmed ignores disconnected players', () => {
    room.players[1].disconnectedAt = Date.now();
    room.roundEndConfirmedIds = [room.hostId, 'p1'];
    expect(hasAllRoundEndConfirmed(room)).toBe(true);
  });

  it('canConfirmNextRound allows the host and connected players only during round-end', () => {
    expect(canConfirmNextRound(room, room.hostId)).toBe(true);
    expect(canConfirmNextRound(room, 'p1')).toBe(true);
    expect(canConfirmNextRound(room, 'unknown-player')).toBe(false);

    room.phase = 'guessing';
    expect(canConfirmNextRound(room, 'p1')).toBe(false);
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
    clearGuessCountdown(room);
    vi.useRealTimers();
  });

  it('createRoom defaults the guess timeout to 20 seconds', () => {
    const createdRoom = createRoom({ hostName: 'Host', hostAccountId: 'host-account' });

    expect(createdRoom.guessTimeoutSeconds).toBe(20);
    expect(makeRoomState(createdRoom).guessTimeoutSeconds).toBe(20);
  });

  it('createRoom normalizes an invalid guess timeout to 20 seconds', () => {
    const createdRoom = createRoom({ hostName: 'Host', hostAccountId: 'host-account', guessTimeoutSeconds: 15 });

    expect(createdRoom.guessTimeoutSeconds).toBe(20);
  });

  it('createRoom allows an anonymous (guest) host with no hostAccountId', () => {
    const createdRoom = createRoom({ hostName: 'Guest Host' });

    expect(createdRoom.hostAccountId).toBeNull();
    expect(createdRoom.hostId).toBeTruthy();
    expect(createdRoom.hostReconnectToken).toBeTruthy();
  });

  it('armGuessTimeout uses the room guess timeout', () => {
    room.guessTimeoutSeconds = 25;
    room.phase = 'guessing';
    armGuessTimeout(room);

    room.currentAnswer = { playerId: 'p1', text: 'test answer' };
    room.guesses = [];

    expect(room.guessDeadlineMs).toBeGreaterThan(Date.now());
    expect(room.guessTimeoutHandle).not.toBeNull();

    vi.advanceTimersByTime(24 * 1000);
    expect(room.phase).toBe('guessing');

    vi.advanceTimersByTime(1000);

    expect(room.phase).toBe('round-end');
  });

  it('calculateRoundScores clears a pending auto-timeout so it never double-fires', () => {
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
    room.answerQueue = [{ playerId: 'p1', text: 'test answer', playerName: 'Alice' }];

    prepareCurrentAnswer(room);

    // The celebratory countdown plays first; the real guess timer isn't armed yet.
    expect(room.guessDeadlineMs).toBeNull();
    expect(room.guessCountdownEndsAt).not.toBeNull();
    expect(room.guessCountdownHandle).not.toBeNull();

    vi.advanceTimersByTime(GUESS_COUNTDOWN_MS);

    expect(room.guessCountdownEndsAt).toBeNull();
    expect(room.guessDeadlineMs).not.toBeNull();
    expect(room.guessTimeoutHandle).not.toBeNull();
  });

  it('calculateRoundScores clears a pending guess countdown so it never arms the real timer late', () => {
    room.answerQueue = [{ playerId: 'p1', text: 'test answer', playerName: 'Alice' }];
    prepareCurrentAnswer(room);

    calculateRoundScores(room);

    expect(room.guessCountdownHandle).toBeNull();
    expect(room.guessCountdownEndsAt).toBeNull();

    // Advancing past the countdown window must not arm the real timer against the already-ended round.
    vi.advanceTimersByTime(GUESS_COUNTDOWN_MS);
    expect(room.guessDeadlineMs).toBeNull();
  });

  it('prepareCurrentAnswer clears the timeout when the answer queue is exhausted', () => {
    room.answerQueue = [];

    prepareCurrentAnswer(room);

    expect(room.phase).toBe('game-end');
    expect(room.guessDeadlineMs).toBeNull();
    expect(room.guessTimeoutHandle).toBeNull();
    expect(room.guessCountdownEndsAt).toBeNull();
    expect(room.guessCountdownHandle).toBeNull();
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
    room.players = [player1, createTestPlayer('p2', 'Bob'), createTestPlayer('p3', 'Carol')];
    room.phase = 'game-end';

    startNewGame(room);
    startRound(room, 'Brand new question here');

    expect(room.phase).toBe('answer-collection');
    expect(room.question).toBe('Brand new question here');
    expect(player1.score).toBe(360);
  });
});

describe('MEDIUM: Game lifecycle metrics', () => {
  let room;

  beforeEach(() => {
    room = createTestRoom();
    room.players = [createTestPlayer('p1', 'Alice'), createTestPlayer('p2', 'Bob'), createTestPlayer('p3', 'Carol')];
    vi.spyOn(logger, 'event').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('startRound emits game-started only for the first question of a game', () => {
    startRound(room, 'Question one');

    expect(logger.event).toHaveBeenCalledWith('game-started', { roomCode: room.code, participantCount: 3 });
    expect(room.gameStartedAt).not.toBeNull();
    expect(room.questionsPlayedThisGame).toBe(1);

    logger.event.mockClear();
    startRound(room, 'Question two');

    expect(logger.event).not.toHaveBeenCalledWith('game-started', expect.anything());
    expect(room.questionsPlayedThisGame).toBe(2);
  });

  it('emitGameEndedIfInProgress does nothing when no game is in progress', () => {
    emitGameEndedIfInProgress(room);

    expect(logger.event).not.toHaveBeenCalledWith('game-ended', expect.anything());
  });

  it('prepareCurrentAnswer emits game-ended with duration/participants/questions when the queue is exhausted', () => {
    startRound(room, 'Question one');
    room.answerQueue = [];

    prepareCurrentAnswer(room);

    expect(logger.event).toHaveBeenCalledWith('game-ended', expect.objectContaining({
      roomCode: room.code,
      participantCount: 3,
      questionsPlayed: 1,
    }));
    expect(room.gameStartedAt).toBeNull();
  });

  it('closeRoom emits game-ended exactly once even if the game already ended naturally', () => {
    startRound(room, 'Question one');
    room.answerQueue = [];
    prepareCurrentAnswer(room);

    logger.event.mockClear();
    closeRoom(room);

    expect(logger.event).not.toHaveBeenCalledWith('game-ended', expect.anything());
  });

  it('startNewGame emits game-ended for a game closed early by the host', () => {
    startRound(room, 'Question one');

    startNewGame(room);

    expect(logger.event).toHaveBeenCalledWith('game-ended', expect.objectContaining({
      roomCode: room.code,
      questionsPlayed: 1,
    }));
    expect(room.gameStartedAt).toBeNull();
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

describe('HIGH: Kick Player', () => {
  function createTestSocket() {
    return {
      readyState: 1,
      sent: [],
      send(message) {
        this.sent.push(JSON.parse(message));
      },
    };
  }

  it('removes the player, detaches their socket, and notifies them they were kicked', () => {
    const room = createTestRoom();
    const player = addPlayerToRoom(room, 'Alice');
    const socket = createTestSocket();
    socket.playerId = player.id;
    room.clients.add(socket);

    const removed = kickPlayer(room, player.id);

    expect(removed.id).toBe(player.id);
    expect(room.players).toHaveLength(0);
    expect(room.clients.has(socket)).toBe(false);
    expect(socket.sent).toEqual([{ type: 'kicked' }]);
  });

  it('returns null for an unknown player id', () => {
    const room = createTestRoom();

    expect(kickPlayer(room, 'not-a-real-id')).toBeNull();
  });

  it('cleans up the kicked player pending pool questions while still in lobby', () => {
    const room = createTestRoom();
    room.questionPoolMode = true;
    room.poolQuestions = [];
    const player = addPlayerToRoom(room, 'Alice');
    addPoolQuestion(room, player.id, player.name, 'Would you rather question that is long enough?');
    expect(room.poolQuestions).toHaveLength(1);

    kickPlayer(room, player.id);

    expect(room.poolQuestions).toHaveLength(0);
  });

  it('lets a kicked player rejoin under the same name afterward', () => {
    const room = createTestRoom();
    const player = addPlayerToRoom(room, 'Alice');
    kickPlayer(room, player.id);

    const rejoined = addPlayerToRoom(room, 'Alice');

    expect(rejoined).not.toBeNull();
    expect(rejoined.id).not.toBe(player.id);
  });

  it('treats kicking the current answer owner mid-guessing like a timeout: scores existing guesses and proceeds to round-end', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account' });
    const alice = addPlayerToRoom(room, 'Alice');
    const bob = addPlayerToRoom(room, 'Bob');
    const carol = addPlayerToRoom(room, 'Carol');
    const dave = addPlayerToRoom(room, 'Dave');
    startRound(room, 'What is the best pizza topping?');
    submitAnswer(room, alice.id, 'Pepperoni');
    submitAnswer(room, bob.id, 'Mushroom');
    submitAnswer(room, carol.id, 'Olives');
    submitAnswer(room, dave.id, 'Pineapple');
    lockAnswers(room);
    expect(room.phase).toBe('guessing');

    const answerOwnerId = room.currentAnswer.playerId;
    const otherPlayers = [alice, bob, carol, dave].filter((player) => player.id !== answerOwnerId);
    evaluateGuess(room, otherPlayers[0].id, otherPlayers[1].id);

    const removed = kickPlayer(room, answerOwnerId);

    expect(removed.id).toBe(answerOwnerId);
    expect(room.phase).toBe('round-end');
    expect(room.roundResults.length).toBeGreaterThan(0);
  });

  it('reassigns asker duty to the next score leader when the kicked player is the current asker', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', addSelfAsPlayer: true });
    const alice = addPlayerToRoom(room, 'Alice');
    const bob = addPlayerToRoom(room, 'Bob');
    const carol = addPlayerToRoom(room, 'Carol');
    const dave = addPlayerToRoom(room, 'Dave');
    carol.score = 200;
    room.phase = 'asking';
    room.askingPlayerId = alice.id;
    room.lastAskerId = alice.id;

    const removed = kickPlayer(room, alice.id);

    expect(removed.id).toBe(alice.id);
    expect(room.phase).toBe('asking');
    expect(room.askingPlayerId).toBe(carol.id);
    expect(room.lastAskerId).toBe(carol.id);
    expect(bob).toBeTruthy();
    expect(dave).toBeTruthy();
  });

  it('ends the game when kicking the current asker leaves too few players to keep rotating', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', addSelfAsPlayer: true });
    const alice = addPlayerToRoom(room, 'Alice');
    addPlayerToRoom(room, 'Bob');
    room.phase = 'asking';
    room.askingPlayerId = alice.id;

    const removed = kickPlayer(room, alice.id);

    expect(removed.id).toBe(alice.id);
    expect(room.phase).toBe('game-end');
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

describe('HIGH: Guess options shrink as authors get revealed', () => {
  let room;

  beforeEach(() => {
    room = createTestRoom();
    room.players = [createTestPlayer('p1', 'Alice'), createTestPlayer('p2', 'Bob'), createTestPlayer('p3', 'Charlie')];
    room.answers = [
      { playerId: 'p1', text: 'answer1', playerName: 'Alice' },
      { playerId: 'p2', text: 'answer2', playerName: 'Bob' },
      { playerId: 'p3', text: 'answer3', playerName: 'Charlie' },
    ];
  });

  it('getEligibleGuessTargetIds includes remaining queue authors plus the current answer author', () => {
    room.answerQueue = [
      { playerId: 'p2', text: 'answer2', playerName: 'Bob' },
      { playerId: 'p3', text: 'answer3', playerName: 'Charlie' },
    ];
    room.currentAnswer = { playerId: 'p1', text: 'answer1', playerName: 'Alice' };

    expect(getEligibleGuessTargetIds(room)).toEqual(new Set(['p1', 'p2', 'p3']));
  });

  it('getEligibleGuessTargetIds excludes an author already revealed in a prior round', () => {
    // p1's answer was drawn and resolved in an earlier round, so only p2/p3 remain queued.
    room.answerQueue = [{ playerId: 'p3', text: 'answer3', playerName: 'Charlie' }];
    room.currentAnswer = { playerId: 'p2', text: 'answer2', playerName: 'Bob' };

    const eligible = getEligibleGuessTargetIds(room);

    expect(eligible.has('p1')).toBe(false);
    expect(eligible).toEqual(new Set(['p2', 'p3']));
  });

  it('getEligibleGuessTargetIds excludes a player who did not submit an answer', () => {
    room.players.push(createTestPlayer('p4', 'Dana'));
    room.answerQueue = [{ playerId: 'p2', text: 'answer2', playerName: 'Bob' }];
    room.currentAnswer = { playerId: 'p1', text: 'answer1', playerName: 'Alice' };

    expect(getEligibleGuessTargetIds(room)).toEqual(new Set(['p1', 'p2']));
  });

  it('makeRoomState exposes remainingAuthorIds for the client to filter guess options', () => {
    room.answerQueue = [{ playerId: 'p3', text: 'answer3', playerName: 'Charlie' }];
    room.currentAnswer = { playerId: 'p2', text: 'answer2', playerName: 'Bob' };

    expect(makeRoomState(room).remainingAuthorIds.sort()).toEqual(['p2', 'p3']);
  });

  it('makeRoomState omits a player who did not submit an answer from guess options', () => {
    room.players.push(createTestPlayer('p4', 'Dana'));
    room.answerQueue = [{ playerId: 'p2', text: 'answer2', playerName: 'Bob' }];
    room.currentAnswer = { playerId: 'p1', text: 'answer1', playerName: 'Alice' };

    expect(makeRoomState(room).remainingAuthorIds.sort()).toEqual(['p1', 'p2']);
  });

  it('evaluateGuess rejects a guess targeting a player already revealed in a prior round', () => {
    room.hostId = 'host-123';
    room.phase = 'guessing';
    // p1 was already revealed in a previous round, so p2/p3 shouldn't be able to guess them anymore.
    room.answerQueue = [];
    room.currentAnswer = { playerId: 'p3', text: 'answer3', playerName: 'Charlie' };

    evaluateGuess(room, 'p2', 'p1');

    expect(room.guesses).toHaveLength(0);
  });

  it('evaluateGuess rejects a guess targeting a player who did not submit an answer', () => {
    room.players.push(createTestPlayer('p4', 'Dana'));
    room.hostId = 'host-123';
    room.phase = 'guessing';
    room.answerQueue = [{ playerId: 'p2', text: 'answer2', playerName: 'Bob' }];
    room.currentAnswer = { playerId: 'p1', text: 'answer1', playerName: 'Alice' };

    evaluateGuess(room, 'p2', 'p4');

    expect(room.guesses).toHaveLength(0);
  });

  it('evaluateGuess still allows guessing the current round author', () => {
    room.hostId = 'host-123';
    room.phase = 'guessing';
    room.answerQueue = [];
    room.currentAnswer = { playerId: 'p3', text: 'answer3', playerName: 'Charlie' };

    evaluateGuess(room, 'p2', 'p3');

    expect(room.guesses).toHaveLength(1);
    expect(room.guesses[0].guessedId).toBe('p3');
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

  it('restores a host using the reconnect token alone, regardless of authentication', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account' });
    room.hostDisconnectedAt = Date.now();
    const socket = createTestSocket({ id: 'host-account' });

    const membership = reconnectRoom(room, socket, { role: 'host', reconnectToken: room.hostReconnectToken });

    expect(membership).toMatchObject({ role: 'host', playerId: room.hostId });
    expect(room.hostDisconnectedAt).toBeNull();
    expect(socket.playerId).toBe(room.hostId);
  });

  it('restores an anonymous (guest) host via the reconnect token, with no socket.user at all', () => {
    const room = createRoom({ hostName: 'Host' });
    room.hostDisconnectedAt = Date.now();
    const socket = createTestSocket();

    const membership = reconnectRoom(room, socket, { role: 'host', reconnectToken: room.hostReconnectToken });

    expect(membership).toMatchObject({ role: 'host', playerId: room.hostId });
    expect(room.hostDisconnectedAt).toBeNull();
    expect(socket.playerId).toBe(room.hostId);
  });

  it('rejects a host reconnect attempt with the wrong token', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account' });
    room.hostDisconnectedAt = Date.now();
    const socket = createTestSocket();

    const membership = reconnectRoom(room, socket, { role: 'host', reconnectToken: 'wrong-token' });

    expect(membership).toBeNull();
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

describe('HIGH: Host-as-player mode', () => {
  it('adds the host into players when addSelfAsPlayer is set, and not otherwise', () => {
    const withSelf = createRoom({ hostName: 'Host', hostAccountId: 'host-account', addSelfAsPlayer: true });
    expect(withSelf.hostIsPlayer).toBe(true);
    expect(withSelf.players).toHaveLength(1);
    expect(withSelf.players[0]).toMatchObject({ id: withSelf.hostId, name: 'Host', score: 0 });

    const classic = createRoom({ hostName: 'Host', hostAccountId: 'host-account' });
    expect(classic.hostIsPlayer).toBe(false);
    expect(classic.players).toHaveLength(0);
  });

  it('makes the host the asker of the first question', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', addSelfAsPlayer: true });
    addPlayerToRoom(room, 'Alice');
    addPlayerToRoom(room, 'Bob');
    addPlayerToRoom(room, 'Carol');

    startRound(room, 'What is the best pizza topping?');

    expect(room.askingPlayerId).toBe(room.hostId);
    expect(room.lastAskerId).toBe(room.hostId);
  });

  it('assigns the host as asker at room creation, before the lobby button is ever pressed', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', addSelfAsPlayer: true });

    expect(room.askingPlayerId).toBe(room.hostId);
    expect(room.phase).toBe('lobby');
  });

  it('blocks starting a round with only the host and no other players', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', addSelfAsPlayer: true });

    startRound(room, 'What is the best pizza topping?');

    expect(room.phase).toBe('lobby');
  });

  it('excludes the asker from submitting an answer', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', addSelfAsPlayer: true });
    addPlayerToRoom(room, 'Alice');
    addPlayerToRoom(room, 'Bob');
    addPlayerToRoom(room, 'Carol');
    startRound(room, 'What is the best pizza topping?');

    submitAnswer(room, room.askingPlayerId, 'Pepperoni');

    expect(room.answers).toHaveLength(0);
  });

  it('excludes the asker from guess eligibility', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', addSelfAsPlayer: true });
    addPlayerToRoom(room, 'Alice');
    addPlayerToRoom(room, 'Bob');
    addPlayerToRoom(room, 'Carol');
    startRound(room, 'What is the best pizza topping?');

    expect(getEligibleGuessTargetIds(room).has(room.askingPlayerId)).toBe(false);
  });

  describe('pickNextAsker tie-break', () => {
    it('picks the outright score leader when there is no tie', () => {
      const room = createTestRoom();
      room.players = [createTestPlayer('a', 'Alice'), createTestPlayer('b', 'Bob')];
      room.players[0].score = 50;
      room.players[1].score = 100;
      room.lastAskerId = null;

      expect(pickNextAsker(room)).toBe('b');
    });

    it('excludes the most recently asked player among tied leaders', () => {
      const room = createTestRoom();
      room.players = [createTestPlayer('a', 'Alice'), createTestPlayer('b', 'Bob'), createTestPlayer('c', 'Carol')];
      room.players.forEach((player) => { player.score = 100; });
      room.lastAskerId = 'a';

      expect(pickNextAsker(room)).not.toBe('a');
    });

    it('falls back to the last asker when they are the only leader', () => {
      const room = createTestRoom();
      room.players = [createTestPlayer('a', 'Alice'), createTestPlayer('b', 'Bob')];
      room.players[0].score = 100;
      room.players[1].score = 50;
      room.lastAskerId = 'a';

      expect(pickNextAsker(room)).toBe('a');
    });
  });

  it('continueToNextQuestion hands the ask duty to the leader without resetting scores', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', addSelfAsPlayer: true });
    const alice = addPlayerToRoom(room, 'Alice');
    addPlayerToRoom(room, 'Bob');
    addPlayerToRoom(room, 'Carol');
    startRound(room, 'What is the best pizza topping?');
    alice.score = 500;

    continueToNextQuestion(room);

    expect(room.phase).toBe('asking');
    expect(room.askingPlayerId).toBe(alice.id);
    expect(alice.score).toBe(500);
  });

  it('announces the next asker at game end and clears it when continuing', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', addSelfAsPlayer: true });
    const alice = addPlayerToRoom(room, 'Alice');
    addPlayerToRoom(room, 'Bob');
    addPlayerToRoom(room, 'Carol');
    room.players[0].score = 100;
    alice.score = 500;
    room.phase = 'round-end';
    room.answerQueue = [];

    advanceGuessRound(room);

    expect(room.pendingNextAskerId).toBe(alice.id);
    expect(makeRoomState(room).pendingNextAskerId).toBe(alice.id);

    continueToNextQuestion(room);

    expect(room.pendingNextAskerId).toBeNull();
  });

  it('new-game continues to the next asker instead of resetting to lobby when hostIsPlayer is set', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', addSelfAsPlayer: true });
    const alice = addPlayerToRoom(room, 'Alice');
    addPlayerToRoom(room, 'Bob');
    addPlayerToRoom(room, 'Carol');
    startRound(room, 'What is the best pizza topping?');
    alice.score = 500;

    continueToNextQuestion(room);

    expect(room.phase).not.toBe('lobby');
  });

  it('lets the newly assigned asker submit a question and start the round', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', addSelfAsPlayer: true });
    const alice = addPlayerToRoom(room, 'Alice');
    addPlayerToRoom(room, 'Bob');
    addPlayerToRoom(room, 'Carol');
    startRound(room, 'What is the best pizza topping?');
    alice.score = 500;
    continueToNextQuestion(room);

    startRound(room, 'What is the best dessert?');

    expect(room.phase).toBe('answer-collection');
    expect(room.question).toBe('What is the best dessert?');
  });

  it('classic rooms are unaffected: host never appears in players and always asks', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account' });
    addPlayerToRoom(room, 'Alice');
    addPlayerToRoom(room, 'Bob');
    addPlayerToRoom(room, 'Carol');

    startRound(room, 'What is the best pizza topping?');

    expect(room.players.some((player) => player.id === room.hostId)).toBe(false);
    expect(room.askingPlayerId).toBeNull();
    expect(getEligibleGuessTargetIds(room).has(room.hostId)).toBe(false);
  });
});

describe('HIGH: Minimum player/answer requirements', () => {
  it('startRound blocks a classic room with fewer than 3 players', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account' });
    addPlayerToRoom(room, 'Alice');
    addPlayerToRoom(room, 'Bob');

    startRound(room, 'What is the best pizza topping?');

    expect(room.phase).toBe('lobby');
  });

  it('startRound allows a classic room with exactly 3 players', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account' });
    addPlayerToRoom(room, 'Alice');
    addPlayerToRoom(room, 'Bob');
    addPlayerToRoom(room, 'Carol');

    startRound(room, 'What is the best pizza topping?');

    expect(room.phase).toBe('answer-collection');
  });

  it('startRound blocks a host-as-player room with fewer than 4 total players', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', addSelfAsPlayer: true });
    addPlayerToRoom(room, 'Alice');
    addPlayerToRoom(room, 'Bob');

    startRound(room, 'What is the best pizza topping?');

    expect(room.phase).toBe('lobby');
  });
});

describe('HIGH: Final matchup (last two answers)', () => {
  let room;

  beforeEach(() => {
    room = createTestRoom();
    room.players = [
      createTestPlayer('asker', 'Host'),
      createTestPlayer('p1', 'Alice'),
      createTestPlayer('p2', 'Bob'),
      createTestPlayer('p3', 'Carol'),
    ];
    room.askingPlayerId = 'asker';
    room.phase = 'guessing';
    room.answers = [
      { playerId: 'p1', playerName: 'Alice', text: 'answer one' },
      { playerId: 'p2', playerName: 'Bob', text: 'answer two' },
      { playerId: 'p3', playerName: 'Carol', text: 'answer three' },
    ];
  });

  it('prepareCurrentAnswer switches to a final matchup once exactly 2 answers remain', () => {
    room.answerQueue = [
      { playerId: 'p2', playerName: 'Bob', text: 'answer two' },
      { playerId: 'p3', playerName: 'Carol', text: 'answer three' },
    ];

    prepareCurrentAnswer(room);

    expect(room.answerQueue).toHaveLength(0);
    expect(room.currentAnswer).toBeNull();
    expect(room.finalMatchup).not.toBeNull();
    expect(room.finalMatchup.answers.map((a) => a.text).sort()).toEqual(['answer three', 'answer two']);
    expect(room.finalMatchup.authorIds.sort()).toEqual(['p2', 'p3']);
    expect(room.finalMatchup.truth).toEqual({ A: expect.any(String), B: expect.any(String) });
  });

  it('getEligibleGuessTargetIds returns both final-matchup authors', () => {
    room.finalMatchup = {
      answers: [{ slot: 'A', text: 'answer two' }, { slot: 'B', text: 'answer three' }],
      authorIds: ['p2', 'p3'],
      truth: { A: 'p2', B: 'p3' },
      autoRevealed: false,
    };

    expect(getEligibleGuessTargetIds(room)).toEqual(new Set(['p2', 'p3']));
  });

  it('evaluateGuess rejects the asker, both final authors, and an invalid slot', () => {
    room.finalMatchup = {
      answers: [{ slot: 'A', text: 'answer two' }, { slot: 'B', text: 'answer three' }],
      authorIds: ['p2', 'p3'],
      truth: { A: 'p2', B: 'p3' },
      autoRevealed: false,
    };

    evaluateGuess(room, 'asker', 'p2', 'A');
    evaluateGuess(room, 'p2', 'p3', 'A');
    evaluateGuess(room, 'p1', 'p2', 'not-a-slot');

    expect(room.guesses).toHaveLength(0);
  });

  it('evaluateGuess accepts an eligible guesser and records the answerSlot', () => {
    room.finalMatchup = {
      answers: [{ slot: 'A', text: 'answer two' }, { slot: 'B', text: 'answer three' }],
      authorIds: ['p2', 'p3'],
      truth: { A: 'p2', B: 'p3' },
      autoRevealed: false,
    };

    evaluateGuess(room, 'p1', 'p3', 'B');

    expect(room.guesses).toHaveLength(1);
    expect(room.guesses[0]).toMatchObject({ guesserId: 'p1', guessedId: 'p3', answerSlot: 'B' });
  });

  it('calculateRoundScores scores final-matchup guesses per slot with speed-tier points', () => {
    room.finalMatchup = {
      answers: [{ slot: 'A', text: 'answer two' }, { slot: 'B', text: 'answer three' }],
      authorIds: ['p2', 'p3'],
      truth: { A: 'p2', B: 'p3' },
      autoRevealed: false,
    };
    room.guesses = [
      { guesserId: 'p1', guesserName: 'Alice', guessedId: 'p2', guessedName: 'Bob', answerSlot: 'A' },
      { guesserId: 'asker', guesserName: 'Host', guessedId: 'p3', guessedName: 'Carol', answerSlot: 'B' },
    ];

    calculateRoundScores(room);

    expect(room.phase).toBe('round-end');
    expect(room.roundResults.find((r) => r.guesserName === 'Alice')).toMatchObject({ correct: true, points: 120, answerSlot: 'A' });
    expect(room.roundResults.find((r) => r.guesserName === 'Host')).toMatchObject({ correct: true, points: 100, answerSlot: 'B' });
  });

  it('prepareCurrentAnswer auto-reveals with no score when nobody is left eligible to guess', () => {
    room.players = [
      createTestPlayer('asker', 'Host'),
      createTestPlayer('p2', 'Bob'),
      createTestPlayer('p3', 'Carol'),
    ];
    room.answerQueue = [
      { playerId: 'p2', playerName: 'Bob', text: 'answer two' },
      { playerId: 'p3', playerName: 'Carol', text: 'answer three' },
    ];

    prepareCurrentAnswer(room);

    expect(room.finalMatchup.autoRevealed).toBe(true);
    expect(room.roundResults).toHaveLength(0);
    expect(room.phase).toBe('round-end');
    expect(room.guessDeadlineMs).toBeNull();
    expect(room.guessCountdownEndsAt).toBeNull();
  });

  it('makeRoomState never exposes the true answerAuthorId or matchup truth while guessing', () => {
    room.answerQueue = [
      { playerId: 'p2', playerName: 'Bob', text: 'answer two' },
      { playerId: 'p3', playerName: 'Carol', text: 'answer three' },
    ];
    prepareCurrentAnswer(room);

    const publicState = makeRoomState(room);

    expect(publicState.answerAuthorId).toBeNull();
    expect(publicState.finalMatchup.truth).toBeNull();
    expect(publicState.finalMatchup.answers.every((answer) => !('playerId' in answer))).toBe(true);

    calculateRoundScores(room);
    const revealedState = makeRoomState(room);
    expect(revealedState.finalMatchup.truth).toEqual(room.finalMatchup.truth);
  });
});

describe('HIGH: Player-suggested questions', () => {
  it('createRoom respects allowPlayerSuggestions, and forces it off when addSelfAsPlayer is set', () => {
    const withSuggestions = createRoom({ hostName: 'Host', hostAccountId: 'host-account', allowPlayerSuggestions: true });
    expect(withSuggestions.allowPlayerSuggestions).toBe(true);
    expect(withSuggestions.suggestedQuestions).toEqual([]);

    const mutuallyExclusive = createRoom({ hostName: 'Host', hostAccountId: 'host-account', addSelfAsPlayer: true, allowPlayerSuggestions: true });
    expect(mutuallyExclusive.allowPlayerSuggestions).toBe(false);

    const classic = createRoom({ hostName: 'Host', hostAccountId: 'host-account' });
    expect(classic.allowPlayerSuggestions).toBe(false);
  });

  it('addSuggestedQuestion validates length and stores the suggestion', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', allowPlayerSuggestions: true });
    const player = addPlayerToRoom(room, 'Alice');

    expect(addSuggestedQuestion(room, player.id, player.name, 'short')).toBeNull();
    expect(addSuggestedQuestion(room, player.id, player.name, 'a'.repeat(221))).toBeNull();

    const suggestion = addSuggestedQuestion(room, player.id, player.name, 'What is your favorite childhood memory?');
    expect(suggestion).toMatchObject({ playerId: player.id, playerName: 'Alice', text: 'What is your favorite childhood memory?' });
    expect(room.suggestedQuestions).toHaveLength(1);
  });

  it('removeSuggestedQuestion removes by id and returns null for an unknown id', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', allowPlayerSuggestions: true });
    const player = addPlayerToRoom(room, 'Alice');
    const suggestion = addSuggestedQuestion(room, player.id, player.name, 'What is your favorite childhood memory?');

    expect(removeSuggestedQuestion(room, 'not-a-real-id')).toBeNull();
    expect(removeSuggestedQuestion(room, suggestion.id)).toMatchObject({ id: suggestion.id });
    expect(room.suggestedQuestions).toHaveLength(0);
  });

  it('startRound only removes the suggestion whose text matches the committed question', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', allowPlayerSuggestions: true });
    addPlayerToRoom(room, 'Alice');
    addPlayerToRoom(room, 'Bob');
    addPlayerToRoom(room, 'Carol');
    const used = addSuggestedQuestion(room, 'p1', 'Alice', 'What is the best pizza topping?');
    const unused = addSuggestedQuestion(room, 'p2', 'Bob', 'What is your dream vacation spot?');

    startRound(room, used.text);

    expect(room.suggestedQuestions.map((entry) => entry.id)).toEqual([unused.id]);
  });

  it('makeRoomState exposes the full suggestion list only to the host viewer, and each player only their own', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', allowPlayerSuggestions: true });
    const alice = addPlayerToRoom(room, 'Alice');
    const bob = addPlayerToRoom(room, 'Bob');
    addSuggestedQuestion(room, alice.id, alice.name, 'What is your favorite childhood memory?');
    addSuggestedQuestion(room, bob.id, bob.name, 'What is your biggest fear?');

    const hostState = makeRoomState(room, room.hostId);
    expect(hostState.suggestedQuestions).toHaveLength(2);

    const aliceState = makeRoomState(room, alice.id);
    expect(aliceState.suggestedQuestions).toHaveLength(0);
    expect(aliceState.mySuggestedQuestions).toHaveLength(1);
    expect(aliceState.mySuggestedQuestions[0].playerId).toBe(alice.id);
  });

  it('addSuggestedQuestion accepts exactly-boundary lengths and rejects one character over/under', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', allowPlayerSuggestions: true });
    const player = addPlayerToRoom(room, 'Alice');

    expect(addSuggestedQuestion(room, player.id, player.name, 'a'.repeat(7))).toBeNull();
    expect(addSuggestedQuestion(room, player.id, player.name, 'a'.repeat(8))).not.toBeNull();
    expect(addSuggestedQuestion(room, player.id, player.name, 'b'.repeat(220))).not.toBeNull();
    expect(addSuggestedQuestion(room, player.id, player.name, 'b'.repeat(221))).toBeNull();
  });

  it('addSuggestedQuestion rejects whitespace-only input and stores the trimmed text', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', allowPlayerSuggestions: true });
    const player = addPlayerToRoom(room, 'Alice');

    expect(addSuggestedQuestion(room, player.id, player.name, '        ')).toBeNull();

    const suggestion = addSuggestedQuestion(room, player.id, player.name, '  What is your favorite movie?  ');
    expect(suggestion.text).toBe('What is your favorite movie?');
  });

  it('removeSuggestedQuestion returns null when the same id is removed twice', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', allowPlayerSuggestions: true });
    const player = addPlayerToRoom(room, 'Alice');
    const suggestion = addSuggestedQuestion(room, player.id, player.name, 'What is your favorite childhood memory?');

    expect(removeSuggestedQuestion(room, suggestion.id)).not.toBeNull();
    expect(removeSuggestedQuestion(room, suggestion.id)).toBeNull();
  });

  it('startRound clears every suggestion sharing the committed question text, and leaves the list untouched for a random bank question', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', allowPlayerSuggestions: true });
    addPlayerToRoom(room, 'Alice');
    addPlayerToRoom(room, 'Bob');
    addPlayerToRoom(room, 'Carol');
    addSuggestedQuestion(room, 'p1', 'Alice', 'What is the best pizza topping?');
    addSuggestedQuestion(room, 'p2', 'Bob', 'What is the best pizza topping?');

    startRound(room, 'What is the best pizza topping?');

    expect(room.suggestedQuestions).toHaveLength(0);

    const other = createRoom({ hostName: 'Host', hostAccountId: 'host-account', allowPlayerSuggestions: true });
    addPlayerToRoom(other, 'Alice');
    addPlayerToRoom(other, 'Bob');
    addPlayerToRoom(other, 'Carol');
    addSuggestedQuestion(other, 'p1', 'Alice', 'What is your dream vacation spot?');

    startRound(other, '');

    expect(other.suggestedQuestions).toHaveLength(1);
  });

  it('makeRoomState returns empty suggestion fields for every viewer when the feature is disabled or the viewer is unknown', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account' });
    const alice = addPlayerToRoom(room, 'Alice');

    const hostState = makeRoomState(room, room.hostId);
    expect(hostState.suggestedQuestions).toEqual([]);
    expect(hostState.mySuggestedQuestions).toEqual([]);

    const enabledRoom = createRoom({ hostName: 'Host', hostAccountId: 'host-account', allowPlayerSuggestions: true });
    addSuggestedQuestion(enabledRoom, alice.id, alice.name, 'What is your favorite childhood memory?');
    const staleViewerState = makeRoomState(enabledRoom, 'no-such-player-id');
    expect(staleViewerState.suggestedQuestions).toEqual([]);
    expect(staleViewerState.mySuggestedQuestions).toEqual([]);
  });

  function createTestSocket(playerId) {
    return {
      readyState: 1,
      playerId,
      sent: [],
      send(message) {
        this.sent.push(JSON.parse(message));
      },
    };
  }

  it('broadcastRoom sends the full suggestion list only to the host socket, and each player socket only their own', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', allowPlayerSuggestions: true });
    const alice = addPlayerToRoom(room, 'Alice');
    addSuggestedQuestion(room, alice.id, alice.name, 'What is your favorite childhood memory?');

    const hostSocket = createTestSocket(room.hostId);
    const aliceSocket = createTestSocket(alice.id);
    room.clients.add(hostSocket);
    room.clients.add(aliceSocket);

    broadcastRoom(room);

    expect(hostSocket.sent[0].state.suggestedQuestions).toHaveLength(1);
    expect(aliceSocket.sent[0].state.suggestedQuestions).toHaveLength(0);
    expect(aliceSocket.sent[0].state.mySuggestedQuestions).toHaveLength(1);
  });

  describe('authorization guards', () => {
    it('canSuggestQuestion requires the feature enabled, a playerId, and an existing player', () => {
      const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', allowPlayerSuggestions: true });
      const player = addPlayerToRoom(room, 'Alice');
      const disabledRoom = createRoom({ hostName: 'Host', hostAccountId: 'host-account' });

      expect(canSuggestQuestion(room, player.id)).toBe(true);
      expect(canSuggestQuestion(disabledRoom, room.hostId)).toBe(false);
      expect(canSuggestQuestion(room, undefined)).toBe(false);
      expect(canSuggestQuestion(room, room.hostId)).toBe(false);
    });

    it('canDeleteSuggestion only allows the suggestion\'s own author', () => {
      const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', allowPlayerSuggestions: true });
      const alice = addPlayerToRoom(room, 'Alice');
      const bob = addPlayerToRoom(room, 'Bob');
      const suggestion = addSuggestedQuestion(room, alice.id, alice.name, 'What is your favorite childhood memory?');

      expect(canDeleteSuggestion(room, 'not-a-real-id', alice.id)).toBe(false);
      expect(canDeleteSuggestion(room, suggestion.id, bob.id)).toBe(false);
      expect(canDeleteSuggestion(room, suggestion.id, alice.id)).toBe(true);
    });

    it('canDismissSuggestion only allows the room\'s own host session', () => {
      const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', allowPlayerSuggestions: true });

      expect(canDismissSuggestion(room, 'some-other-player-id')).toBe(false);
      expect(canDismissSuggestion(room, null)).toBe(false);
      expect(canDismissSuggestion(room, room.hostId)).toBe(true);
    });
  });
});

describe('HIGH: Pre-game question pool mode', () => {
  function createTestSocket(playerId) {
    return {
      playerId,
      readyState: 1,
      sent: [],
      send(data) {
        this.sent.push(JSON.parse(data));
      },
    };
  }

  it('createRoom respects questionPoolMode and disables player suggestions', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', questionPoolMode: true, allowPlayerSuggestions: true });
    expect(room.questionPoolMode).toBe(true);
    expect(room.allowPlayerSuggestions).toBe(false);
    expect(room.poolQuestions).toEqual([]);
    expect(room.askingPlayerId).toBeNull();
  });

  it('allows players and host to add up to 3 questions with 8-220 characters', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', questionPoolMode: true });
    const alice = addPlayerToRoom(room, 'Alice');

    // Short question (< 8 chars)
    expect(addPoolQuestion(room, alice.id, alice.name, 'Too?')).toBeNull();

    // Valid questions
    const q1 = addPoolQuestion(room, alice.id, alice.name, 'What is your secret superpower?');
    const q2 = addPoolQuestion(room, alice.id, alice.name, 'What is the weirdest food you love?');
    const q3 = addPoolQuestion(room, alice.id, alice.name, 'If you could time travel, where to?');
    expect(q1).not.toBeNull();
    expect(q2).not.toBeNull();
    expect(q3).not.toBeNull();
    expect(room.poolQuestions).toHaveLength(3);

    // 4th question rejected (limit 3 per player)
    expect(canSubmitPoolQuestion(room, alice.id)).toBe(false);
    expect(addPoolQuestion(room, alice.id, alice.name, 'A fourth question should not be allowed?')).toBeNull();
    expect(room.poolQuestions).toHaveLength(3);

    // Host can also submit up to 3 questions
    expect(canSubmitPoolQuestion(room, room.hostId)).toBe(true);
    const hostQ = addPoolQuestion(room, room.hostId, room.hostName, 'What is the best movie of all time?');
    expect(hostQ).not.toBeNull();
    expect(room.poolQuestions).toHaveLength(4);
  });

  it('author can delete their own pool question', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', questionPoolMode: true });
    const alice = addPlayerToRoom(room, 'Alice');
    const bob = addPlayerToRoom(room, 'Bob');
    const q1 = addPoolQuestion(room, alice.id, alice.name, 'What is your favorite childhood game?');

    expect(canDeletePoolQuestion(room, q1.id, bob.id)).toBe(false);
    expect(canDeletePoolQuestion(room, q1.id, alice.id)).toBe(true);

    const deleted = deletePoolQuestion(room, q1.id);
    expect(deleted.id).toBe(q1.id);
    expect(room.poolQuestions).toHaveLength(0);
  });

  it('host can discard any question for appropriateness/duplicate inspection', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', questionPoolMode: true });
    const alice = addPlayerToRoom(room, 'Alice');
    const q1 = addPoolQuestion(room, alice.id, alice.name, 'Inappropriate or duplicate question here?');

    expect(canDiscardPoolQuestion(room, alice.id)).toBe(false);
    expect(canDiscardPoolQuestion(room, room.hostId)).toBe(true);

    const discarded = discardPoolQuestion(room, q1.id);
    expect(discarded.id).toBe(q1.id);
    expect(room.poolQuestions).toHaveLength(0);
  });

  it('tracks player ready status and validates canStartGame', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', questionPoolMode: true });
    const alice = addPlayerToRoom(room, 'Alice');
    const bob = addPlayerToRoom(room, 'Bob');
    const charlie = addPlayerToRoom(room, 'Charlie');

    // Need at least 1 question
    expect(canStartGame(room)).toBe(false);

    addPoolQuestion(room, alice.id, alice.name, 'What is your favorite hobby to do on weekends?');
    expect(canStartGame(room)).toBe(false); // players not ready yet

    setPlayerReady(room, alice.id, true);
    setPlayerReady(room, bob.id, true);
    expect(canStartGame(room)).toBe(false); // charlie not ready

    setPlayerReady(room, charlie.id, true);
    expect(canStartGame(room)).toBe(true); // all 3 ready and >=1 question
  });

  it('privacy: broadcastRoom sends full poolQuestions list to host only, and only myPoolQuestions to regular players', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', questionPoolMode: true });
    const alice = addPlayerToRoom(room, 'Alice');
    const bob = addPlayerToRoom(room, 'Bob');

    addPoolQuestion(room, alice.id, alice.name, 'What is Alice secret question here?');
    addPoolQuestion(room, bob.id, bob.name, 'What is Bob secret question here?');

    const hostSocket = createTestSocket(room.hostId);
    const aliceSocket = createTestSocket(alice.id);
    const bobSocket = createTestSocket(bob.id);
    room.clients.add(hostSocket);
    room.clients.add(aliceSocket);
    room.clients.add(bobSocket);

    broadcastRoom(room);

    // Host sees both questions
    expect(hostSocket.sent[0].state.poolQuestions).toHaveLength(2);
    expect(hostSocket.sent[0].state.poolQuestionCount).toBe(2);

    // Alice sees 0 in public poolQuestions, but 1 in myPoolQuestions
    expect(aliceSocket.sent[0].state.poolQuestions).toHaveLength(0);
    expect(aliceSocket.sent[0].state.myPoolQuestions).toHaveLength(1);
    expect(aliceSocket.sent[0].state.myPoolQuestions[0].text).toBe('What is Alice secret question here?');
    expect(aliceSocket.sent[0].state.poolQuestionCount).toBe(2);

    // Bob sees only Bob's in myPoolQuestions
    expect(bobSocket.sent[0].state.poolQuestions).toHaveLength(0);
    expect(bobSocket.sent[0].state.myPoolQuestions).toHaveLength(1);
    expect(bobSocket.sent[0].state.myPoolQuestions[0].text).toBe('What is Bob secret question here?');
  });

  it('plays all pool questions across consecutive rounds and ends game on last question', () => {
    const room = createRoom({ hostName: 'Host', hostAccountId: 'host-account', questionPoolMode: true });
    const alice = addPlayerToRoom(room, 'Alice');
    const bob = addPlayerToRoom(room, 'Bob');
    const charlie = addPlayerToRoom(room, 'Charlie');

    addPoolQuestion(room, alice.id, alice.name, 'Question Number One for the test pool?');
    addPoolQuestion(room, bob.id, bob.name, 'Question Number Two for the test pool?');

    setPlayerReady(room, alice.id, true);
    setPlayerReady(room, bob.id, true);
    setPlayerReady(room, charlie.id, true);

    // Start round from lobby
    startRound(room);
    expect(room.phase).toBe('answer-collection');
    expect(room.questionPool).toHaveLength(2);
    expect(room.currentPoolQuestionIndex).toBe(0);
    expect(room.askingPlayerId).toBeNull(); // All players can answer
    expect(makeRoomState(room).questionAuthorName).toBe(room.questionPool[0].playerName);

    // All 3 players submit answers (including author)
    submitAnswer(room, alice.id, 'Alice answer');
    submitAnswer(room, bob.id, 'Bob answer');
    submitAnswer(room, charlie.id, 'Charlie answer');
    expect(room.answers).toHaveLength(3);

    // Lock answers and guess
    lockAnswers(room);
    expect(room.phase).toBe('guessing');
    expect(makeRoomState(room).questionAuthorName).toBeNull();

    // Clear answer queue to simulate completing all answer guessing in Question 1
    room.answerQueue = [];
    calculateRoundScores(room);
    expect(room.phase).toBe('round-end');

    // Advance round -> should start Question 2 (index 1)
    advanceGuessRound(room);
    expect(room.phase).toBe('answer-collection');
    expect(room.currentPoolQuestionIndex).toBe(1);

    // Answering for Question 2
    submitAnswer(room, alice.id, 'Alice answer 2');
    submitAnswer(room, bob.id, 'Bob answer 2');
    submitAnswer(room, charlie.id, 'Charlie answer 2');
    lockAnswers(room);
    room.answerQueue = [];
    calculateRoundScores(room);
    expect(room.phase).toBe('round-end');

    // Advance round -> no more questions in pool, should transition to game-end
    advanceGuessRound(room);
    expect(room.phase).toBe('game-end');
  });
});
