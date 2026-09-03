#!/usr/bin/env node
// Headless unit checks for the pure game logic (course.js + golfSim.js),
// loaded exactly like tools/sim.mjs. Cases live in unit-cases.js as a plain
// script so they can call the game globals directly.
// usage: node tools/unit.mjs   (npm run unit)

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (f)=> fs.readFileSync(join(__dirname, f), 'utf8');

let fails = 0, count = 0;
globalThis.eq = (actual, expected, msg)=>
{
    ++count;
    if (actual !== expected)
    {
        ++fails;
        console.log(`FAIL ${msg}: expected ${expected}, got ${actual}`);
    }
};

// glRender.js loads too (it only defines functions at load; glInit is never
// called here), so the packed-color / primitive helpers are testable.
// sfxBounce / snd_bounce are stubbed because sfx.js is never loaded: a NEW
// sound called from golfSim breaks this and sim.mjs until it is stubbed in each.
const src =
    'let debug=0; const ASSERT=()=>{}; let time=0, frame=0; const sfxBounce=()=>{}; const snd_bounce={play(){}};\n'
    // Wind is rolled per PLAY from Math.random, so seed it (the same LCG as
    // sim.mjs --fixed) or any case that depends on it is flaky.
    + 'let _s=1; Math.random = ()=> { _s = (_s*1664525 + 1013904223) >>> 0; return _s/2**32; };\n'
    + 'let camX=0, camY=0, camZ=0, camYaw=0, camPitch=0;\n' // view3d globals glRender reads
    + read('../../src/engineMath.js')
    + read('../../src/engineUtilities.js')
    + read('../course.js')
    + read('../golfSim.js')
    + read('../glRender.js')
    // buildWorld() sets glLightDir per hole and is never called headless, so
    // the harness supplies one (packColor dots every normal against it). The
    // game has no default: a dead initialiser would only cost release bytes.
    + 'glLightDir = vec3(.35, .8, .3).normalize();\n'
    + read('./unit-cases.js');
new Function(src)();

console.log(`${count - fails}/${count} checks passed`);
process.exit(fails ? 1 : 0);
