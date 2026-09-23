import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dataDirectory = process.env.GUESS_PARTY_DATA_DIR || path.join(process.cwd(), '.data');
const dataFile = path.join(dataDirectory, 'questions.json');
const supportedLanguages = new Set(['en', 'he']);
const minQuestionLength = 8;
const maxQuestionLength = 220;

function emptyStore() {
  return { questions: [] };
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

function publicQuestion(question) {
  return {
    id: question.id,
    text: question.text,
    language: question.language,
    // Defaults to the question's own id when it has no linked translation.
    translationGroupId: question.translationGroupId || question.id,
  };
}

function createQuestionService({ now = () => Date.now() } = {}) {
  function listQuestions(language) {
    if (!supportedLanguages.has(language)) {
      return [];
    }

    const store = readStore();
    return store.questions
      .filter((question) => question.language === language)
      .map(publicQuestion);
  }

  function addQuestion(language, text, translationGroupId) {
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
    const id = crypto.randomUUID();
    const question = {
      id,
      language,
      text: trimmed,
      createdAt: now(),
      translationGroupId: translationGroupId || id,
    };
    store.questions.push(question);
    writeStore(store);
    return { question: publicQuestion(question) };
  }

  function deleteQuestion(id) {
    const store = readStore();
    const initialLength = store.questions.length;
    store.questions = store.questions.filter((question) => question.id !== id);
    if (store.questions.length === initialLength) {
      return false;
    }
    writeStore(store);
    return true;
  }

  function getQuestionById(id) {
    const store = readStore();
    const question = store.questions.find((entry) => entry.id === id);
    return question ? publicQuestion(question) : null;
  }

  return { listQuestions, addQuestion, deleteQuestion, getQuestionById };
}

function otherSupportedLanguages(language) {
  return [...supportedLanguages].filter((code) => code !== language);
}

export { createQuestionService, minQuestionLength, maxQuestionLength, supportedLanguages, otherSupportedLanguages };
