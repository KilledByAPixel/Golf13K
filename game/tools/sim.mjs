#!/usr/bin/env node
// Headless golf sim: runs bot rounds directly in node (no browser) for
// instant physics/difficulty tuning. Loads engineMath + course + golfSim.
// usage: node tools/sim.mjs [seed] [--remix] [--verbose]

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (f)=> fs.readFileSync(join(__dirname, f), 'utf8');

const seedArg = +(process.argv[2]) || 1113;
const remix = process.argv.includes('--remix');
const verbose = process.argv.includes('--verbose');
// --trees=K scales the periphery forest, matching the ?trees=K debug param.
// Trees 75-180yd off the path are k=0 and COLLIDE, so forest density is a
// difficulty knob, not only an art one - this is how to measure that.
const treesArg = +(process.argv.find(a => a.startsWith('--trees='))||'').split('=')[1];
// --fixed seeds Math.random so the bot plays identical shots every run:
// the ONLY way to tell a real difficulty change from the bot's variance
// (its swing error is random, and a single round swings +5 either way).
// Compare two code versions with --fixed; read the band with plain runs.
if (process.argv.includes('--fixed'))
{
    let s = 12345;
    Math.random = ()=> { s = (s*1664525 + 1013904223) >>> 0; return s/2**32; };
}

const src =
    'let debug=0; const ASSERT=()=>{}; let time=0, frame=0; const sfxBounce=()=>{}; const snd_bounce={play(){}};\n'
    + read('../../src/engineMath.js')
    + read('../course.js')
    + read('../golfSim.js')
    + `
// ---- bot round ----
const rnd=(a=1,b=0)=>b+Math.random()*(a-b);
forestMul = ${treesArg || 1};
const rows = genCourse(${seedArg}, ${remix ? 1 : 0});
let total=0, totalPar=0, stats={fairwayHits:0, girs:0, putts:0, water:0, ob:0, maxHole:0};
for (let hi=0; hi<18; ++hi)
{
    genHole(${seedArg}, hi, rows[hi]);
    ball.x=H.path[0].x; ball.z=H.path[0].z; ball.y=groundAt(ball.x,ball.z).h;
    ball.vx=ball.vy=ball.vz=0;
    let strokes=0, putts=0, log=[];
    for (let shot=0; shot<15 && strokes < H.par+5; ++shot)
    {
        const d = ballToPin();
        const g = groundAt(ball.x, ball.z);
        const clubI = autoClub();
        ++strokes;
        // aim at fairway landing zone on long shots, pin otherwise
        const carry0 = CLUBS[clubI][1]*SURF_PHYS[g.s][3];
        distToPath(ball.x, ball.z);
        let tgt = H.pin;
        if (clubI != CLUB_PUTTER && d > carry0+20)
            tgt = pathPointAt(Math.min(lastAlong + carry0*.95, H.len));
        // wind compensation
        let aim = Math.atan2(tgt.x-ball.x, tgt.z-ball.z);
        if (clubI != CLUB_PUTTER)
        {
            const la = (CLUBS[clubI][2]+7)*Math.PI/180;
            const v = Math.sqrt(carry0*GRAV/Math.sin(2*la));
            const tf = 2*v*Math.sin(la)/GRAV;
            const drift = H.wind.s*DRAG_K*WIND_V*tf*tf/2;
            const tx = tgt.x - Math.sin(H.wind.a)*drift, tz = tgt.z - Math.cos(H.wind.a)*drift;
            aim = Math.atan2(tx-ball.x, tz-ball.z);
        }
        if (clubI == CLUB_PUTTER)
        {
            ++putts;
            launchPutt(d*1.06, aim + rnd(.012,-.012));
        }
        else
        {
            const lie = SURF_PHYS[g.s][3];
            const carry = CLUBS[clubI][1]*lie;
            launchBall(clubI, Math.min(Math.max(d/carry,.12),1), rnd(.04,-.04), 0, aim + rnd(.015,-.015), lie);
        }
        // simulate until event
        for (let t=0; t<60*30 && !ballEvent; ++t)
            ballUpdate();
        const EV_NAMES = [,'holed','stopped',,,'water','ob'];
        if (!ballEvent) ballEvent = 'STUCK';
        const g2 = groundAt(ball.x, ball.z);
        log.push(\`\${CLUBS[clubI][0]} d\${d|0} -> \${EV_NAMES[ballEvent] || ballEvent} \${SURF_NAMES[g2.s]} d\${ballToPin()|0}\`);
        if (shot==0 && (g2.s==SURF_FAIRWAY||g2.s==SURF_GREEN) && H.par>3) stats.fairwayHits++;
        if (strokes == H.par-2 && g2.s==SURF_GREEN) stats.girs++;
        const ev = ballEvent; ballEvent = 0;
        if (ev == EV_HOLED) break;
        if (ev=='STUCK') { log.push('BALL NEVER STOPPED'); break; }
        if (ev >= EV_WATER)
        {
            ++strokes;
            // hazard-edge drop, matching game.js
            const ddx=shotStart.x-ballSafe.x, ddz=shotStart.z-ballSafe.z;
            const dl=Math.hypot(ddx,ddz)||1;
            ball.x=ballSafe.x+ddx/dl*2; ball.z=ballSafe.z+ddz/dl*2;
            ball.y=groundAt(ball.x,ball.z).h;
            ball.vx=ball.vy=ball.vz=0;
            stats[ev == EV_WATER ? 'water' : 'ob']++;
        }
    }
    stats.putts += putts;
    stats.maxHole = Math.max(stats.maxHole, strokes);
    total += strokes; totalPar += H.par;
    console.log(\`H\${hi+1} par\${H.par} len\${H.len|0} : \${strokes}\`);
    if (${verbose ? 1 : 0}) for (const l of log) console.log('   ', l);
}
console.log(\`TOTAL \${total} (par \${totalPar}, \${total-totalPar>=0?'+':''}\${total-totalPar})\`);
console.log('stats', JSON.stringify(stats));
`;

new Function(src)();
