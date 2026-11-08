/**
 * The in-app agent loop against a fake OpenAI-compatible server, no LLM and no
 * GPU needed: `npm run test:agent`.
 *
 * Covers what a live run is hard to force: streamed reasoning arriving before
 * the reply, inline `...` split out of the content, a present_plan turn that
 * must stop without touching the engine, a tool call that fails and is
 * reported before the turn recovers with a final answer, and show_take — the
 * id check against the take list and the take event that drives the card.
 */
import assert from 'assert/strict';
import { createServer, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

type Scenario = 'text' | 'inline' | 'plan' | 'tool' | 'img-default' | 'img-bad' | 'img-loop' | 'show' | 'show-bad' | 'show-flow';
let scenario: Scenario = 'text';
let chatCount = 0;
// The reasoning markers, built from char codes so they survive as-is: <think> and </think>.
const T_OPEN = String.fromCharCode(60, 116, 104, 105, 110, 107, 62);
const T_CLOSE = String.fromCharCode(60, 47, 116, 104, 105, 110, 107, 62);

const sse = (res: ServerResponse, delta: Record<string, unknown>) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const server = createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
  }
  if (req.url === '/api/takes') {
    // The one engine call that succeeds: show_take's id check.
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify([{ id: 42, status: 'done' }]));
  }
  if (req.url && req.url.startsWith('/api/')) {
    // Everything else fails like a downed engine, keeping the failure-path checks.
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'Morpheus is not answering' }));
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    JSON.parse(raw); // the agent always sends a valid body
    res.setHeader('content-type', 'text/event-stream');
    chatCount++;
    const respond = (fn: () => void, delay = 0) => {
      const out = () => { fn(); res.end('data: [DONE]\n\n'); };
      delay ? setTimeout(out, delay) : out();
    };
    const tool = (id: string, name: string, args: unknown) =>
      sse(res, { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] });

    if (scenario === 'text') {
      sse(res, { reasoning_content: 'Reasoning first, before the answer.' });
      return respond(() => sse(res, { content: 'The engine is ready.' }));
    }
    if (scenario === 'inline') {
      sse(res, { content: T_OPEN + 'Let me weigh the options.' + T_CLOSE });
      return respond(() => sse(res, { content: 'The answer is 42.' }));
    }
    if (scenario === 'plan') {
      return respond(() => tool('call_plan', 'present_plan', { steps: [
        { id: '1', label: 'Make a still', tool: 'generate_image' },
        { id: '2', label: 'Animate it', tool: 'generate_video' },
      ] }));
    }
    if (scenario === 'tool' && chatCount === 1) {
      return respond(() => tool('call_status', 'status', {}));
    }
    if ((scenario === 'img-default' || scenario === 'img-bad') && chatCount === 1) {
      // img-default: the model omits resolution (the schema it was sent has the default stripped).
      // img-bad: it sends one the enum does not allow.
      const args = scenario === 'img-default' ? { prompt: 'a red fox' } : { prompt: 'x', resolution: '4K' };
      return respond(() => tool('call_img', 'generate_image', args));
    }
    if (scenario === 'img-loop' && chatCount >= 1 && chatCount <= 3) {
      return respond(() => tool(`call_img${chatCount}`, 'generate_image', { prompt: 'x', resolution: '4K' }));
    }
    if (scenario === 'show' && chatCount === 1) {
      return respond(() => tool('call_show', 'show_take', { take_ids: [42] }));
    }
    if (scenario === 'show-bad' && chatCount === 1) {
      return respond(() => tool('call_show', 'show_take', { take_ids: [999] }));
    }
    if (scenario === 'show-flow' && chatCount === 1) {
      return respond(() => tool('call_show', 'show_take', { take_ids: [42], flow: true }));
    }
    return respond(() => sse(res, { content: 'The status check is done.' }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;

// mcp/client.ts captures OPENFIELD_URL at module load, so it must be set before
// the import; the LLM fields are resolved per turn (server/llmConfig.ts) and
// could be set later. The fake server doubles as LLM and engine: it answers
// /api/takes (show_take's id check) and fails every other engine call.
Object.assign(process.env, {
  OPENFIELD_LLM_URL: `http://127.0.0.1:${port}/v1`,
  OPENFIELD_LLM_MODEL: 'test-model', OPENFIELD_LLM_KEY: '', OPENFIELD_LLM_REASONING: '',
  OPENFIELD_URL: `http://127.0.0.1:${port}`,
  OPENFIELD_DATA: join(tmpdir(), 'openfield-test-agent'),
});
const { runAgent } = await import('../server/agent.js');

async function run(message: string): Promise<{ events: Record<string, any>[]; threw?: string }> {
  const events: Record<string, any>[] = [];
  let threw: string | undefined;
  try {
    await runAgent({ message, onEvent: (e) => events.push(e as Record<string, any>) });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  return { events, threw };
}

let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : e}`);
  }
}

await check('streamed reasoning arrives before the answer, then done', async () => {
  scenario = 'text'; chatCount = 0;
  const { events } = await run('Is the engine ready?');
  const types = events.map((e) => e.type);
  assert.ok(types.includes('thinking'), 'has thinking');
  assert.ok(types.includes('text'), 'has text');
  assert.ok(types.indexOf('thinking') < types.indexOf('text'), 'thinking before text');
  assert.equal(types[types.length - 1], 'done');
  assert.ok(events.find((e) => e.type === 'thinking')!.text.includes('Reasoning first'));
  const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.ok(text.includes('The engine is ready.'), text);
});

await check('inline ... is split out of the reply', async () => {
  scenario = 'inline'; chatCount = 0;
  const { events } = await run('What is the answer?');
  const thinking = events.filter((e) => e.type === 'thinking').map((e) => e.text).join('');
  const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.ok(/weigh the options/i.test(thinking), thinking);
  assert.ok(/answer is 42/.test(text), text);
  assert.ok(!/weigh the options/i.test(text), 'the thinking is not in the reply');
});

await check('present_plan emits the steps and stops without GPU work', async () => {
  scenario = 'plan'; chatCount = 0;
  const { events } = await run('Make a still, then animate it.');
  const plan = events.find((e) => e.type === 'plan');
  assert.ok(plan, 'has a plan');
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].label, 'Make a still');
  assert.equal(events.find((e) => e.type === 'tool_call'), undefined, 'no tool was dispatched');
  assert.equal(events[events.length - 1].type, 'done');
});

await check('a failing tool call is reported, then the turn recovers', async () => {
  scenario = 'tool'; chatCount = 0;
  const { events, threw } = await run('Check the engine status.');
  assert.equal(threw, undefined, `did not throw: ${threw}`);
  const call = events.find((e) => e.type === 'tool_call');
  assert.equal(call?.name, 'status');
  const done = events.find((e) => e.type === 'tool_done' && e.name === 'status');
  assert.ok(done, 'has tool_done for status');
  assert.equal(done.ok, false, 'the dead-port call failed');
  assert.ok(events.some((e) => e.type === 'text'), 'a final answer follows');
  assert.equal(events[events.length - 1].type, 'done');
});

await check('an omitted resolution gets its default and the call reaches the API', async () => {
  scenario = 'img-default'; chatCount = 0;
  const { events, threw } = await run('Make a picture.');
  assert.equal(threw, undefined, `did not throw: ${threw}`);
  assert.ok(events.find((e) => e.type === 'tool_call' && e.name === 'generate_image'), 'dispatched generate_image');
  const done = events.find((e) => e.type === 'tool_done' && e.name === 'generate_image');
  assert.ok(done, 'has tool_done');
  assert.equal(done.ok, false, 'the dead engine port fails the render');
  const s = String(done.summary);
  assert.ok(s.includes('Morpheus is not answering'), `reached the API, not the body builder: ${s}`);
  assert.ok(!s.includes('Cannot read properties'), 'no TypeError');
});

await check('a bad resolution is rejected with a readable, self-correctable error', async () => {
  scenario = 'img-bad'; chatCount = 0;
  const { events, threw } = await run('Make a picture.');
  assert.equal(threw, undefined, `did not throw: ${threw}`);
  const done = events.find((e) => e.type === 'tool_done' && e.name === 'generate_image');
  assert.ok(done, 'has tool_done');
  assert.equal(done.ok, false, 'rejected before any API call');
  const s = String(done.summary);
  assert.ok(s.includes('fix the arguments'), `says to fix the arguments: ${s}`);
  assert.ok(s.includes('resolution') && s.includes('1K') && s.includes('2K'), `lists the options: ${s}`);
  assert.ok(!s.includes('Morpheus is not answering'), 'never reached the API');
  assert.ok(events.some((e) => e.type === 'text'), 'a final answer follows');
});

await check('the same failing call three times stops the turn', async () => {
  scenario = 'img-loop'; chatCount = 0;
  const { events, threw } = await run('Make a picture.');
  assert.equal(threw, undefined, `did not throw: ${threw}`);
  const dones = events.filter((e) => e.type === 'tool_done' && e.name === 'generate_image');
  assert.equal(dones.length, 3, `three attempts, got ${dones.length}`);
  assert.ok(events.some((e) => e.type === 'error' && /three times/.test(String((e as { message?: string }).message))), 'the stop is explained');
  assert.equal(events[events.length - 1].type, 'done');
});

await check('show_take validates the ids and emits one show event for the card grid', async () => {
  scenario = 'show'; chatCount = 0;
  const { events, threw } = await run('Show me take 42.');
  assert.equal(threw, undefined, `did not throw: ${threw}`);
  const done = events.find((e) => e.type === 'tool_done' && e.name === 'show_take');
  assert.ok(done, 'has tool_done for show_take');
  assert.equal(done.ok, true, 'take 42 is in the fake library');
  const show = events.find((e) => e.type === 'show');
  assert.ok(show, 'a show event drives the card grid');
  assert.deepEqual(show.ids, [42]);
  assert.equal(show.flow, false, 'not a flow by default');
  assert.ok(!events.some((e) => e.type === 'take'), 'no per-take event for a show');
  assert.ok(events.some((e) => e.type === 'text'), 'a final answer follows');
  assert.equal(events[events.length - 1].type, 'done');
});

await check('show_take with an unknown id fails readably and the turn recovers', async () => {
  scenario = 'show-bad'; chatCount = 0;
  const { events, threw } = await run('Show me take 999.');
  assert.equal(threw, undefined, `did not throw: ${threw}`);
  const done = events.find((e) => e.type === 'tool_done' && e.name === 'show_take');
  assert.ok(done, 'has tool_done for show_take');
  assert.equal(done.ok, false, 'the unknown id is rejected');
  const s = String(done.summary);
  assert.ok(s.includes('999'), `names the bad id: ${s}`);
  assert.ok(s.includes('list_takes'), `points at list_takes: ${s}`);
  assert.ok(!events.some((e) => e.type === 'show'), 'no card for the missing take');
  assert.ok(events.some((e) => e.type === 'text'), 'a final answer follows');
  assert.equal(events[events.length - 1].type, 'done');
});

await check('show_take with flow passes the flag through for the arrow chain', async () => {
  scenario = 'show-flow'; chatCount = 0;
  const { events, threw } = await run('Show me the flow of take 42.');
  assert.equal(threw, undefined, `did not throw: ${threw}`);
  const done = events.find((e) => e.type === 'tool_done' && e.name === 'show_take');
  assert.ok(done && done.ok === true, 'the call succeeds');
  const show = events.find((e) => e.type === 'show');
  assert.ok(show, 'a show event drives the chain');
  assert.deepEqual(show.ids, [42]);
  assert.equal(show.flow, true, 'flow is on');
  assert.ok(events.some((e) => e.type === 'text'), 'a final answer follows');
  assert.equal(events[events.length - 1].type, 'done');
});

await check('the turn announces the model loading, then ready, before any content', async () => {
  scenario = 'text'; chatCount = 0;
  const { events } = await run('Is the engine ready?');
  assert.equal(events[0].type, 'loading', 'first event is the loading notice');
  const ready = events.find((e) => e.type === 'loading' && e.ready);
  assert.ok(ready, 'a ready notice follows');
  const thinking = events.findIndex((e) => e.type === 'thinking');
  assert.ok(events.indexOf(ready!) < thinking, 'ready arrives before the first thinking token');
});

server.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
