// Dependency-free responsive smoke test: node tests/mobile.cjs
// Requires Microsoft Edge on Windows, or EDGE_PATH pointing to an Edge binary.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const edge = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const page = pathToFileURL(path.resolve(__dirname, '../website/index.html')).href;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-site-test-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  assert.ok(fs.existsSync(edge), 'Set EDGE_PATH to the Microsoft Edge executable');
  const browser = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], {stdio:'ignore'});
  let ws;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for(let i=0; i<100 && !fs.existsSync(portFile); i++) await sleep(100);
    assert.ok(fs.existsSync(portFile), 'Edge did not start');
    const port = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method:'PUT'})).json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject) => {ws.onopen=resolve; ws.onerror=reject;});
    let id=0; const pending=new Map();
    ws.onmessage=({data})=>{const msg=JSON.parse(data);if(msg.id && pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(new Error(msg.error.message)):p.resolve(msg.result);}};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
    const evaluate=async expression=>{const value=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw new Error(value.exceptionDetails.text);return value.result.value;};
    const waitFor=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await sleep(100);}throw new Error(`Timed out waiting for ${expression}`);};
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    async function screenshot(name) {
      if(!process.env.LUCID_SCREENSHOTS)return;
      fs.mkdirSync(process.env.LUCID_SCREENSHOTS,{recursive:true});
      const result=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      fs.writeFileSync(path.join(process.env.LUCID_SCREENSHOTS,name+'.png'),Buffer.from(result.data,'base64'));
    }
    for (const {width,height} of [{width:320,height:568},{width:320,height:850},{width:375,height:812},{width:430,height:932}]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
      await send('Page.navigate',{url:page});
      await waitFor("document.readyState==='complete' && document.querySelector('nav.menu-ready')");
      assert.equal(await evaluate('innerWidth'),width,'mobile viewport must match requested width');
      assert.ok(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),`document overflows at ${width}x${height}`);
      assert.ok(await evaluate(`(()=>{const n=document.querySelector('nav').getBoundingClientRect(),c=document.querySelector('.hero-inner').getBoundingClientRect(),b=document.querySelector('.statusbar').getBoundingClientRect(),cta=document.querySelector('.cta-group').getBoundingClientRect();return c.top>=n.bottom-1 && cta.bottom<=b.top+1 && b.width<=innerWidth+1})()`),`hero or status overlaps at ${width}x${height}`);
      assert.ok(await evaluate(`(()=>{const f=document.querySelector('.lab-video-frame').getBoundingClientRect();return [...document.querySelector('.lab-video-frame').children].every(e=>{const r=e.getBoundingClientRect();return r.top>=f.top-1&&r.bottom<=f.bottom+1&&r.left>=f.left-1&&r.right<=f.right+1})})()`),`lab panel content is clipped at ${width}x${height}`);
      assert.ok(await evaluate(`['philosophy','divisions','proof','lab','roadmap','contact'].every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&r.width>0})`),`a section exceeds the viewport at ${width}x${height}`);
      if(width===320&&height===850){
        await screenshot('hero-320');
        await evaluate("document.querySelector('.lab-video-frame').scrollIntoView({block:'center'})");
        await sleep(400); await screenshot('lab-320');
        await evaluate('window.scrollTo(0,0)'); await sleep(200);
      }
      assert.equal(await evaluate("getComputedStyle(document.querySelector('#siteNavigation')).display"),'none','mobile menu starts closed');
      await evaluate("document.querySelector('#menuToggle').click()");
      if(width===320&&height===850) await screenshot('menu-320');
      assert.equal(await evaluate("document.querySelector('#menuToggle').getAttribute('aria-expanded')"),'true','menu opens and updates ARIA');
      assert.notEqual(await evaluate("getComputedStyle(document.querySelector('#siteNavigation')).display"),'none','mobile links appear');
      await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      assert.equal(await evaluate("document.querySelector('#menuToggle').getAttribute('aria-expanded')"),'false','Escape closes menu');
      await evaluate("document.querySelector('#menuToggle').click(); document.querySelector('#siteNavigation a[href=\"#proof\"]').click()");
      assert.equal(await evaluate("document.querySelector('#menuToggle').getAttribute('aria-expanded')"),'false','navigation closes menu');
      assert.equal(await evaluate('location.hash'),'#proof','navigation link reaches the intended section');
      await evaluate("document.querySelector('#menuToggle').click();document.querySelector('#themeToggle').click()");
      assert.equal(await evaluate("document.documentElement.dataset.theme"),'light','theme toggle works on mobile');
      assert.equal(await evaluate("document.querySelector('meta[name=theme-color]').content"),'#f0ebdd','browser theme follows selection');
    }
    await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:page});
    await waitFor("document.readyState==='complete' && document.querySelector('nav.menu-ready')");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#menuToggle')).display"),'none','mobile toggle hidden on desktop');
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('#siteNavigation')).display"),'none','desktop links visible');
    assert.ok(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),'desktop page should not overflow');
    console.log('Company website responsive browser checks passed');
  } finally {
    if(ws) ws.close();
    browser.kill();
    for(let i=0;i<10;i++){try{fs.rmSync(profile,{recursive:true,force:true});break;}catch{await sleep(200);}}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
