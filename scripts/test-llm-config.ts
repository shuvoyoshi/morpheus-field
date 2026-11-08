/**
 * The agent's LLM config store (server/llmConfig.ts) and model list, against a
 * fake OpenAI-compatible + LM Studio server, no GPU or LLM needed:
 * `npm run test:llm-config`.
 *
 * Covers the per-field precedence (saved value > env var > unset), saving and
 * clearing a field, and the model list (ids from /v1/models enriched with
 * size/context/quantization from LM Studio's /api/v0/models).
 */
import assert from 'assert/strict';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

const NATIVE = [
  { id: 'qwen3-30b', name: 'Qwen3 30B', size: 18 * 2 ** 30, contextLength: 32768, quantization: 'Q8_0' },
  { id: 'llama-8b', name: 'Llama 8B', size: '5.0 GB', contextLength: 8192 },
  { id: 'embed-1', name: 'Embed 1' },
];

let serveNative = true; // LM Studio's stats endpoint; off = a plain OpenAI server
const server = createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ data: NATIVE.map((m) => ({ id: m.id })) }));
  }
  if (req.url === '/api/v0/models' && serveNative) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(NATIVE));
  }
  res.statusCode = 404;
  res.end();
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const PORT = (server.address() as AddressInfo).port;
const URL = `http://127.0.0.1:${PORT}/v1`;

// Known values (empty where unused) keep this machine's .env out.
Object.assign(process.env, {
  OPENFIELD_LLM_URL: URL,
  OPENFIELD_LLM_MODEL: 'env-model',
  OPENFIELD_LLM_KEY: '',
  OPENFIELD_LLM_REASONING: '',
  OPENFIELD_DATA: join(tmpdir(), `openfield-test-llm-config-${Date.now()}-${Math.random().toString(36).slice(2)}`),
});
const { effectiveLlmConfig, llmConfigState, setLlmConfig, listLlmModels } = await import('../server/llmConfig.js');

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : e}`);
  }
}

await check('env is the default when nothing is saved', () => {
  const eff = effectiveLlmConfig();
  assert.equal(eff.url, URL);
  assert.equal(eff.model, 'env-model');
  const st = llmConfigState();
  assert.equal(st.ready, true);
  assert.equal(st.sources.url, 'env');
  assert.equal(st.sources.model, 'env');
});

await check('a saved value overrides the env var, per field', () => {
  setLlmConfig({ model: 'ui-model' });
  const eff = effectiveLlmConfig();
  assert.equal(eff.model, 'ui-model');
  assert.equal(eff.url, URL); // url still from env
  const st = llmConfigState();
  assert.equal(st.sources.model, 'user');
  assert.equal(st.sources.url, 'env');
});

await check('clearing a saved field goes back to the env var', () => {
  setLlmConfig({ model: null });
  assert.equal(effectiveLlmConfig().model, 'env-model');
  assert.equal(llmConfigState().sources.model, 'env');
});

await check('a saved URL overrides the env URL', () => {
  setLlmConfig({ url: 'http://127.0.0.1:9999/v1/' });
  assert.equal(effectiveLlmConfig().url, 'http://127.0.0.1:9999/v1'); // trailing slash normalized, /v1 kept
  assert.equal(llmConfigState().sources.url, 'user');
  setLlmConfig({ url: null });
});

await check('listLlmModels returns the ids with LM Studio stats', async () => {
  const r = await listLlmModels();
  assert.equal(r.models.length, 3);
  const qwen = r.models.find((m) => m.id === 'qwen3-30b')!;
  assert.equal(qwen.name, 'Qwen3 30B');
  assert.equal(qwen.size, '18.0 GB');
  assert.equal(qwen.contextLength, 32768);
  assert.equal(qwen.quantization, 'Q8_0');
  const llama = r.models.find((m) => m.id === 'llama-8b')!;
  assert.equal(llama.size, '5.0 GB'); // a string size passes through
  assert.equal(llama.quantization, undefined); // not reported
});

await check('a plain OpenAI server (no LM Studio stats) still returns the ids', async () => {
  serveNative = false; // /api/v0/models now 404s
  const r = await listLlmModels(); // default env URL: /v1/models works, stats endpoint does not
  assert.equal(r.models.length, 3);
  assert.equal(r.models[0].name, undefined); // no enrichment without the native list
  assert.equal(r.error, undefined);
  serveNative = true;
});

server.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
// Let the fake server close and the fetch keep-alive sockets settle before exit,
// so the Windows libuv teardown does not hit a half-closing handle.
setTimeout(() => process.exit(failed ? 1 : 0), 250);
