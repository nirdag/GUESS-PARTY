import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dataDirectory = process.env.GUESS_PARTY_DATA_DIR || path.join(process.cwd(), '.data');
const dataFile = path.join(dataDirectory, 'auth.json');
const sessionLifetimeMs = 1000 * 60 * 60 * 24 * 30;
const verificationLifetimeMs = 1000 * 60 * 60 * 24;

function emptyStore() {
  return { users: [], sessions: [], verificationTokens: [], resetTokens: [] };
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

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [, salt, expected] = String(storedHash).split(':');
  if (!salt || !expected) return false;

  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function publicUser(user) {
  return user
    ? { id: user.id, email: user.email, emailVerified: user.emailVerified }
    : null;
}

function validateCredentials(email, password) {
  if (!/^\S+@\S+\.\S+$/.test(normalizeEmail(email))) return 'Enter a valid email address.';
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters.';
  return null;
}

function createAuthService({ sendVerificationEmail = () => {}, onAccountStatsChanged = () => {}, now = () => Date.now() } = {}) {
  function getAccountStats() {
    const store = readStore();
    return {
      totalAccounts: store.users.length,
      verifiedAccounts: store.users.filter((user) => user.emailVerified).length,
    };
  }

  function publishAccountStats() {
    onAccountStatsChanged(getAccountStats());
  }

  function signUp(email, password) {
    const normalizedEmail = normalizeEmail(email);
    const validationError = validateCredentials(normalizedEmail, password);
    if (validationError) return { error: validationError };

    const store = readStore();
    if (store.users.some((user) => user.email === normalizedEmail)) {
      return { error: 'An account with this email already exists.' };
    }

    const user = {
      id: crypto.randomUUID(),
      email: normalizedEmail,
      passwordHash: hashPassword(password),
      emailVerified: false,
      createdAt: now(),
    };
    const token = crypto.randomBytes(32).toString('hex');
    store.users.push(user);
    store.verificationTokens.push({ userId: user.id, tokenHash: hashToken(token), expiresAt: now() + verificationLifetimeMs });
    writeStore(store);
    publishAccountStats();
    sendVerificationEmail({ email: user.email, token });
    return { user: publicUser(user) };
  }

  function login(email, password) {
    const store = readStore();
    const user = store.users.find((entry) => entry.email === normalizeEmail(email));
    if (!user || !verifyPassword(password, user.passwordHash)) return { error: 'Invalid email or password.' };
    if (!user.emailVerified) return { error: 'Verify your email before creating a room.', code: 'EMAIL_NOT_VERIFIED' };

    const token = crypto.randomBytes(32).toString('hex');
    store.sessions = store.sessions.filter((session) => session.userId !== user.id);
    store.sessions.push({ tokenHash: hashToken(token), userId: user.id, expiresAt: now() + sessionLifetimeMs });
    writeStore(store);
    return { user: publicUser(user), token };
  }

  function getUserBySession(token) {
    if (!token) return null;
    const store = readStore();
    const session = store.sessions.find((entry) => entry.tokenHash === hashToken(token));
    if (!session || session.expiresAt <= now()) return null;
    return publicUser(store.users.find((user) => user.id === session.userId));
  }

  function verifyEmail(token) {
    const store = readStore();
    const entry = store.verificationTokens.find((item) => item.tokenHash === hashToken(token) && item.expiresAt > now());
    if (!entry) return false;
    const user = store.users.find((item) => item.id === entry.userId);
    if (!user) return false;
    user.emailVerified = true;
    store.verificationTokens = store.verificationTokens.filter((item) => item !== entry);
    writeStore(store);
    publishAccountStats();
    return true;
  }

  function logout(token) {
    const store = readStore();
    store.sessions = store.sessions.filter((entry) => entry.tokenHash !== hashToken(token));
    writeStore(store);
  }

  return { signUp, login, getUserBySession, verifyEmail, logout, getAccountStats, publicUser };
}

export { createAuthService, normalizeEmail, validateCredentials };