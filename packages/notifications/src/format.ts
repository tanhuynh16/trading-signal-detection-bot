import type { AlertLevel, AlertTriggerReason, RiskFlag, ScoreComponent } from '@sdb/domain';

/**
 * §20 message rendering.
 *
 * Pure and deterministic so the exact wire text is testable without a network.
 * Telegram HTML parse mode is used rather than MarkdownV2: HTML needs only
 * three characters escaped, where MarkdownV2 needs eighteen and silently
 * rejects the whole message if one is missed.
 */

export type AlertPayload = {
  alertLevel: AlertLevel;
  /** Attacker-controlled. Sanitised at ingest, escaped again here. */
  symbol: string | null;
  tokenAddress: string;
  poolAddress: string;
  ageMinutes: number;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  alphaScore: number;
  coverage: number;
  components: ScoreComponent[];
  riskStatus: string | null;
  riskFlags: RiskFlag[];
  /** Non-first triggers explain why a second message arrived. */
  triggerReason: AlertTriggerReason | null;
};

/**
 * Escape for Telegram HTML parse mode.
 *
 * This is a security control, not formatting. Anyone can deploy a token named
 * `<a href="http://evil">Airdrop</a>`; unescaped, that renders as a live link
 * in the chat. Phase 2's `sanitizeText` already strips control characters at
 * ingest, but HTML injection survives it.
 */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Compact money, as §20 renders it: $420K, $1.2M. */
export function formatMoney(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return NOT_MEASURED;
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${trim(value / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `$${trim(value / 1_000_000)}M`;
  if (abs >= 1_000) return `$${trim(value / 1_000)}K`;
  if (abs >= 1) return `$${trim(value)}`;
  // Meme tokens are routinely priced far below a cent; rounding to 2dp would
  // print $0.00 and look like a bug.
  return `$${value.toPrecision(3)}`;
}

function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function formatAge(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return NOT_MEASURED;
  const whole = Math.floor(minutes);
  if (whole < 60) return `${whole}m`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * Null renders as an explicit statement, never 0 or $0.
 *
 * The same discipline §15 imposes on features: a component G1 could not compute
 * says so. "$0 liquidity" would read as worthless rather than unknown.
 */
const NOT_MEASURED = 'not measured';

const COMPONENT_LABELS: Record<string, string> = {
  liquidity: 'Liquidity',
  momentum: 'Momentum',
  holder: 'Holder',
  smartMoney: 'Smart Money',
};

const TRIGGER_LABELS: Record<AlertTriggerReason, string> = {
  FIRST_ALERT: '',
  LEVEL_UPGRADED: 'upgraded',
  SCORE_MOVED: 'score moved',
  COOLDOWN_ELAPSED: 'still active',
};

const SEVERITY_ICONS: Record<string, string> = {
  CRITICAL: '\u{1F6D1}',
  HIGH: '⚠',
  MEDIUM: '⚠',
  LOW: 'ℹ',
};

function header(level: AlertLevel): string {
  return level === 'STRONG' ? '\u{1F6A8} STRONG SIGNAL' : '\u{1F440} INTERESTING';
}

export function dexScreenerUrl(poolAddress: string): string {
  // Format taken verbatim from the `url` field DexScreener's own pairs API
  // returns for a Base pool.
  return `https://dexscreener.com/base/${poolAddress}`;
}

export function geckoTerminalUrl(poolAddress: string): string {
  // Network slug `base` confirmed against GeckoTerminal's API.
  return `https://www.geckoterminal.com/base/pools/${poolAddress}`;
}

/** Render one alert as Telegram HTML. */
export function renderAlert(payload: AlertPayload): string {
  const lines: string[] = [];

  const trigger = payload.triggerReason ? TRIGGER_LABELS[payload.triggerReason] : '';
  lines.push(trigger ? `${header(payload.alertLevel)} (${trigger})` : header(payload.alertLevel));

  const symbol = payload.symbol ? escapeHtml(payload.symbol) : 'UNKNOWN';
  lines.push(`TOKEN: $${symbol}`);
  // Monospace so the address is tap-to-copy in the client.
  lines.push(`CA: <code>${escapeHtml(payload.tokenAddress)}</code>`);
  lines.push(`Age: ${formatAge(payload.ageMinutes)}`);
  lines.push(`MC: ${formatMoney(payload.marketCapUsd)}`);
  lines.push(`Liquidity: ${formatMoney(payload.liquidityUsd)}`);
  lines.push(`Score: ${Math.round(payload.alphaScore)}/100`);

  // §20: "Notification must include score breakdown."
  lines.push('');
  lines.push('Why:');
  for (const component of payload.components) {
    const label = COMPONENT_LABELS[component.name] ?? component.name;
    const value = component.raw === null ? NOT_MEASURED : `${Math.round(component.raw)}/100`;
    lines.push(`• ${label}: ${value}`);
  }
  // Coverage explains a score computed on part of the picture (plan G1).
  if (payload.coverage < 1) {
    lines.push(`• Evidence coverage: ${Math.round(payload.coverage * 100)}%`);
  }

  // §20: "...and risk warnings."
  lines.push('');
  lines.push('Risk:');
  if (payload.riskFlags.length === 0) {
    lines.push(
      payload.riskStatus === null
        ? '• not yet evaluated'
        : `• ${escapeHtml(payload.riskStatus)}, no warnings`,
    );
  } else {
    for (const flag of payload.riskFlags) {
      const icon = SEVERITY_ICONS[flag.severity] ?? '⚠';
      lines.push(`${icon} ${escapeHtml(flag.message)}`);
    }
  }

  lines.push('');
  lines.push(
    `<a href="${dexScreenerUrl(payload.poolAddress)}">DexScreener</a> | ` +
      `<a href="${geckoTerminalUrl(payload.poolAddress)}">GeckoTerminal</a>`,
  );

  return lines.join('\n');
}
