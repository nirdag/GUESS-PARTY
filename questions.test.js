import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let createQuestionService;
let tempDataDir;

beforeAll(async () => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guess-party-questions-'));
  process.env.GUESS_PARTY_DATA_DIR = tempDataDir;
  ({ createQuestionService } = await import('./questions.js'));
});

afterAll(() => {
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

describe('questions.js: createQuestionService', () => {
  it('addQuestion rejects unsupported languages', () => {
    const service = createQuestionService();
    const result = service.addQuestion('fr', 'A valid question text?');
    expect(result.error).toBeDefined();
  });

  it('addQuestion rejects text shorter than the minimum length', () => {
    const service = createQuestionService();
    const result = service.addQuestion('en', 'short');
    expect(result.error).toBeDefined();
  });

  it('addQuestion accepts valid input and listQuestions returns it', () => {
    const service = createQuestionService();
    const added = service.addQuestion('en', 'What is the best pizza topping?');
    expect(added.error).toBeUndefined();
    expect(added.question.text).toBe('What is the best pizza topping?');

    const list = service.listQuestions('en');
    expect(list.some((question) => question.id === added.question.id)).toBe(true);
  });

  it('listQuestions filters by language', () => {
    const service = createQuestionService();
    service.addQuestion('en', 'An English question here?');
    service.addQuestion('he', 'שאלה בעברית כאן?');

    const englishOnly = service.listQuestions('en');
    expect(englishOnly.every((question) => !question.text.includes('עברית'))).toBe(true);
  });

  it('deleteQuestion removes an existing question and returns true', () => {
    const service = createQuestionService();
    const added = service.addQuestion('en', 'A question to be deleted?');
    expect(service.deleteQuestion(added.question.id)).toBe(true);
    expect(service.listQuestions('en').some((question) => question.id === added.question.id)).toBe(false);
  });

  it('deleteQuestion returns false for an unknown id', () => {
    const service = createQuestionService();
    expect(service.deleteQuestion('not-a-real-id')).toBe(false);
  });

  it('addQuestion defaults translationGroupId to its own id when not linked', () => {
    const service = createQuestionService();
    const added = service.addQuestion('en', 'A standalone question here?');
    expect(added.question.translationGroupId).toBe(added.question.id);
    expect(added.question.language).toBe('en');
  });

  it('addQuestion links translationGroupId to a source question when provided', () => {
    const service = createQuestionService();
    const original = service.addQuestion('en', 'What is your favorite season?');
    const translated = service.addQuestion('he', 'מה העונה המועדפת עליך?', original.question.translationGroupId);
    expect(translated.question.translationGroupId).toBe(original.question.translationGroupId);
    expect(translated.question.translationGroupId).not.toBe(translated.question.id);
  });

  it('getQuestionById returns the public shape for a known id and null otherwise', () => {
    const service = createQuestionService();
    const added = service.addQuestion('en', 'Where would you go on vacation?');
    expect(service.getQuestionById(added.question.id)).toEqual(added.question);
    expect(service.getQuestionById('not-a-real-id')).toBeNull();
  });
});
