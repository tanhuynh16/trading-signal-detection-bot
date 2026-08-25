import { describe, expect, it } from 'vitest';
import {
  dexScreenerUrl,
  escapeHtml,
  formatAge,
  formatMoney,
  geckoTerminalUrl,
  renderAlert,
  type AlertPayload,
} from './format.js';

const payload = (over: Partial<AlertPayload> = {}): AlertPayload => ({
  alertLevel: 'STRONG',
  symbol: 'PEPE',
  tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
  poolAddress: '0xccccccccccccccccccccccccccccccccccccccc1',
  ageMinutes: 12,
  marketCapUsd: 420_000,
  liquidityUsd: 96_000,
  alphaScore: 84,
  coverage: 1,
  components: [
    { name: 'liquidity', raw: 66, weight: 0.2 },
    { name: 'momentum', raw: 78, weight: 0.3 },
    { name: 'holder', raw: 71, weight: 0.2 },
    { name: 'smartMoney', raw: null, weight: 0.3 },
  ],
  riskStatus: 'WARNING',
  riskFlags: [{ code: 'HOLDER_CONCENTRATION', severity: 'HIGH', message: 'top 10 hold 42%' }],
  triggerReason: 'FIRST_ALERT',
  ...over,
});

describe('§20 message structure', () => {
  it('renders every section the spec requires, in order', () => {
    const text = renderAlert(payload());
    expect(text).toContain('STRONG SIGNAL');
    expect(text).toContain('TOKEN: $PEPE');
    expect(text).toContain('CA: <code>0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1</code>');
    expect(text).toContain('Age: 12m');
    expect(text).toContain('MC: $420K');
    expect(text).toContain('Liquidity: $96K');
    expect(text).toContain('Score: 84/100');
    expect(text).toContain('Why:');
    expect(text).toContain('Risk:');
    expect(text.indexOf('Why:')).toBeLessThan(text.indexOf('Risk:'));
  });

  it('uses a distinct header per alert level', () => {
    expect(renderAlert(payload({ alertLevel: 'STRONG' }))).toContain('STRONG SIGNAL');
    expect(renderAlert(payload({ alertLevel: 'INTERESTING' }))).toContain('INTERESTING');
  });

  it('includes the full score breakdown (§20 requirement)', () => {
    const text = renderAlert(payload());
    expect(text).toContain('• Liquidity: 66/100');
    expect(text).toContain('• Momentum: 78/100');
    expect(text).toContain('• Holder: 71/100');
  });

  it('says a component is unmeasured rather than scoring it zero', () => {
    // The alert-side of plan G1: smartMoney is null with an empty seed list,
    // and "0/100" would read as "no smart money" rather than "we did not look".
    const text = renderAlert(payload());
    expect(text).toContain('• Smart Money: not measured');
    expect(text).not.toContain('Smart Money: 0/100');
  });

  it('surfaces partial evidence coverage', () => {
    const text = renderAlert(payload({ coverage: 0.7 }));
    expect(text).toContain('Evidence coverage: 70%');
  });

  it('omits the coverage line when everything was measured', () => {
    expect(renderAlert(payload({ coverage: 1 }))).not.toContain('Evidence coverage');
  });

  it('includes risk warnings (§20 requirement)', () => {
    expect(renderAlert(payload())).toContain('top 10 hold 42%');
  });

  it('states cleanly when there are no risk warnings', () => {
    const text = renderAlert(payload({ riskFlags: [], riskStatus: 'PASS' }));
    expect(text).toContain('PASS, no warnings');
  });

  it('distinguishes "not yet evaluated" from "no warnings"', () => {
    const text = renderAlert(payload({ riskFlags: [], riskStatus: null }));
    expect(text).toContain('not yet evaluated');
  });

  it('explains why a re-alert arrived', () => {
    expect(renderAlert(payload({ triggerReason: 'SCORE_MOVED' }))).toContain('score moved');
    expect(renderAlert(payload({ triggerReason: 'COOLDOWN_ELAPSED' }))).toContain('still active');
    // A first alert needs no explanation.
    expect(renderAlert(payload({ triggerReason: 'FIRST_ALERT' }))).not.toContain('(');
  });

  it('links to both explorers using the API-confirmed formats', () => {
    const text = renderAlert(payload());
    expect(text).toContain('https://dexscreener.com/base/0xccccccccccccccccccccccccccccccccccccccc1');
    expect(text).toContain(
      'https://www.geckoterminal.com/base/pools/0xccccccccccccccccccccccccccccccccccccccc1',
    );
  });
});

