import { InvalidDataError, TransientProviderError } from '@sdb/shared';

/**
 * Telegram 400s that describe the CONFIGURATION, not this message.
 *
 * Measured against the live API: a wrong chat id answers
 * `400 Bad Request: chat not found` — not the 401/403 an HTTP-status table
 * would predict. Classifying by status alone therefore misses the single most
 * likely misconfiguration, so the breaker would never open on it.
 *
 * Everything here fails identically for every token until an operator acts.
 */
const GLOBAL_DESCRIPTIONS = [
  'chat not found',
  'chat_id is empty',
  'bot was blocked by the user',
  "bot can't initiate conversation with a user",
  'user is deactivated',
  'bot was kicked',
  'have no rights to send a message',
  'not enough rights',
  'chat was upgraded',
];

/**
 * Is this fault the transport, rather than the one message?
 *
 * 401 (revoked token) and 403 (chat inaccessible) always are. So is 404: a
 * malformed or revoked bot token answers `404 Not Found`, because the bot path
 * itself stops existing — not the 401 the docs imply.
 *
 * A 400 is per-message by default — a token whose symbol produced bad markup
 * must never silence alerting for every other token — unless its description
 * names a configuration fault.
 */
export function isGlobalTelegramFault(status: number, description: string): boolean {
  if (status === 401 || status === 403 || status === 404) return true;
  if (status !== 400) return false;

  const text = description.toLowerCase();
  return GLOBAL_DESCRIPTIONS.some((phrase) => text.includes(phrase.toLowerCase()));
}

/**
 * Delivery transport, behind an interface so it is swappable and mockable
 * (§9, §29). Tests use a stub; nothing in the pipeline knows about Telegram.
 */
export interface Notifier {
  readonly name: string;
  send(text: string): Promise<void>;
}

export type TelegramConfig = {
  botToken: string;
  chatId: string;
  baseUrl?: string;
  timeoutMs?: number;
};

/**
 * Telegram Bot API sender.
 *
 * Error classification matters here more than usual. §20 requires that a
 * failure never discard the signal, so transient problems must retry — but a
 * permanently wrong chat id would otherwise burn all five attempts on every
 * alert forever, and bury real failures in the audit table.
 */
export class TelegramNotifier implements Notifier {
  readonly name = 'telegram';

  constructor(private readonly config: TelegramConfig) {}

  async send(text: string): Promise<void> {
    const base = this.config.baseUrl ?? 'https://api.telegram.org';
    const url = `${base}/bot${this.config.botToken}/sendMessage`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text,
          parse_mode: 'HTML',
          // Link previews would turn every alert into a large card and bury
          // the message content.
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
      });
    } catch (error) {
      // Network failure or timeout: the message may yet get through on retry.
      // No httpStatus — the request never reached Telegram.
      throw new TransientProviderError('telegram request failed', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    if (response.ok) return;

    const body = await response.text().catch(() => '');

    // 429 carries a retry_after; 5xx is Telegram's problem, not ours.
    // httpStatus is carried in the error context so the circuit breaker can
    // tell a global configuration fault (401/403) from a per-message rejection
    // (400). Without it every permanent failure looks alike and one malformed
    // message would silence alerting for every token.
    if (response.status === 429 || response.status >= 500) {
      throw new TransientProviderError(`telegram responded ${response.status}`, {
        httpStatus: response.status,
        global: false,
        cause: body.slice(0, 200),
      });
    }

    // 400/401/403/404 mean the request itself is wrong — a bad chat id, a
    // revoked token, or malformed HTML. Retrying cannot fix any of those, and
    // doing so would hide the real cause behind exhausted attempts.
    //
    // `global` is decided here rather than by the circuit breaker: only this
    // adapter knows Telegram's error vocabulary, and the status code alone is
    // not enough to separate a broken configuration from a bad message.
    throw new InvalidDataError(`telegram rejected the message (${response.status})`, {
      httpStatus: response.status,
      global: isGlobalTelegramFault(response.status, body),
      cause: body.slice(0, 200),
    });
  }
}

/**
 * Records what would have been sent without contacting Telegram.
 *
 * Used when credentials are absent so the pipeline stays exercisable end to
 * end, and by tests that assert on the rendered text.
 */
export class RecordingNotifier implements Notifier {
  readonly name = 'recording';
  readonly sent: string[] = [];

  constructor(private readonly onSend?: (text: string) => void) {}

  async send(text: string): Promise<void> {
    this.sent.push(text);
    this.onSend?.(text);
  }
}

/** Always fails, for exercising the §20 retry and FAILED paths. */
export class FailingNotifier implements Notifier {
  readonly name = 'failing';
  constructor(private readonly error: Error) {}
  async send(): Promise<void> {
    throw this.error;
  }
}
