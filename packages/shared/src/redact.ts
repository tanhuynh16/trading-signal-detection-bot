/**
 * Spec §24/§25: credentials must never reach the log stream.
 *
 * Field-name redaction is not sufficient on its own. Libraries embed the full
 * request URL in error messages — viem's HTTP errors quote
 * `https://host/v2/<api-key>` inside `error.message` — so a secret arrives as
 * part of a *string value* under an innocuous key like `err`. This module
 * scrubs the values themselves, wherever they appear.
 */

const registered = new Set<string>();

/**
 * Register a known secret at startup. Any later log line containing it, in any
 * field or in the message, has it replaced. Registering the literal value is
 * more reliable than pattern-matching, because it cannot miss a format we
 * failed to anticipate.
 */
export function registerSecret(value: string | undefined | null): void {
  if (!value) return;
  const trimmed = value.trim();
  // Very short values would match everywhere and destroy legitimate output.
  if (trimmed.length < 8) return;
  registered.add(trimmed);

  // An RPC URL's secret is its path; register that separately so a log line
  // quoting only the key still gets scrubbed.
  try {
    const url = new URL(trimmed);
    for (const segment of url.pathname.split('/')) {
      if (segment.length >= 12) registered.add(segment);
    }
    if (url.password) registered.add(url.password);
  } catch {
    // Not a URL; the literal registration above is enough.
  }
}

/** Credential shapes worth catching even if never registered. */
const PATTERNS: RegExp[] = [
  // Telegram bot tokens: 123456789:AA...
  /\bbot?\d{6,}:[A-Za-z0-9_-]{30,}\b/g,
  // Any URL with a long opaque path segment (Alchemy, Infura, QuickNode...).
  /(https?|wss?):\/\/([^/\s"']+)\/[^\s"']*/g,
  // Bare hex private keys.
  /\b0x[a-fA-F0-9]{64}\b(?=.*(?:key|secret|private))/gi,
];

export function redactSecrets(input: string): string {
  let output = input;
  for (const secret of registered) {
    if (secret && output.includes(secret)) {
      output = output.split(secret).join('[REDACTED]');
    }
  }
  output = output.replace(PATTERNS[0]!, '[REDACTED]');
  // Keep the host so the log still says which provider failed; drop the path.
  output = output.replace(PATTERNS[1]!, (_match, scheme, host) => `${scheme}://${host}/[REDACTED]`);
  return output;
}

/** Recursively scrub every string in a log payload. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));

  // Date and Error carry nothing in their own enumerable properties, so the
  // generic object walk below rebuilt them as `{}` — silently erasing every
  // timestamp and every raw error ever logged, including the unhandled-rejection
  // handler §24 exists to make visible. Handle both explicitly.
  if (value instanceof Date) return value;
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      type: value.name,
      message: redactSecrets(value.message),
    };
    if (value.stack) out['stack'] = redactSecrets(value.stack);
    // Own enumerable properties carry our errors' `context` and `retryable`.
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactDeep(item, depth + 1);
    }
    return out;
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDeep(item, depth + 1);
    }
    return out;
  }
  return value;
}

/** Test-only: clear registered secrets between cases. */
export function resetSecrets(): void {
  registered.clear();
}
