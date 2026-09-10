import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { minQuestionLength, maxQuestionLength } from './questions.js';

const dataDirectory = process.env.GUESS_PARTY_DATA_DIR || path.join(process.cwd(), '.data');
const dataFile = path.join(dataDirectory, 'user-questions.json');
const supportedLanguages = new Set(['en', 'he']);

function emptyStore() {
  return { userQuestions: [] };
}

function readStore() {
  try {
    return { ...emptyStore(), ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) };
  } catch {
    return emptyStore();
  }
}

function writeStore(store) {
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(store, null, 2));
}

function publicUserQuestion(question) {
  return { id: question.id, text: question.text };
}

function createUserQuestionService({ now = () => Date.now() } = {}) {
  function listUserQuestions(userId, language) {
    if (!userId || !supportedLanguages.has(language)) {
      return [];
    }

    const store = readStore();
    return store.userQuestions
      .filter((question) => question.userId === userId && question.language === language)
      .map(publicUserQuestion);
  }

  function addUserQuestion(userId, language, text) {
    if (!userId) {
      return { error: 'Log in required.' };
    }
    if (!supportedLanguages.has(language)) {
      return { error: 'Unsupported language.' };
    }

    const trimmed = String(text || '').trim();
    if (trimmed.length < minQuestionLength) {
      return { error: `Question must be at least ${minQuestionLength} characters.` };
    }
    if (trimmed.length > maxQuestionLength) {
      return { error: `Question must be at most ${maxQuestionLength} characters.` };
    }

    const store = readStore();
    const question = {
      id: crypto.randomUUID(),
      userId,
      language,
      text: trimmed,
      createdAt: now(),
    };
    store.userQuestions.push(question);
    writeStore(store);
    return { question: publicUserQuestion(question) };
  }

  function deleteUserQuestion(userId, id) {
    const store = readStore();
    const initialLength = store.userQuestions.length;
    // Only removes the question when it's owned by this user, so one account can't delete another's.
    store.userQuestions = store.userQuestions.filter((question) => !(question.id === id && question.userId === userId));
    if (store.userQuestions.length === initialLength) {
      return false;
    }
    writeStore(store);
    return true;
  }

  return { listUserQuestions, addUserQuestion, deleteUserQuestion };
}

export { createUserQuestionService };
