#!/usr/bin/env node
// RAINBOW GOLF TOUR iteration harness
// - serves the repo, loads the dev build headless, fails on console errors
// - screenshots key game states into game/shots/
// - optionally runs the autoplay bot for playtest stats
// usage: node tools/shots.mjs [--round]   (--round = full 18 bot round + stats)

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../..');
const shotDir = join(__dirname, '../shots');
fs.mkdirSync(shotDir, { recursive: true });
const PORT = 8137;
const BASE = `http://localhost:${PORT}/`; // index.html is at the repo root
const fullRound = process.argv.includes('--round');

// static server
const server = spawn('node', ['serve.js'], { cwd: root, env: {...process.env, PORT} });
await new Promise(r => setTimeout(r, 800));

const errors = [];
const results = [];
// Chromium executable: env override, else first existing known install
const chromePath = process.env.CHROME_PATH || [
    '/opt/pw-browsers/chromium', // cowork/linux container
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: chromePath,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }); // webgl2 in headless
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m =>
{
    const t = m.text(), url = m.location() ? m.location().url : '';
    // (favicon: the release html has no <link rel=icon>, its 404 is noise)
    if (m.type() == 'error' && !t.includes('AudioContext') && !url.includes('favicon'))
        errors.push('CONSOLE: ' + t + ' @ ' + url);
    if (t.startsWith('RESULT'))
        results.push(t);
});

const shot = async (name)=>
{
    await page.screenshot({ path: join(shotDir, name + '.png') });
    console.log('shot:', name);
}
const sleep = (ms)=> new Promise(r => setTimeout(r, ms));
const click = ()=> page.mouse.click(640, 400);
// The title is a MENU now (CLASSIC / REMIX / CONTINUE), so leaving it needs
// a click ON a button, not anywhere. Closure renames menuRect away in the
// release build, so this repeats its formula rather than querying it:
// the three sit in a ROW at y = T*.62, each min(W*.31, T*.44) wide and
// spaced 1.06 of that apart. KEEP IN SYNC with menuRect in game.js.
const VW = 1280, VH = 720, MW = VW*.31;
const clickMenu = (i)=> page.mouse.click(VW/2 + (i-1)*MW, VH*.62 + VH*.05);
// keyboard: LittleJS never registers Playwright's press() (down+up in one
// task - measured 0/6 vs 6/6). The key must stay down across a frame, and
// swiftshader frames (or a hole rebuild) can take 100ms+, so hold it for
// a few frames and let a frame pass after release. Use this for EVERY key.
const key = async (code)=>
{
    // hold across at least one RENDERED frame. LittleJS reads a key that was
    // down during a frame; swiftshader in the map view can take longer than
    // any fixed hold, so a 150ms press was simply missed there.
    const f0 = await page.evaluate('frame').catch(()=>0);
    await page.keyboard.down(code);
    for (let t=0; t<3000; t+=100)
    {
        await sleep(100);
        if (await page.evaluate('frame').catch(()=>f0+1) > f0) break;
    }
    await page.keyboard.up(code);
    await sleep(150);
};
// poll the dev-build DBG() hook until the game reaches a state (frame-rate
// independent - swiftshader runs well below 60fps so fixed sleeps desync).
// The CAP is wall-clock and must absorb time dilation: at 22fps (the tree
// count tripled on 2026-08-31) the accumulator clamp runs game time at a
// THIRD of wall speed, and a drive's flight+settle is ~9 game-seconds -
// the old 12s cap timed out on a perfectly healthy shot.
const waitState = async (s, ms=30000)=>
{
    for (let t=0; t<ms; t+=200)
    {
        if (await page.evaluate('DBG().state') == s) return;
        await sleep(200);
    }
    errors.push(`HARNESS: timed out waiting for state ${s}`);
};

