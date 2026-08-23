import { beforeEach, describe, expect, it } from 'vitest';
import { redactDeep, redactSecrets, registerSecret, resetSecrets } from './redact.js';

/**
 * Spec §24/§25. These cases are drawn from a real leak: viem quotes the full
 * request URL — API key included — inside `error.message`, so the secret
 * arrives as a string value under the innocuous key `err`, where field-name
 * redaction never sees it.
 */
beforeEach(() => resetSecrets());

describe('redactSecrets', () => {
  it('scrubs an API key quoted inside a provider error message', () => {
    registerSecret('https://base-mainnet.g.alchemy.com/v2/super_secret_key_123');
    const message =
      'HTTP request failed.\nURL: https://base-mainnet.g.alchemy.com/v2/super_secret_key_123\nStatus: 429';
    const output = redactSecrets(message);
    expect(output).not.toContain('super_secret_key_123');
    expect(output).toContain('[REDACTED]');
  });

  it('scrubs the bare key even when the full URL is not quoted', () => {
    registerSecret('https://base-mainnet.g.alchemy.com/v2/super_secret_key_123');
    expect(redactSecrets('key=super_secret_key_123')).not.toContain('super_secret_key_123');
  });

  it('keeps the host so logs still say which provider failed', () => {
    const output = redactSecrets('URL: https://base-mainnet.g.alchemy.com/v2/abcdefghijklmnop');
    expect(output).toContain('base-mainnet.g.alchemy.com');
    expect(output).not.toContain('abcdefghijklmnop');
  });

  it('scrubs an unregistered telegram bot token by shape', () => {
    const output = redactSecrets('bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw-x');
    expect(output).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
  });

  it('leaves public data alone — token addresses must stay readable', () => {
    const address = '0xa2ebb0d51997ef1fba6b9d20051d0c96fb5705a4';
    expect(redactSecrets(`token=${address}`)).toContain(address);
  });

  it('ignores values too short to be secrets', () => {
    registerSecret('abc');
    expect(redactSecrets('abc def')).toBe('abc def');
  });
});

describe('redactDeep', () => {
  it('scrubs nested strings anywhere in a log payload', () => {
    registerSecret('https://rpc.example.com/v2/leaked_key_value_1234');
    const scrubbed = redactDeep({
      level: 'error',
      err: { message: 'failed calling https://rpc.example.com/v2/leaked_key_value_1234' },
      list: ['leaked_key_value_1234'],
    }) as Record<string, unknown>;

    expect(JSON.stringify(scrubbed)).not.toContain('leaked_key_value_1234');
    expect(scrubbed['level']).toBe('error');
  });

  it('preserves non-string values', () => {
    const out = redactDeep({ n: 42, b: true, nil: null }) as Record<string, unknown>;
    expect(out).toEqual({ n: 42, b: true, nil: null });
  });
});
