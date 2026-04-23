/**
 * PLAN-OF-TRUTH A-6 — 10 consecutive OK-CONTINUE autonomous gate (SCAFFOLD).
 *
 * Passive observer — the backend must be running independently (via
 * `npm run v3:start-omni`) with real panes generating real events.
 *
 * Counts consecutive "continue" actions in /api/orchestrator/decisions with
 * classification.verdict=mechanics (auto-executed, not escalated, not no_op).
 * The chain resets on any escalate/error/kill. Pass when ≥ 10 contiguous
 * OK-CONTINUEs accumulate.
 *
 * Usage:
 *     THEORCHESTRA_PORT=4300 THEORCHESTRA_TOKEN=<tok> \
 *       npx tsx scripts/v3-a6-ok-continue-gate.ts
 *
 * Override observation window (default 2h):
 *     A6_MINUTES=30 npx tsx scripts/v3-a6-ok-continue-gate.ts
 *
 * NOTE: this is a scaffold. Real validation requires active omniclaude
 * decision flow (panes hitting idle+prompt situations). Without live events
 * the script will report FAIL regardless. That's honest — A-6 is a spec
 * gate that needs real usage, not synthesized fixtures.
 */

const PORT = Number(process.env.THEORCHESTRA_PORT ?? '4300');
const TOKEN = process.env.THEORCHESTRA_TOKEN ?? '';
const MINUTES = Number(process.env.A6_MINUTES ?? '120');
const REQUIRED = 10;

interface Decision {
  ts: string;
  action?: { kind?: string; reason?: string };
  classification?: { verdict?: string; reason?: string };
  executed?: boolean;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function fetchDecisions(): Promise<Decision[]> {
  try {
    const r = await fetch(
      `http://127.0.0.1:${PORT}/api/orchestrator/decisions?limit=200`,
      {
        headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!r.ok) return [];
    const body = (await r.json()) as { decisions?: Decision[] };
    return body.decisions ?? [];
  } catch {
    return [];
  }
}

function isOkContinue(d: Decision): boolean {
  const kind = d.action?.kind ?? '';
  const verdict = d.classification?.verdict ?? '';
  const reasonBad = /escalate|error|kill|abort|veto/i.test(d.classification?.reason ?? '');
  return (
    (kind === 'continue' || kind === 'send_prompt' || kind === 'send_key') &&
    verdict === 'mechanics' &&
    d.executed === true &&
    !reasonBad
  );
}

function isResetTrigger(d: Decision): boolean {
  const kind = d.action?.kind ?? '';
  const verdict = d.classification?.verdict ?? '';
  return kind === 'escalate' || kind === 'kill' || verdict === 'escalate' || verdict === 'reject';
}

async function main(): Promise<void> {
  if (!TOKEN && process.env.THEORCHESTRA_NO_AUTH !== '1') {
    console.error('ERROR: set THEORCHESTRA_TOKEN or THEORCHESTRA_NO_AUTH=1');
    process.exit(2);
  }
  console.log('='.repeat(60));
  console.log(`A-6 gate: ${REQUIRED} consecutive OK-CONTINUEs over ${MINUTES} min`);
  console.log('='.repeat(60));

  const startAt = Date.now();
  const endAt = startAt + MINUTES * 60_000;
  const seenTs = new Set<string>();
  let streak = 0;
  let bestStreak = 0;
  let totalCounted = 0;

  while (Date.now() < endAt) {
    const decisions = await fetchDecisions();
    // Process newest-first (API returns most-recent last; we want chronological)
    const sorted = [...decisions].sort((a, b) => a.ts.localeCompare(b.ts));
    for (const d of sorted) {
      if (seenTs.has(d.ts)) continue;
      seenTs.add(d.ts);
      totalCounted++;
      if (isOkContinue(d)) {
        streak++;
        bestStreak = Math.max(bestStreak, streak);
        console.log(`[A-6] +1 OK-CONTINUE (streak=${streak}): ${d.action?.kind ?? '?'} ${String(d.action?.reason ?? '').slice(0, 60)}`);
        if (streak >= REQUIRED) {
          console.log('\n' + '='.repeat(60));
          console.log(`[A-6] PASS — ${streak} consecutive OK-CONTINUEs`);
          console.log('='.repeat(60));
          process.exit(0);
        }
      } else if (isResetTrigger(d)) {
        if (streak > 0) {
          console.log(`[A-6] streak reset at ${streak} (trigger: ${d.action?.kind ?? '?'})`);
        }
        streak = 0;
      }
      // no_ops neither advance nor reset
    }

    await wait(15_000);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`[A-6] FAIL — best streak was ${bestStreak}/${REQUIRED} in ${MINUTES} min (${totalCounted} decisions observed)`);
  console.log('='.repeat(60));
  process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL]', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
