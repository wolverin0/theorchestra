/** Test helper: fire a synthetic ctx_threshold into the running backend via
 * an injection into the default session's rendered buffer. The status-bar
 * emitter watches for "Ctx: NN.N%" patterns in the rendered text — we inject
 * a fake status-bar line to trigger real emitter logic. */
import { backendClient } from '../src/mcp/client.js';

async function main(): Promise<void> {
  const sessions = (await backendClient.listSessions()) as Array<{ sessionId: string }>;
  const first = sessions[0];
  if (!first) throw new Error('no sessions — spawn one first');
  const pct = process.argv[2] ?? '35';
  const banner = `   Ctx: ${pct}.0%  Context: [x] ${pct}k/100k (${pct}%)`;
  await backendClient.sendPrompt(first.sessionId, `echo ${banner}`);
  console.log('fired ctx_threshold trigger for', first.sessionId, '@', pct + '%');
}
main().catch((e) => { console.error(e); process.exit(1); });
