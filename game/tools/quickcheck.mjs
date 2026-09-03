// Minimal load check: shader compiles, no console/page errors, one screenshot.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 8142;
const server = spawn('node', ['serve.js'], { cwd: root, env: {...process.env, PORT} });
await new Promise(r => setTimeout(r, 900));
const chromePath = process.env.CHROME_PATH || ['/opt/pw-browsers/chromium',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: chromePath,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() == 'error' && !m.text().includes('AudioContext')) errors.push('CONSOLE: ' + m.text()); });
const q = process.argv[2] || '';   // e.g. "&trees=2"
await page.goto(`http://localhost:${PORT}/?hole=1${q}`, { waitUntil: 'load' });
for (let t=0; t<40000; t+=250) {
    if (await page.evaluate('typeof DBG == "function" && typeof hole == "object" && !!hole').catch(()=>0)) break;
    await new Promise(r => setTimeout(r, 250));
}
if (process.env.SETUP) await page.evaluate(process.env.SETUP);
const d = await page.evaluate('DBG()').catch(()=>null);
// hole-load cost: median of 5 warm full rebuilds
const times = [];
for (let i=0; i<5; ++i)
    times.push(await page.evaluate('(()=>{const t=performance.now();buildWorld();return performance.now()-t})()'));
const med = [...times].sort((a,b)=>a-b)[2];
console.log(`trees=${q||'1'}  verts ${d && d.verts}  trees ${d && d.trees}  fps ${d && d.fps}  bake ${med.toFixed(0)}ms`);
await page.screenshot({ path: join(root, 'game/shots/90-quickcheck.png') });
console.log(errors.length ? errors.join('\n') : 'no errors');
await browser.close(); server.kill(); process.exit(errors.length ? 1 : 0);
