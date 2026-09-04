#!/usr/bin/env node
// Headless golf sim: runs bot rounds directly in node (no browser) for
// instant physics/difficulty tuning. Loads engineMath + course + golfSim.
// The bot below is a COPY of debugGame.js's botSwing, not a load of it: a
// change to one must be made in the other, or this gate stops measuring the
// player you watch in the browser. sfxBounce / snd_bounce are stubbed because
// sfx.js is never loaded; a NEW sound called from golfSim breaks this and
// unit.mjs until it is stubbed in each.
// usage: node tools/sim.mjs [seed] [--remix] [--verbose] [--fixed] [--trees=K]

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (f)=> fs.readFileSync(join(__dirname, f), 'utf8');

const seedArg = +(process.argv[2]) || 1113;
const remix = process.argv.includes('--remix');
const verbose = process.argv.includes('--verbose');
// --trees=K scales the periphery forest, matching the ?trees=K debug param.
// Trees 75-180yd off the path COLLIDE, so forest density is a difficulty knob.
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
    ball.x=hole.path[0].x; ball.z=hole.path[0].z; ball.y=groundAt(ball.x,ball.z).h;
    ball.vx=ball.vy=ball.vz=0;
    let strokes=0, putts=0, log=[];
    for (let shot=0; shot<15 && strokes < hole.par+5; ++shot)
    {
        const d = ballToPin();
        const g = groundAt(ball.x, ball.z);
        const clubI = autoClub();
        ++strokes;
        // aim at fairway landing zone on long shots, pin otherwise
        const carry0 = CLUBS[clubI][1]*SURF_PHYS[g.s][3];
        distToPath(ball.x, ball.z);
        let tgt = hole.pin;
        if (clubI != CLUB_PUTTER && d > carry0+20)
            tgt = pathPointAt(Math.min(lastAlong + carry0*.95, hole.len));
        // a lay-up never aims INTO a lake (mirrors botSwing): walk it back
        // along the path until it is on land
        for (let a = lastAlong + carry0*.95; tgt != hole.pin && surfaceAt(tgt.x, tgt.z) == SURF_WATER; a -= 10)
            tgt = pathPointAt(a);
        // wind compensation
        let aim = Math.atan2(tgt.x-ball.x, tgt.z-ball.z);
        let drift = 0;   // hoisted: the shot branch below reads it too
        if (clubI != CLUB_PUTTER)
        {
            // THE SAME ESTIMATE AS debugGame's botSwing, from launchVel: the
            // old inline range formula left out CARRY_K, and since the drift
            // goes as speed x hang time squared that came out 1.43^1.5 = 40%
            // short of what the ball actually does (measured: a driver in a
            // 10 crosswind drifts 41yd; this bot corrected for 24, the
            // watched one for 42)
            const lv = launchVel({}, clubI, 0, SURF_PHYS[g.s][3]);
            const tf = 2*lv.vy/GRAV;
            drift = hole.wind.s*DRAG_K*WIND_V*Math.hypot(lv.vx, lv.vz)*tf*tf/2;
            const tx = tgt.x - Math.sin(hole.wind.a)*drift, tz = tgt.z - Math.cos(hole.wind.a)*drift;
            aim = Math.atan2(tx-ball.x, tz-ball.z);
        }
        if (clubI == CLUB_PUTTER)
        {
            ++putts;
            // d*PUTT_OVER plus the climb to the hole (mirrors botSwing)
            launchPutt(d*PUTT_OVER + (heightAt(hole.pin.x, hole.pin.z) - ball.y)*3.5,
                aim + rnd(.012,-.012));
        }
        else
        {
            const lie = SURF_PHYS[g.s][3];
            const carry = CLUBS[clubI][1]*lie;
            let td = Math.hypot(tgt.x-ball.x, tgt.z-ball.z);
            // head/tail from the same drift, tail weighted .65 (mirrors botSwing)
            const along = Math.cos(hole.wind.a - aim);
            td -= along*drift*(along < 0 ? 1 : .65);
            // land 8% short of a flag (the ball releases past it) - unless
            // the ground that far short of the flag is WATER, where short
            // is wet: an island approach aims at the flag itself
            if (tgt == hole.pin && surfaceAt(tgt.x - Math.sin(aim)*td*.1, tgt.z - Math.cos(aim)*td*.1) != SURF_WATER)
                td *= .92;

            launchBall(clubI, Math.min(Math.max(td/carry,.12),1), rnd(.04,-.04), 0, aim + rnd(.015,-.015), lie);
        }
        // simulate until event
        for (let t=0; t<60*30 && !ballEvent; ++t)
            ballUpdate();
        const EV_NAMES = [,'holed','stopped',,,'water','ob'];
        if (!ballEvent) ballEvent = 'STUCK';
        const g2 = groundAt(ball.x, ball.z);
        log.push(\`\${CLUBS[clubI][0]} d\${d|0} -> \${EV_NAMES[ballEvent] || ballEvent} \${SURF_NAMES[g2.s]} d\${ballToPin()|0}\`);
        if (shot==0 && (g2.s==SURF_FAIRWAY||g2.s==SURF_GREEN) && hole.par>3) stats.fairwayHits++;
        if (strokes == hole.par-2 && g2.s==SURF_GREEN) stats.girs++;
        const ev = ballEvent; ballEvent = 0;
        if (ev == EV_HOLED) break;
        if (ev=='STUCK') { log.push('BALL NEVER STOPPED'); break; }
        if (ev >= EV_WATER)
        {
            ++strokes;
            // hazard-edge drop, matching game.js
            const ddx=shotStart.x-ballSafe.x, ddz=shotStart.z-ballSafe.z;
            const dl=Math.hypot(ddx,ddz)||1;
            // walk back to ground that HOLDS the ball, matching game.js
            for (let d=2; ; d+=2)
            {
                const t=Math.min(d,dl);
                ball.x=ballSafe.x+ddx/dl*t; ball.z=ballSafe.z+ddz/dl*t;
                const g=groundAt(ball.x,ball.z);
                ball.y=g.h;
                if (t == dl || g.s < SURF_WATER
                    && Math.hypot(...slopeAt(ball.x,ball.z))*GRAV < SURF_PHYS[g.s][2])
                    break;
            }
            ball.vx=ball.vy=ball.vz=0;
            stats[ev == EV_WATER ? 'water' : 'ob']++;
        }
    }
    stats.putts += putts;
    stats.maxHole = Math.max(stats.maxHole, strokes);
    total += strokes; totalPar += hole.par;
    console.log(\`hole\${hi+1} par\${hole.par} len\${hole.len|0} : \${strokes}\`);
    if (${verbose ? 1 : 0}) for (const l of log) console.log('   ', l);
}
console.log(\`TOTAL \${total} (par \${totalPar}, \${total-totalPar>=0?'+':''}\${total-totalPar})\`);
console.log('stats', JSON.stringify(stats));
`;

new Function(src)();
