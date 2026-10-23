import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dataDirectory = process.env.GUESS_PARTY_DATA_DIR || path.join(process.cwd(), '.data');
const dataFile = path.join(dataDirectory, 'questions.json');
const supportedLanguages = new Set(['en', 'he']);
const minQuestionLength = 8;
const maxQuestionLength = 220;
const defaultQuestionSeedVersion = 1;
const defaultQuestions = [
  'If your life had a theme song that played whenever you entered a room, what would it be?',
  'What ordinary task would you turn into an Olympic sport, and how would you do?',
  'What object in your home would make the most interesting museum exhibit?',
  'Which fictional world would you visit for a weekend, and what would you do first?',
  'What very specific, harmless opinion would you happily defend for five minutes?',
  'What would your personal award be called, and what would you win it for?',
  'What food would you choose to represent your personality?',
  'What would be the least useful superpower you would still be excited to have?',
  'If pets could leave online reviews of their humans, what would yours say?',
  'What would your future self be surprised to learn about your life right now?',
  'What is something you are oddly good at that rarely comes in handy?',
  'What made-up holiday would you add to the calendar, and how would people celebrate?',
  'If you could add one completely unnecessary room to your home, what would it be?',
  'What would you name a boat, even if you never plan to own one?',
  'What is the funniest thing you believed when you were little?',
  'Which everyday object would be the most dramatic if it could talk?',
  'What job would you be hilariously unqualified for but still want to try for a day?',
  'What song would make the funniest entrance music for you?',
  'Which chore would you happily outsource to a tiny team of well-paid helpers?',
  'What small purchase has brought you an unreasonable amount of joy?',
  "If you could borrow someone else's routine for one day, whose would you try?",
  'What sound instantly takes you back to a particular place or time?',
  'What would the title of your autobiography be if it had to sound like a comedy?',
  'What would your ideal imaginary cafe serve, and what would it be called?',
  'If you had to give a short class on something you know, what would you teach?',
  'Which animal would be the funniest roommate, and what house rule would it break?',
  'What is a completely harmless thing that you take more seriously than most people?',
  'If you could invent a new flavor of ice cream, what would you put in it?',
  'What would you put in a time capsule that would confuse people in a hundred years?',
  'What is the most creative excuse you have heard for being late?',
  "If your personality were a weather forecast, what would today's forecast say?",
  'Which board game or party game best matches how you approach life?',
  'What three items would you bring to a very boring desert island?',
  'What is a compliment you still remember because it was so unexpected?',
  'If you had to wear one costume every Friday, what would you choose?',
  'What is a silly skill you wish you could master instantly?',
  'Which everyday object would you most like to make slightly better?',
  'What would you choose as the mascot for your group of friends?',
  'What is the best name you have ever heard for a pet?',
  'If you could make one minor inconvenience disappear forever, which one would you pick?',
  'What would your dream food truck serve, and where would you park it?',
  'Which word or phrase do you say more often than you realize?',
  'What fictional character would be the worst person to share a group chat with?',
  'If you could create a new rule everyone had to follow for one day, what would it be?',
  'What is something you tried once and unexpectedly loved?',
  'What would you choose as the soundtrack for a slow-motion walk into a room?',
  'If you could ask any animal one question and understand its answer, what would you ask?',
  'What is the strangest thing you have ever found in a pocket or bag?',
  'If you could swap one daily habit with someone here, whose would you borrow?',
  'What would be the most surprising thing for your friends to discover you are secretly great at?',
];

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

function normalizeQuestionText(text) {
  return text.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function seedDefaultQuestions(store, now) {
  if ((store.seedVersion || 0) >= defaultQuestionSeedVersion) {
    return;
  }

  const existingTexts = new Set(store.questions
    .filter((question) => question.language === 'en' && typeof question.text === 'string')
    .map((question) => normalizeQuestionText(question.text)));
  for (const text of defaultQuestions) {
    const normalizedText = normalizeQuestionText(text);
    if (existingTexts.has(normalizedText)) {
      continue;
    }

    const id = crypto.randomUUID();
    store.questions.push({
      id,
      language: 'en',
      text,
      createdAt: now(),
      translationGroupId: id,
    });
    existingTexts.add(normalizedText);
  }

  store.seedVersion = defaultQuestionSeedVersion;
  writeStore(store);
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
  seedDefaultQuestions(readStore(), now);

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
    const groupId = translationGroupId || null;
    if (groupId && store.questions.some((question) =>
      (question.translationGroupId || question.id) === groupId && question.language === language)) {
      return { error: 'A question already exists for this language in the translation group.' };
    }

    const id = crypto.randomUUID();
    const question = {
      id,
      language,
      text: trimmed,
      createdAt: now(),
      translationGroupId: groupId || id,
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

  function getTranslationGroup(translationGroupId) {
    if (!translationGroupId) {
      return [];
    }

    const store = readStore();
    return store.questions
      .filter((question) => (question.translationGroupId || question.id) === translationGroupId)
      .map(publicQuestion);
  }

  function deleteTranslationGroup(translationGroupId) {
    if (!translationGroupId) {
      return false;
    }

    const store = readStore();
    const initialLength = store.questions.length;
    store.questions = store.questions.filter((question) => (question.translationGroupId || question.id) !== translationGroupId);
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

  return { listQuestions, addQuestion, deleteQuestion, deleteTranslationGroup, getQuestionById, getTranslationGroup };
}

function getTranslationTargetError(sourceLanguage, targetLanguage, groupQuestions = []) {
  if (!supportedLanguages.has(targetLanguage)) {
    return 'Unsupported target language.';
  }
  if (targetLanguage === sourceLanguage) {
    return 'Target language must differ from the source language.';
  }
  if (groupQuestions.some((question) => question.language === targetLanguage)) {
    return 'A translation already exists for this language.';
  }
  return null;
}

export { createQuestionService, minQuestionLength, maxQuestionLength, supportedLanguages, getTranslationTargetError };