try
{
    // title
    await page.goto(BASE, { waitUntil: 'load' });
    await sleep(1500);
    await shot('01-title');

    // hole 1: intro -> aim -> meter
    await page.goto(BASE + '?hole=1', { waitUntil: 'load' });
    await sleep(1200);
    await shot('02-intro-h1');
    await click();
    await sleep(600);
    await shot('03-aim-h1');
    {
        // perf line (SwiftShader - relative numbers only): static verts, trees, fps
        const d = await page.evaluate('DBG()');
        console.log(`perf: ${d.verts} static verts, ${d.trees} trees, ${d.fps} fps (swiftshader)`);
    }
    await page.mouse.move(77, 360); // hold the on-screen ◀ arrow - rotation check
    await page.mouse.down();
    await sleep(1100);
    await page.mouse.up();
    await shot('03b-aim-rotated');
    await key('KeyC'); // debug: the tree collision volumes
    await shot('03d-collision');
    await key('KeyC');
    // trees near the ball leave the picture AND the collision set, decided
    // once per shot in enterAim (never mid-rotation - that read as jitter)
    const vertsClear = await page.evaluate('DBG().verts');
    const nearClear = await page.evaluate('H.near.length');
    await page.evaluate('(()=>{ const t = H.near[0];'
        + ' ball.x = t.x + 4; ball.z = t.z; ball.y = groundAt(ball.x, ball.z).h;'
        + ' enterAim(); })()');
    await sleep(400);
    const vertsHidden = await page.evaluate('DBG().verts');
    if (!(vertsHidden < vertsClear))
        errors.push(`HARNESS: a tree beside the ball should be hidden (verts ${vertsClear} -> ${vertsHidden})`);
    if (!(await page.evaluate('H.near.length') < nearClear))
        errors.push('HARNESS: a hidden tree must leave the collision set too');
    await shot('03e-tree-hidden');
    await page.evaluate('ball.x = ball.z = 0; ball.y = groundAt(0, 0).h; enterAim()');
    await sleep(400);
    if (await page.evaluate('DBG().verts') != vertsClear)
        errors.push('HARNESS: the hidden tree should come back when the ball moves away');
    await click(); // toggle the landing preview camera
    await sleep(500);
    await shot('03c-placement');
    await click(); // and back to the tee view
    await sleep(400);
    await key('Space');
    await sleep(700);
    await shot('04-meter-h1');

    // launch and watch the chase cam follow the ball (deterministic bot
    // swing - meter timing is frame-rate dependent under swiftshader)
    await waitState(2); // armed meter auto-cancels back to aim
    // swing FROM the landing preview: the flight must start from the tee
    // cam (v0.10 chase-lerped from the preview pose and swung wildly)
    await page.evaluate('PREVIEW(1)');
    await sleep(300);
    await page.evaluate('SWING()');
    await sleep(150);
    const f0 = await page.evaluate('DBG()');
    const camDist = Math.hypot(f0.cam.x - f0.ball.x, f0.cam.z - f0.ball.z);
    if (f0.state != 4 || camDist > 40)
        errors.push(`HARNESS: swing from preview - camera ${camDist|0}yd from the ball at flight start (state ${f0.state})`);
    await shot('04b-flight-from-preview');
    await waitState(4); // ST_FLIGHT
    await sleep(900);
    await shot('05-flight-h1');
    const tl = await page.evaluate('DBG().trail');
    if (!(tl > 1)) errors.push(`HARNESS: no trail samples during flight (trail ${tl})`);
    await sleep(2500);
    await shot('06-flight-chase-h1');
    await waitState(2); // lands, back in aim
    // the trail must expire on its own once the ball has stopped
    // 8s wall = ~3s game under swiftshader dilation, against TRAIL_LIFE 1s
    let tl2 = 1;
    for (let t=0; t<8000 && tl2; t+=250)
    {
        await sleep(250);
        tl2 = await page.evaluate('DBG().trail');
    }
    if (tl2) errors.push(`HARNESS: trail still has ${tl2} samples long after the ball stopped`);
    await shot('06b-aim-after-flight');

    // island green par 3 (hole 16, sunset palette)
    await page.goto(BASE + '?hole=16', { waitUntil: 'load' });
    await sleep(1200);
    await shot('07-intro-h16');
    await click();
    await sleep(600);
    await shot('08-aim-h16');
    // rainbow trail on a NICE shot (forced via the dev hook)
    await page.evaluate('SWING(); NICE()');
    await waitState(4);
    await sleep(700);
    await shot('08b-flight-nice-h16');

    // lake hole aim (hole 8) + a remix hole
    await page.goto(BASE + '?hole=8', { waitUntil: 'load' });
    await sleep(1000);
    await click();
    await sleep(500);
    await shot('09-aim-h8');
    await page.goto(BASE + '?hole=5&seed=777', { waitUntil: 'load' });
    await sleep(1000);
    await click();
    await sleep(500);
    await shot('10-aim-remix');

    // putting view with slope aid (hilly hole for visible break)
    await page.goto(BASE + '?hole=13&putt=1', { waitUntil: 'load' });
    await sleep(1200);
    await shot('13-putt');
    await click(); // the destination cam works for putts too (zoomed in)
    await sleep(400);
    await shot('13b-putt-preview');
    await click();
    await sleep(400);

    // from a bunker the landing ring once stuck to the ball: groundAt sits
    // .5yd below heightAt inside the scoop, and the flight prediction ended
    // against heightAt, so the shot "landed" before it started
    await page.evaluate('(()=>{ const b = H.bunkers[0]; ball.x = b.x; ball.z = b.z;'
        + ' ball.y = groundAt(b.x, b.z).h; clubI = 8; enterAim(); })()');
    await sleep(500);
    const sandRing = await page.evaluate('Math.hypot(predLand.x-ball.x, predLand.z-ball.z)');
    if (!(sandRing > 10))
        errors.push(`HARNESS: the landing ring is stuck on the ball in sand (${sandRing.toFixed(1)}yd)`);
    await shot('13c-bunker-aim');

    await key('Space');
    await sleep(500);
    await shot('14-putt-meter');

    // debug survey tools: M = top-down hole map, ] [ = next/previous hole
    await page.goto(BASE + '?hole=1', { waitUntil: 'load' });
    // the engine clears input every frame while the document has no focus,
    // so keys are dropped until a click lands: wait for the dev hook (engine
    // running), then click once (skips the intro, focuses the page)
    for (let t=0; t<8000; t+=100)
    {
        if (await page.evaluate(`typeof DBG=='function' && DBG().state`) == 1) break;
        await sleep(100);
    }
    await click();
    await sleep(300);
    await key('KeyM');
    await sleep(400);
    await shot('15-map-h1');
    // (poll: a hole rebuild + swiftshader frame can take longer than a sleep)
    const waitHole = async (h)=>
    {
        for (let t=0; t<6000; t+=200)
        {
            if (await page.evaluate('DBG().holeIndex') == h) return;
            await sleep(200);
        }
        errors.push(`HARNESS: expected holeIndex ${h}, got ${await page.evaluate('DBG().holeIndex')}`);
    };
    await key('BracketRight');
    await waitHole(1);
    await sleep(300);
    await shot('16-map-h2');
    await key('BracketLeft');
    await waitHole(0);
    await sleep(300); // let the hole-1 rebuild finish before the next key
    await key('BracketLeft');
    await waitHole(17); // wraps 1 -> 18
    await sleep(300);
    await shot('17-map-h18');
    await key('KeyM');
    // free cam: F, click for pointer lock (may be refused headless - must not
    // throw), mouse move + W must not error
    await key('KeyF');
    await click();
    await page.mouse.move(700, 420);
    await page.keyboard.down('KeyW');
    await sleep(500);
    await page.keyboard.up('KeyW');
    await shot('18-freecam');
    await key('KeyF');

    // dense forest smoke: ?trees=3 triples the periphery forest - must build
    // and render clean; perf line for machine-to-machine comparison
    await page.goto(BASE + '?hole=1&trees=3', { waitUntil: 'load' });
    for (let t=0; t<8000; t+=100)
    {
        if (await page.evaluate(`typeof DBG=='function' && DBG().state`) == 1) break;
        await sleep(100);
    }
    await click();
    await sleep(600);
    {
        const d = await page.evaluate('DBG()');
        console.log(`perf x3: ${d.verts} static verts, ${d.trees} trees, ${d.fps} fps (swiftshader)`);
    }
    await shot('24-forest-x3');

    // per-hole scorecard: force a hole-out; the banner shows first and an
    // early click must NOT advance; the card (CARD_T frames in) waits for a
    // click. JUMP(18) + hole-out = the results card.
    const waitDbg = async (p=page)=>
    {
        for (let t=0; t<8000; t+=100)
        {
            if (await p.evaluate(`typeof DBG=='function' && DBG().state`) == 1) return;
            await sleep(100);
        }
        errors.push('HARNESS: the game never reached the intro');
    };
    const waitCard = async ()=>
    {
        for (let t=0; t<8000; t+=200)
        {
            const d = await page.evaluate('DBG()');
            if (d.state == 5 && d.stateTime > 85) return;
            await sleep(200);
        }
        errors.push('HARNESS: the hole-out card never appeared');
    };
    await page.goto(BASE + '?hole=3', { waitUntil: 'load' });
    await waitDbg();
    await click();
    await page.evaluate('HOLEOUT()');
    await sleep(150);
    await click(); // banner phase: must not skip the card
    await sleep(150);
    if (await page.evaluate('DBG().state') != 5) errors.push('HARNESS: a click during the hole-out banner skipped the card');
    await waitCard();
    await shot('22-holeout-card');
    await click();
    await waitState(1); // next hole's intro
    await page.evaluate('JUMP(18); HOLEOUT()');
    await waitCard();
    await click();
    await sleep(400);
    if (await page.evaluate('DBG().state') != 6) errors.push('HARNESS: hole-out on 18 should reach RESULTS (6)');
    await shot('23-results-card');

    // mobile: touch device, portrait phone viewport, DPR 2 - taps must drive
    // the canvas HUD (the engine maps touches to mouse button 0) and the
    // overlay must render in device pixels
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const mp = await mctx.newPage();
    mp.on('pageerror', e => errors.push('MOBILE PAGEERROR: ' + e.message));
    mp.on('console', m => { if (m.type() == 'error' && !m.text().includes('AudioContext')) errors.push('MOBILE CONSOLE: ' + m.text()); });
    await mp.goto(BASE + '?hole=1', { waitUntil: 'load' });
    await waitDbg(mp);
    // (poll after each tap: a SwiftShader frame with a 100k-vert world can
    //  take longer than any fixed sleep)
    const mtap = async (x, y, test, msg)=>
    {
        await mp.touchscreen.tap(x, y);
        for (let t=0; t<4000; t+=100)
        {
            if (test(await mp.evaluate('DBG()'))) return;
            await sleep(100);
        }
        errors.push('MOBILE: ' + msg);
    };
    await mtap(195, 500, d => d.state == 2, 'canvas tap should reach AIM (state 2)');
    const ow = await mp.evaluate('overlayCanvas.width');
    if (ow != 780) errors.push(`MOBILE: overlay canvas should be 780 device pixels wide at DPR 2, got ${ow}`);
    // the chips above the meter. Coordinates come from the game's own
    // meterBtns()/meterRect() rather than being hard-coded - HUD tweaks
    // move this row, and a stale literal here reads as a broken game.
    const L = await mp.evaluate(
        '(()=>{const b=meterBtns(), m=meterRect();' +
        'return {cy: b.y+b.h/2, xs: b.xs, w: b.w, mx: m.bx+m.bw/2, my: m.by+m.bh/2}})()');
    const d0 = await mp.evaluate('DBG()');
    await mtap(L.xs[0]+L.w*.75, L.cy, d => d.clubI != d0.clubI, 'tapping the club chip did not change the club');
    await mtap(L.xs[1]+L.w/2,  L.cy, d => d.spinMode, 'tapping the spin chip did not set spin');
    const t0 = (await mp.evaluate('DBG()')).shotTarget; // fresh: the club tap reset the target
    await mtap(L.xs[2]+L.w*.25, L.cy, d => d.shotTarget < t0, 'tapping the distance chip - did not lower the target');
    await mp.screenshot({ path: join(shotDir, '20-mobile-aim.png') });
    console.log('shot: 20-mobile-aim');
    await mtap(L.mx, L.my, d => d.state == 3, 'tapping the meter should start the swing (state 3)');
    await mp.screenshot({ path: join(shotDir, '21-mobile-meter.png') });
    console.log('shot: 21-mobile-meter');
    await mctx.close();

    // bot: 3 hole smoke (fast), or full round with --round
    await page.goto(BASE + `?auto=1&fast=1${fullRound ? '' : '&hole=1'}`, { waitUntil: 'load' });
    const targetResults = fullRound ? 19 : 3;
    const deadline = Date.now() + (fullRound ? 300 : 90)*1000;
    let shotN = 0;
    while (results.length < targetResults && Date.now() < deadline)
    {
        await sleep(2000);
        if (++shotN % 8 == 0)
            await shot('11-bot-' + String(shotN).padStart(3, '0'));
        const dbg = await page.evaluate('DBG()').catch(()=>null);
        if (dbg && dbg.state == 6) break; // results screen
    }
    await shot('12-bot-final');
    if (fullRound)
    {
        const dbg = await page.evaluate('DBG()').catch(()=>null);
        console.log('final state:', JSON.stringify(dbg));
    }
    // artifact (debug engine): must load clean and keep the debug tools
    const artifact = join(__dirname, '../artifact.html');
    if (fs.existsSync(artifact))
    {
        await page.goto(pathToFileURL(artifact).href, { waitUntil: 'load' });
        await sleep(1500);
        await click();
        await key('KeyM');
        await sleep(400);
        await shot('19-artifact-map');
        await key('KeyM');
    }
    else
        console.log('artifact.html missing - run "npm run artifact" first (artifact check skipped)');

    // release build (the real zip contents): Closure ADVANCED silently
    // renames any DOM property missing from its externs - roundRect once
    // became ctx.ja and the meter threw every frame in release only. No
    // DBG hook here, so drive it blind: title -> intro -> aim (meter drawn)
    const release = join(__dirname, '../build/index.html');
    if (fs.existsSync(release))
    {
        await page.goto(BASE + 'game/build/index.html', { waitUntil: 'load' });
        await sleep(2500);
        await clickMenu(1); // title -> CLASSIC (the CENTRE button since p146)
        await sleep(1200);
        await click(); // intro -> aim (meter + HUD draw here)
        await sleep(1500);
        await shot('25-release-aim');
        // ...and a full swing. Until now the release build was only ever
        // driven as far as the aim view, which is exactly how the roundRect
        // crash hid: it needed a state nobody smoke-tested. This covers the
        // meter's live phases, the flight camera, the trail and the banner.
        await key('Space'); // arm the meter
        await sleep(700);
        await key('Space'); // set power
        await sleep(400);
        await key('Space'); // impact -> swing
        await sleep(1800);
        await shot('26-release-flight');
        await sleep(7000);
        await shot('27-release-settled');
    }
    else
        console.log('build/index.html missing - run "npm run build" first (release check skipped)');
}
catch (e) { errors.push('HARNESS: ' + e.message); }

await browser.close();
server.kill();

console.log('\n--- playtest results ---');
for (const r of results) console.log(r);
console.log('\n--- errors ---');
if (errors.length)
{
    for (const e of errors) console.log(e);
    process.exit(1);
}
console.log('none');
