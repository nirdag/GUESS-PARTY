import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let createAuthService;
let tempDataDir;
let previousDataDir;

beforeAll(async () => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guess-party-auth-'));
  previousDataDir = process.env.GUESS_PARTY_DATA_DIR;
  process.env.GUESS_PARTY_DATA_DIR = tempDataDir;
  ({ createAuthService } = await import('./auth.js'));
});

beforeEach(() => {
  fs.rmSync(path.join(tempDataDir, 'auth.json'), { force: true });
});

afterAll(() => {
  fs.rmSync(tempDataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) {
    delete process.env.GUESS_PARTY_DATA_DIR;
  } else {
    process.env.GUESS_PARTY_DATA_DIR = previousDataDir;
  }
});

describe('auth.js: account statistics', () => {
  it('returns zero counts for an empty store', () => {
    const service = createAuthService();

    expect(service.getAccountStats()).toEqual({ totalAccounts: 0, verifiedAccounts: 0 });
  });

  it('counts all accounts and only verified accounts', () => {
    let firstVerificationToken;
    let secondVerificationToken;
    const service = createAuthService({
      sendVerificationEmail: ({ email, token }) => {
        if (email === 'first@example.com') firstVerificationToken = token;
        if (email === 'second@example.com') secondVerificationToken = token;
      },
    });

    service.signUp('first@example.com', 'password-one');
    service.signUp('second@example.com', 'password-two');
    service.verifyEmail(firstVerificationToken);

    expect(service.getAccountStats()).toEqual({ totalAccounts: 2, verifiedAccounts: 1 });
    expect(secondVerificationToken).toBeDefined();
  });

  it('publishes only aggregate fields when account stats change', () => {
    const snapshots = [];
    const service = createAuthService({
      onAccountStatsChanged: (stats) => snapshots.push(stats),
    });

    service.signUp('player@example.com', 'password-one');

    expect(snapshots).toEqual([{ totalAccounts: 1, verifiedAccounts: 0 }]);
    expect(Object.keys(snapshots[0]).sort()).toEqual(['totalAccounts', 'verifiedAccounts']);
  });
});
