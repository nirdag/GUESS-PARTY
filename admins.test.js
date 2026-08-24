import { describe, it, expect } from 'vitest';
import { isAdminEmail, ADMIN_EMAILS } from './admins.js';

describe('admins.js: isAdminEmail', () => {
  it('returns true for an email in the allow-list', () => {
    expect(isAdminEmail(ADMIN_EMAILS[0])).toBe(true);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(isAdminEmail(`  ${ADMIN_EMAILS[0].toUpperCase()}  `)).toBe(true);
  });

  it('returns false for an email not in the allow-list', () => {
    expect(isAdminEmail('not-an-admin@example.com')).toBe(false);
  });

  it('returns false for empty/undefined input', () => {
    expect(isAdminEmail('')).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
  });
});
