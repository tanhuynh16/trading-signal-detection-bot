import { describe, expect, it } from 'vitest';
import { isGlobalTelegramFault } from './telegram.js';

/**
 * Every case here was measured against the live Bot API, because the status
 * codes Telegram actually returns contradict what a docs-derived table
 * predicts — and getting this wrong means the circuit breaker never opens on
 * the two most likely misconfigurations.
 */
describe('isGlobalTelegramFault — measured against the live API', () => {
  it('treats a wrong chat id as global even though it answers 400', () => {
    // Live: chat_id 999999999 -> 400 "Bad Request: chat not found".
    // A status-only table calls this per-message and never opens the breaker,
    // leaving the misconfiguration to burn one failed send per evaluation.
    expect(
      isGlobalTelegramFault(400, '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}'),
    ).toBe(true);
  });

  it('treats an empty chat id as global', () => {
    // Live: chat_id "" -> 400 "Bad Request: chat_id is empty".
    expect(isGlobalTelegramFault(400, 'Bad Request: chat_id is empty')).toBe(true);
  });

  it('treats a revoked bot token as global even though it answers 404', () => {
    // Live: a malformed token -> 404 "Not Found", not the 401 one would expect,
    // because the bot path itself stops existing.
    expect(isGlobalTelegramFault(404, '{"ok":false,"error_code":404,"description":"Not Found"}')).toBe(true);
  });

  it('treats an un-started or blocking chat as global', () => {
    // The exact failure hit in the Phase 6 closeout run.
    expect(
      isGlobalTelegramFault(403, "Forbidden: bot can't initiate conversation with a user"),
    ).toBe(true);
    expect(isGlobalTelegramFault(403, 'Forbidden: bot was blocked by the user')).toBe(true);
  });

  it('keeps a malformed message per-message', () => {
    // One token with a pathological symbol must not silence every other token.
    expect(isGlobalTelegramFault(400, "Bad Request: can't parse entities")).toBe(false);
    expect(isGlobalTelegramFault(400, 'Bad Request: message text is empty')).toBe(false);
    expect(isGlobalTelegramFault(400, 'Bad Request: message is too long')).toBe(false);
  });

  it('never calls a server-side fault global; exhaustion decides those', () => {
    expect(isGlobalTelegramFault(500, 'Internal Server Error')).toBe(false);
    expect(isGlobalTelegramFault(429, 'Too Many Requests: retry after 30')).toBe(false);
  });

  it('matches the description case-insensitively', () => {
    expect(isGlobalTelegramFault(400, 'BAD REQUEST: CHAT NOT FOUND')).toBe(true);
  });
});
