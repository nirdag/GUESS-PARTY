// Fallback used only when ADMIN_EMAILS env var is unset (e.g. local dev without a .env).
// Never rely on this list in production — set ADMIN_EMAILS in the environment instead,
// otherwise every deploy from this shared repo file would overwrite prod's admin list.
const DEFAULT_ADMIN_EMAILS = [
  'admin@guess-party.local','dafna@gmail.com'
];

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Comma-separated list, e.g. "owner@example.com,ops@example.com" (set per-environment: Azure App
// Service > Configuration > Application settings for prod, .env/shell env for local dev).
function readAdminEmails() {
  const raw = process.env.ADMIN_EMAILS;
  if (!raw) {
    return DEFAULT_ADMIN_EMAILS;
  }

  return raw.split(',').map(normalizeEmail).filter(Boolean);
}

const ADMIN_EMAILS = readAdminEmails();

function isAdminEmail(email) {
  return ADMIN_EMAILS.includes(normalizeEmail(email));
}

export { ADMIN_EMAILS, isAdminEmail };