describe('HTML injection — security, not formatting', () => {
  it('renders a hostile token symbol inert', () => {
    // Anyone can deploy a token with this name. Unescaped it becomes a live
    // link in the chat, which is a phishing vector aimed at the reader.
    const hostile = '<a href="http://evil.example">Claim airdrop</a>';
    const text = renderAlert(payload({ symbol: hostile }));

    expect(text).not.toContain('<a href="http://evil.example">');
    expect(text).toContain('&lt;a href=&quot;http://evil.example&quot;&gt;'.replace(/&quot;/g, '"'));
  });

  it('escapes a script tag in the symbol', () => {
    const text = renderAlert(payload({ symbol: '<script>x</script>' }));
    expect(text).not.toContain('<script>');
    expect(text).toContain('&lt;script&gt;');
  });

  it('escapes ampersands so entities cannot be smuggled', () => {
    const text = renderAlert(payload({ symbol: '&lt;b&gt;' }));
    expect(text).toContain('&amp;lt;b&amp;gt;');
  });

  it('escapes hostile risk-flag text too', () => {
    // Flag messages can embed provider-supplied or token-supplied strings.
    const text = renderAlert(
      payload({ riskFlags: [{ code: 'X', severity: 'HIGH', message: '<b>bold</b>' }] }),
    );
    expect(text).not.toContain('<b>bold</b>');
    expect(text).toContain('&lt;b&gt;');
  });

  it('leaves the only intentional markup intact', () => {
    const text = renderAlert(payload());
    expect(text).toContain('<code>');
    expect(text).toContain('<a href="https://dexscreener.com/');
  });

  it('escapes the three HTML-significant characters and nothing else', () => {
    expect(escapeHtml('a&b<c>d')).toBe('a&amp;b&lt;c&gt;d');
    // Markdown characters need no escaping in HTML mode — a common source of
    // MarkdownV2 send failures.
    expect(escapeHtml('a_b*c[d]')).toBe('a_b*c[d]');
  });
});

describe('formatMoney', () => {
  it('uses compact notation as §20 does', () => {
    expect(formatMoney(420_000)).toBe('$420K');
    expect(formatMoney(96_000)).toBe('$96K');
    expect(formatMoney(1_200_000)).toBe('$1.2M');
    expect(formatMoney(2_500_000_000)).toBe('$2.5B');
  });

  it('keeps precision for sub-dollar values', () => {
    // Meme tokens routinely price far below a cent; $0.00 would look broken.
    expect(formatMoney(0.0000042)).toContain('0.00000420');
  });

  it('says not measured rather than $0 for null', () => {
    expect(formatMoney(null)).toBe('not measured');
  });

  it('rejects non-finite values', () => {
    expect(formatMoney(Number.NaN)).toBe('not measured');
    expect(formatMoney(Number.POSITIVE_INFINITY)).toBe('not measured');
  });

  it('renders a genuine zero as $0, distinct from null', () => {
    expect(formatMoney(0)).toBe('$0.00');
  });
});

describe('formatAge', () => {
  it('renders minutes under an hour', () => {
    expect(formatAge(12)).toBe('12m');
    expect(formatAge(59.9)).toBe('59m');
  });

  it('renders hours and minutes beyond that', () => {
    expect(formatAge(60)).toBe('1h');
    expect(formatAge(83)).toBe('1h 23m');
  });

  it('handles nonsense input', () => {
    expect(formatAge(-1)).toBe('not measured');
    expect(formatAge(Number.NaN)).toBe('not measured');
  });
});

describe('link builders', () => {
  it('build the confirmed URL shapes', () => {
    expect(dexScreenerUrl('0xabc')).toBe('https://dexscreener.com/base/0xabc');
    expect(geckoTerminalUrl('0xabc')).toBe('https://www.geckoterminal.com/base/pools/0xabc');
  });
});
