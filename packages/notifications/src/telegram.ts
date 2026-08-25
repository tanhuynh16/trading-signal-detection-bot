import { InvalidDataError, TransientProviderError } from '@sdb/shared';

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
      throw new TransientProviderError('telegram request failed', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    if (response.ok) return;

    const body = await response.text().catch(() => '');

    // 429 carries a retry_after; 5xx is Telegram's problem, not ours.
    if (response.status === 429 || response.status >= 500) {
      throw new TransientProviderError(`telegram responded ${response.status}`, {
        cause: body.slice(0, 200),
      });
    }

    // 400/401/403 mean the request itself is wrong — a bad chat id, a revoked
    // token, or malformed HTML. Retrying cannot fix any of those, and doing so
    // would hide the real cause behind exhausted attempts.
    throw new InvalidDataError(`telegram rejected the message (${response.status})`, {
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
