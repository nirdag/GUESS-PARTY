import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let createUserQuestionService;
let tempDataDir;

beforeAll(async () => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guess-party-user-questions-'));
  process.env.GUESS_PARTY_DATA_DIR = tempDataDir;
  ({ createUserQuestionService } = await import('./userQuestions.js'));
});

afterAll(() => {
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

describe('userQuestions.js: createUserQuestionService', () => {
  it('addUserQuestion rejects when no userId is provided', () => {
    const service = createUserQuestionService();
    const result = service.addUserQuestion(null, 'en', 'A valid question text?');
    expect(result.error).toBeDefined();
  });

  it('addUserQuestion rejects unsupported languages', () => {
    const service = createUserQuestionService();
    const result = service.addUserQuestion('user-1', 'fr', 'A valid question text?');
    expect(result.error).toBeDefined();
  });

  it('addUserQuestion rejects text shorter than the minimum length', () => {
    const service = createUserQuestionService();
    const result = service.addUserQuestion('user-1', 'en', 'short');
    expect(result.error).toBeDefined();
  });

  it('addUserQuestion accepts valid input and listUserQuestions returns it', () => {
    const service = createUserQuestionService();
    const added = service.addUserQuestion('user-1', 'en', 'What is the best pizza topping?');
    expect(added.error).toBeUndefined();
    expect(added.question.text).toBe('What is the best pizza topping?');

    const list = service.listUserQuestions('user-1', 'en');
    expect(list.some((question) => question.id === added.question.id)).toBe(true);
  });

  it('listUserQuestions filters by both userId and language', () => {
    const service = createUserQuestionService();
    service.addUserQuestion('user-1', 'en', 'An English question here?');
    service.addUserQuestion('user-1', 'he', 'שאלה בעברית כאן?');
    service.addUserQuestion('user-2', 'en', 'A different user\'s question here?');

    const userOneEnglish = service.listUserQuestions('user-1', 'en');
    expect(userOneEnglish.some((question) => question.text.includes('different user'))).toBe(false);
    expect(userOneEnglish.every((question) => !question.text.includes('עברית'))).toBe(true);
  });

  it('deleteUserQuestion removes an existing question owned by that user and returns true', () => {
    const service = createUserQuestionService();
    const added = service.addUserQuestion('user-1', 'en', 'A question to be deleted?');
    expect(service.deleteUserQuestion('user-1', added.question.id)).toBe(true);
    expect(service.listUserQuestions('user-1', 'en').some((question) => question.id === added.question.id)).toBe(false);
  });

  it('deleteUserQuestion returns false for an unknown id', () => {
    const service = createUserQuestionService();
    expect(service.deleteUserQuestion('user-1', 'not-a-real-id')).toBe(false);
  });

  it('deleteUserQuestion refuses to delete a question owned by another user', () => {
    const service = createUserQuestionService();
    const added = service.addUserQuestion('user-1', 'en', 'Only user-1 should be able to delete this?');
    expect(service.deleteUserQuestion('user-2', added.question.id)).toBe(false);
    expect(service.listUserQuestions('user-1', 'en').some((question) => question.id === added.question.id)).toBe(true);
  });
});
