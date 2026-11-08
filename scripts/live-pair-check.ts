/** Live end-to-end check of the phone pairing against the running dev server. */
import WebSocket from 'ws';

const API = 'http://127.0.0.1:3161';
const j = async (u, i) => { const r = await fetch(u, i); const t = await r.text(); return { s: r.status, h: r.headers, t }; };

const started = await (await fetch(`${API}/api/phoneapp/start`, { method: 'POST' })).json();
console.log('started:', started.id, started.url, 'upstream:', started.upstream);
const base = started.url.replace(/\/pair\/.*$/, '');
const token = started.url.split('/pair/')[1];
const cookie = { cookie: `morpheus_pair=${token}` };

console.log('no cookie /           ->', (await j(`${base}/`)).s);
const pair = await j(`${base}/pair/${token}`, { redirect: 'manual' });
console.log('pair                  ->', pair.s, 'loc:', pair.h.get('location'), 'cookie:', /morpheus_pair/.test(pair.h.get('set-cookie') || ''));
const app = await j(`${base}/`, { headers: cookie });
console.log('cookie /              ->', app.s, 'is-app-html:', app.t.includes('id="root"') || app.t.includes('vite'));
const st = await j(`${base}/api/status`, { headers: cookie });
console.log('cookie /api/status    ->', st.s, JSON.parse(st.t).engine ?? '');
const lanHost = started.url.replace(/^http:\/\/([^:]+):.*/, '$1'); // listener binds the LAN address
const ws = await new Promise((res) => {
  const w = new WebSocket(`ws://${lanHost}:3163/live`, { headers: cookie });
  const done = (v) => { try { w.terminate(); } catch { /* gone */ } res(v); };
  w.on('open', () => done(true));
  w.on('error', () => done(false));
  setTimeout(() => done(false), 3000);
});
console.log('ws /live with cookie  ->', ws);
console.log('stop                  ->', (await fetch(`${API}/api/phoneapp/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: started.id }) })).status);
await new Promise((r) => setTimeout(r, 300));
try { await j(`${base}/`); console.log('after stop              -> still answering?!'); } catch { console.log('after stop              -> listener gone'); }
