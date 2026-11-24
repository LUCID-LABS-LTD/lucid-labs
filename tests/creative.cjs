// Lucid Creative page (/creative) checks: node tests/creative.cjs
// Requires Microsoft Edge on Windows, or EDGE_PATH pointing to an Edge binary.
// Fails while placeholder sample slots remain, so the page can't ship half-finished.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const site = path.resolve(__dirname, '../website');
const file = path.join(site, 'creative/index.html');
const html = fs.readFileSync(file, 'utf8');
const edge = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function staticChecks() {
  const visible = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/lagos|nigeria/i.test(visible), 'page must not mention Lagos or Nigeria');
  assert.ok(!/chibugo|chidiebere|udegbe/i.test(html), 'old team names or surnames still on the page');
  for (const tag of ['og:title', 'og:description', 'og:image', 'og:url', 'twitter:card'])
    assert.ok(visible.includes(`"${tag}"`), `missing ${tag} meta tag`);
  assert.ok(/<title>[^<]+<\/title>/.test(visible) && visible.includes('name="description"'), 'missing title or description');
  assert.ok(fs.existsSync(path.join(site, 'creative/social-card.png')), 'missing creative/social-card.png');
  for (const price of ['$1,900', '$3,400', '$6,000', '$150', '$950', '$0'])
    assert.ok(visible.includes(price), `price ${price} missing`);
  // Every referenced poster/image must exist on disk; no self-hosted video.
  const refs = [...visible.matchAll(/src="\/creative\/([^"]+)"/g)].map(m => m[1]);
  for (const ref of refs) assert.ok(fs.existsSync(path.join(site, 'creative', ref)), `missing file creative/${ref}`);
  assert.ok(!/\.(mp4|mov|webm)"/i.test(visible), 'page must not reference self-hosted video files');
  const clips = (visible.match(/<figure class="clip"/g) || []).length;
  assert.ok(!visible.includes('clip placeholder'), 'placeholder sample slots still on the page');
  assert.ok(clips > 0, 'no video samples on the page');
  // Each sample needs a real YouTube video ID before the page can ship.
  const buttons = [...visible.matchAll(/<button class="yt"[^>]*data-yt="([^"]*)"[^>]*data-slug="([^"]+)"/g)];
  assert.equal(buttons.length, clips, 'every sample needs a YouTube play button');
  const missing = buttons.filter(m => !/^[\w-]{11}$/.test(m[1])).map(m => m[2]);
  assert.equal(missing.length, 0, `YouTube IDs missing for: ${missing.join(', ')}`);
}

async function browserChecks() {
  assert.ok(fs.existsSync(edge), 'Set EDGE_PATH to the Microsoft Edge executable');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-creative-test-'));
  const browser = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let ws;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    let port;
    for (let i = 0; i < 100 && !port; i++) {
      try { port = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]; }
      catch (error) { if (!['ENOENT', 'EBUSY', 'EACCES'].includes(error.code)) throw error; }
      if (!port) await sleep(100);
    }
    assert.ok(port, 'Edge did not start');
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0; const pending = new Map();
    ws.onmessage = ({ data }) => { const msg = JSON.parse(data); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); } };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
    const evaluate = async expression => { const v = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (v.exceptionDetails) throw new Error(v.exceptionDetails.text); return v.result.value; };
    const waitFor = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(100); } throw new Error(`Timed out waiting for ${expression}`); };
    await send('Page.enable'); await send('Runtime.enable');
    const url = pathToFileURL(file).href;

    for (const { width, height, mobile } of [{ width: 320, height: 640, mobile: true }, { width: 375, height: 812, mobile: true }, { width: 430, height: 932, mobile: true }, { width: 768, height: 1024, mobile: false }, { width: 1280, height: 900, mobile: false }]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await send('Page.navigate', { url });
      await waitFor("document.readyState==='complete'");
      const at = `at ${width}x${height}`;
      assert.ok(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'), `page overflows sideways ${at}`);
      assert.ok(await evaluate(`[...document.querySelectorAll('main section, nav, footer')].every(e=>{const r=e.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1})`), `a section exceeds the viewport ${at}`);
      assert.ok(await evaluate(`[...document.querySelectorAll('[data-spec-cut]')].every(a=>a.href.startsWith('mailto:francisca@lucidlabsltd.com?subject=Free%20spec%20cut'))`), `spec-cut buttons must open a mailto ${at}`);
      assert.ok(await evaluate(`(()=>{const a=document.querySelector('nav [data-spec-cut]').getBoundingClientRect();return a.width>0&&a.height>=38&&a.right<=innerWidth})()`), `nav CTA hidden or clipped ${at}`);
      assert.ok(await evaluate(`[...document.querySelectorAll('#workGrid .yt')].every(v=>{const r=v.getBoundingClientRect();return r.width>0&&Math.abs(r.height/r.width-16/9)<0.05})`), `sample tiles are not 9:16 ${at}`);
      assert.equal(await evaluate(`document.querySelectorAll('#workGrid iframe').length`), 0, `YouTube must not load before a tap ${at}`);
      // Tapping loads a youtube-nocookie player in place; tapping another closes the first.
      assert.ok(await evaluate(`(()=>{const b=[...document.querySelectorAll('#workGrid .yt')];const ids=b.map(x=>x.dataset.yt);b[0].dataset.yt='TESTID00001';b[1].dataset.yt='TESTID00002';b[0].click();const f1=document.querySelector('#workGrid iframe');const ok1=!!f1&&f1.src.startsWith('https://www.youtube-nocookie.com/embed/TESTID00001')&&Math.abs(f1.getBoundingClientRect().height/f1.getBoundingClientRect().width-16/9)<0.05;b[1].click();const fs=document.querySelectorAll('#workGrid iframe');const ok2=fs.length===1&&fs[0].src.includes('TESTID00002')&&b[0].isConnected;return ok1&&ok2})()`), `tap-to-play YouTube embed misbehaves ${at}`);
      // The work grid starts within the first two screens on every size.
      assert.ok(await evaluate(`document.getElementById('workGrid').getBoundingClientRect().top < innerHeight*2`), `work grid is too far down ${at}`);
      if (mobile) assert.ok(await evaluate(`[...document.querySelectorAll('.btn')].filter(b=>b.offsetParent).every(b=>b.getBoundingClientRect().height>=38)`), `buttons too small to tap ${at}`);
    }
  } finally {
    if (ws) ws.close();
    browser.kill();
    for (let i = 0; i < 10; i++) { try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(200); } }
  }
}

(async () => {
  await browserChecks();
  console.log('Creative page layout checks passed');
  staticChecks();
  console.log('Creative page content checks passed');
})().catch(error => { console.error(error.message || error); process.exitCode = 1; });
