#!/usr/bin/env node
// Headless walk of a BUILT Wavedash page: a fake connected gamepad and a
// logging Wavedash mock are injected before the page's own script, then
// title -> aim -> a full swing under a page-error gate. This is the only
// automated check of what Closure did to the Wavedash build (the roundRect
// class of bug, and the stripped-method class: "t.length is not a function"
// on the first stick read). Exit code 1 on any error.
//   npm run build:wavedash && node game/tools/wavedash-walk.mjs
//   node game/tools/wavedash-walk.mjs game/build-raw/index.html   (readable stack)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || join(__dirname, '../build-wavedash/index.html');
if (!fs.existsSync(file))
{
    console.error(`${file} missing - run npm run build:wavedash first`);
    process.exit(1);
}
const errors = [], wd = [];
const chromePath = process.env.CHROME_PATH || [
    '/opt/pw-browsers/chromium',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: chromePath,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }); // webgl2 in headless
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => errors.push(e.message));
page.on('console', m =>
{
    const t = m.text();
    if (t.startsWith('WAVEDASH')) wd.push(t);
    else if (m.type() == 'error' && !t.includes('favicon')) errors.push('console: ' + t);
});
await page.addInitScript(() =>
{
    // one idle gamepad, always connected: the engine reads its sticks every frame
    const pad = { id: 'fake', index: 0, connected: true, mapping: 'standard', timestamp: 1,
        axes: [0, 0, 0, 0], buttons: Array.from({length: 17}, () => ({pressed: false, touched: false, value: 0})) };
    navigator.getGamepads = () => [pad];
    const log = (f) => (...a) => (console.log('WAVEDASH', f, ...a), 1);
    window.Wavedash = { init: log('init'), setAchievement: log('setAchievement'),
        getOrCreateLeaderboard: (n, ...a) => (log('getOrCreateLeaderboard')(n, ...a), Promise.resolve({success: 1, data: {id: n}})),
        uploadLeaderboardScore: log('uploadLeaderboardScore'),
        requestStats: () => (log('requestStats')(), Promise.resolve({success: 1})),
        getStat: () => 0, setStat: log('setStat'), storeStats: log('storeStats'),
        downloadRemoteFile: (p) => Promise.resolve({success: false, data: p}),
        readLocalFile: () => Promise.resolve(null),
        writeLocalFile: (p) => (log('writeLocalFile')(p), Promise.resolve(true)),
        uploadRemoteFile: log('uploadRemoteFile') };
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// a key must stay DOWN across a rendered frame for LittleJS to see it
const key = async (code) => { await page.keyboard.down(code); await sleep(400); await page.keyboard.up(code); await sleep(150); };

await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
await sleep(3000);
if (!wd.some(t => t.startsWith('WAVEDASH init')))
    errors.push('Wavedash.init was never called - the page would sit behind the loading screen');
console.log('after load: errors', errors.length);
if (!errors.length)
{
    // the three menu buttons sit in a row at y = T*.62; CLASSIC is the centre
    await page.mouse.click(640, 720*.62 + 36);
    await sleep(1500);
    await page.mouse.click(640, 400); // intro -> aim
    await sleep(1500);
    await key('Space'); await sleep(600);  // arm the meter
    await key('Space'); await sleep(400);  // set power
    await key('Space'); await sleep(2500); // impact -> flight
    console.log('after swing: errors', errors.length);
}
for (const e of errors) console.log('ERROR:', e);
await browser.close();
console.log(errors.length ? 'WAVEDASH WALK FAILED' : 'WAVEDASH WALK OK');
process.exit(errors.length ? 1 : 0);
