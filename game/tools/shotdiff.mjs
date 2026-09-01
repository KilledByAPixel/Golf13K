#!/usr/bin/env node
// Pixel-diff two screenshot folders from tools/shots.mjs: the visual gate
// for "this change must not alter the picture" work (code golf, refactors).
// Static views (aim, putt, map, forest) should come out <= ~1% changed;
// the animated ones (intro flyback, flight, bot, confetti, free cam) vary
// with SwiftShader frame timing and Math.random, so read those by eye.
// usage: cp -r game/shots game/shots-prev   (before the change)
//        npm run shots && npm run shotdiff  (after: shots-prev vs shots)
//        node tools/shotdiff.mjs [beforeDir] [afterDir]

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dirA = process.argv[2] || join(__dirname, '../shots-prev');
const dirB = process.argv[3] || join(__dirname, '../shots');
const chromePath = process.env.CHROME_PATH || [
    '/opt/pw-browsers/chromium',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));

// decode + compare in a page: no PNG library needed
const browser = await chromium.launch({ executablePath: chromePath });
const page = await browser.newPage();
const names = fs.readdirSync(dirA).filter(f => f.endsWith('.png') && fs.existsSync(join(dirB, f)));
for (const name of names)
{
    const a = 'data:image/png;base64,' + fs.readFileSync(join(dirA, name)).toString('base64');
    const b = 'data:image/png;base64,' + fs.readFileSync(join(dirB, name)).toString('base64');
    const r = await page.evaluate(async ([a, b]) =>
    {
        const load = (src) => new Promise(res => { const i = new Image; i.onload = () => res(i); i.src = src; });
        const [ia, ib] = await Promise.all([load(a), load(b)]);
        if (ia.width != ib.width || ia.height != ib.height) return 'size mismatch';
        const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height;
        const g = c.getContext('2d');
        g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, c.width, c.height).data;
        g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, c.width, c.height).data;
        let changed = 0, sum = 0;
        for (let i = 0; i < da.length; i += 4)
        {
            const d = Math.abs(da[i]-db[i]) + Math.abs(da[i+1]-db[i+1]) + Math.abs(da[i+2]-db[i+2]);
            sum += d;
            if (d > 30) ++changed;
        }
        const n = da.length/4;
        return `${(100*changed/n).toFixed(2).padStart(6)}% px changed, mean ${(sum/n/3).toFixed(2)}`;
    }, [a, b]);
    console.log(name.padEnd(30), r);
}
if (!names.length) console.log(`no matching .png pairs in ${dirA} and ${dirB}`);
await browser.close();
