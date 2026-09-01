// unit cases - run by unit.mjs with engineMath + course + golfSim loaded

// ---- ball trail: timestamped samples that expire after TRAIL_LIFE ----
ball.x = 1; ball.y = 2; ball.z = 3;
trailPush(0);
ball.x = 4;
trailPush(.5);
trailPush(1.2);
eq(trail.length, 3, 'trailPush appends one sample per call');
eq(trail[0].x, 1, 'a sample records the ball position at push time');
eq(trail[0].t, 0, 'a sample records its timestamp');
trailPrune(1.2);
eq(trail.length, 2, 'trailPrune drops samples older than TRAIL_LIFE');
eq(trail[0].t, .5, 'trailPrune keeps the oldest sample still within TRAIL_LIFE');
trailPrune(3);
eq(trail.length, 0, 'trailPrune empties a stale trail');

// ---- GL: packed lit colors and the lathe primitive (Phase 3, Task 1) ----
// White lit by a +z normal, checked against the FORMULA rather than a baked
// constant: the old version hard-coded the packed word, so every time Frank
// nudged glAmbient or glLightColor - which are his to tune - this failed and
// said nothing useful. It now re-derives the expectation from the live
// constants, so it still catches a broken packColor and ignores a retune.
{
    const L = Math.max(0, glLightDir.z);
    const ch = (i)=> Math.min(255, (glAmbient[i] + glLightColor[i]*L)*255)|0;
    eq(packColor(new Color(1,1,1,1), vec3(0,0,1)) >>> 0,
        (255<<24 | ch(2)<<16 | ch(1)<<8 | ch(0)) >>> 0,
        'packColor bakes ambient + sun*N.L');
    // and it must actually be doing the lighting, not passing colour through
    eq(ch(0) < 255 && ch(0) > 0, true, 'the lit channel is neither black nor clipped');
}
// no normal = unlit: channels straight through, little-endian RGBA
eq(packColor(new Color(0,.5,1,.5)) >>> 0, 0x7FFF7F00, 'packColor unlit packs RGBA8 little-endian');
// lit colors clamp at 255
eq(packColor(new Color(1,1,1,1), vec3(.35,.8,.3).normalize()) & 255, 255, 'packColor clamps a bright channel');
// lathe: 2 ring pairs x 4 sides x (4 verts + 2 caps)
glVertexData = new Float32Array(1e4); glVertexU32 = new Uint32Array(glVertexData.buffer); glBatchCount = 0;
pushLathe(vec3(0,0,0), [[0,-1],[1,0],[0,1]], 4, new Color(1,1,1));
eq(glBatchCount, 48, 'pushLathe emits one capped quad strip per ring pair per side');
eq(glVertexData[3], 0, 'vertex w is the fog flag: 0 = fogged');
glEnableFog = 0; glBatchCount = 0;
glPushVerts([vec3(0,0,0), vec3(1,0,0)], packColor(new Color));
eq(glVertexData[3], 1, 'fog-exempt pushes set w = 1');
eq(glBatchCount, 4, 'glPushVerts caps a strip with one extra vertex at each end');
glEnableFog = 1;

// ---- periphery hills: flat inside the corridor, rising beyond the OB band ----
genHole(1113, 0, CLASSIC_HOLES[0]);
eq(Math.abs(heightAt(0, 120) - heightRaw(0, 120)) < 1e-9, true, 'no periphery lift on the fairway');
eq(heightAt(400, 150) - heightRaw(400, 150) > 15, true, 'ground rises 400yd off the path');
eq(heightAt(150, 150) - heightRaw(150, 150) < 2, true, 'the rise starts gently past 110yd');
// ---- non-uniform grid: 4yd cells inside, growing steps outside, sorted ----
const ax = gridAxis(0, 40);
eq(ax[12], 0, '12 coarse steps precede the fine range');
eq(ax[13] - ax[12], MESH_CELL, 'fine cells are MESH_CELL wide');
eq(ax.every((v, i)=> !i || v > ax[i-1]), true, 'axis is strictly increasing');
eq(ax[ax.length-1] > 500, true, 'the axis reaches past 500yd beyond the corridor');

// ---- REMIX is the classic course RE-DEALT: the same 18 hand-tuned rows,
// shuffled by the course seed, which also re-rolls every hole's land. The
// shuffle must be a true permutation (nothing lost, nothing doubled) and
// DETERMINISTIC from the seed - the save stores that seed, so a continued
// remix round has to deal the same order every time. ----
for (const seed of [1, 7, 99, 4242, 31337, 999983])
{
    const rows = genCourse(seed, 1);
    eq(rows.length == 18 && new Set(rows).size == 18
        && rows.every(r => CLASSIC_HOLES.includes(r)), true,
        'remix seed ' + seed + ' deals a true permutation of the classic rows');
    eq(rows.reduce((t, r)=> t + r[0], 0),
        CLASSIC_HOLES.reduce((t, r)=> t + r[0], 0),
        'remix seed ' + seed + ' keeps the classic par total');
    eq(genCourse(seed, 1).map(r => CLASSIC_HOLES.indexOf(r)).join(),
        rows.map(r => CLASSIC_HOLES.indexOf(r)).join(),
        'remix seed ' + seed + ' deals the SAME order every time (continue depends on it)');
}
eq(genCourse(7, 1).map(r => CLASSIC_HOLES.indexOf(r)).join()
    != genCourse(99, 1).map(r => CLASSIC_HOLES.indexOf(r)).join(), true,
    'different seeds deal different orders');
eq(genCourse(7, 0), CLASSIC_HOLES, 'classic is the untouched table itself');
// classic's own two island greens stay on holes 8 and 16
eq(CLASSIC_HOLES.map((r, i)=> r[0] == 3 && r[5] == 1 ? i+1 : 0).filter(h => h).join(),
    '8,16', 'classic keeps its island greens on holes 8 and 16');

// ---- forests and bushes ----
forestMul = 1;
genHole(1113, 0, CLASSIC_HOLES[0]);
const kinds = [0,0,0];
for (const t of H.trees) ++kinds[t.k];
eq(kinds[0] > 40, true, 'the hole keeps its framing trees (+ the near forest)');
eq(kinds[1] > 200, true, 'a periphery forest exists');
eq(kinds[2] > 15, true, 'bushes line the corridor');
eq(H.trees.every(t => t.k != 1 || distToPath(t.x, t.z) > 75), true, 'forest trees stay off the playable corridor');
forestMul = 0;
genHole(1113, 0, CLASSIC_HOLES[0]);
eq(H.trees.filter(t => t.k == 1).length, 0, 'forestMul 0 disables the forest');
forestMul = 1;

// ---- the ball never goes under the height field (it used to tunnel into
// hills while climbing and drop into the water beneath) ----
genHole(1113, 12, CLASSIC_HOLES[12]); // hilly back-nine hole
let under = 0;
for (let i=0; i<24; ++i)
{
    ball.x = H.path[0].x; ball.z = H.path[0].z; ball.y = groundAt(ball.x, ball.z).h;
    // i % CLUB_PUTTER = every club that flies, whatever the bag holds.
    // Was i%9, which meant "every club" until the 13 iron pushed the SW to 9
    // and quietly dropped it from the sweep.
    launchBall(i % CLUB_PUTTER, 1, 0, 0, i*.26, 1); // headings all round the clock
    for (let n=0; n<900 && !ballEvent; ++n)
    {
        ballUpdate();
        if (ball.y < groundAt(ball.x, ball.z).h - 1e-6) ++under;
    }
}
eq(under, 0, 'the ball never ends a step below the ground');

// ---- target-scaled power: predictLanding at half power carries ~half ----
genHole(1113, 0, CLASSIC_HOLES[0]);
ball.x = 0; ball.z = 0; ball.y = groundAt(0, 0).h;
const pFull = predictLanding(0, 0, 0, 1), pHalf = predictLanding(0, 0, 0, 1, .5);
const cFull = Math.hypot(pFull.x, pFull.z), cHalf = Math.hypot(pHalf.x, pHalf.z);
eq(cHalf > cFull*.35 && cHalf < cFull*.65, true, 'powerFrac .5 lands near half the full carry');

// ---- the aim ring must not collapse at the player's feet when they stand
// below a slope and aim up it. predictLanding used to end the flight on ANY
// ground contact, but ballUpdate only LANDS a descending ball - clipping a
// rise on the way up reflects off the slope and the shot carries over it.
// Frank hit one of these anyway and it sailed over the hill, which is how it
// was found. Measured before the fix, on a .5 gradient: the ring predicted
// 0.6yd against a real 307yd touchdown. ----
{
    genHole(1113, 0, CLASSIC_HOLES[0]);
    const realH = heightAt, realG = groundAt;
    H.near = []; H.wind = {a: 0, s: 0};
    for (const slope of [.3, .5, .8])
    {
        // a mound: rises for 30yd, then levels off
        heightAt = (x, z)=> Math.min(Math.max(x, 0)*slope, 30*slope);
        groundAt = (x, z)=> ({h: heightAt(x, z), s: SURF_FAIRWAY});
        ball.x = ball.z = 0; ball.y = heightAt(0, 0);
        const p = predictLanding(0, Math.PI/2, 0, 1, 1);   // driver, straight up the slope
        eq(Math.hypot(p.x, p.z) > 100, true,
            'the aim ring clears a ' + slope + ' upslope instead of landing at the ball');
    }
    heightAt = realH; groundAt = realG;
}

// ---- THE PIN is a thin post the ball can clatter off - but only a ball
// that was NOT going in. A chip-in or an ace must never be knocked away by
// the stick, so the cup is settled first and the pin skipped when it holes.
// cupHit does the geometry: it tests the step's whole PATH, which it must,
// because at flight speed a step is most of a yard and a position-only test
// would tunnel through a .1yd post nearly every time. ----
{
    genHole(1113, 0, CLASSIC_HOLES[0]);
    const realH = heightAt, realG = groundAt;
    H.near = []; H.wind = {a: 0, s: 0};
    heightAt = ()=> 0;
    groundAt = ()=> ({h: 0, s: SURF_GREEN});
    // fly a ball through the pin's airspace, offset sideways by 'off'
    const clip = (off)=>
    {
        ball.x = H.pin.x - 1; ball.z = H.pin.z + off; ball.y = 1.5;
        ball.vx = 25; ball.vy = ball.vz = 0;
        shotBegin(1, 0); // NOT by hand: this is what clears the pin latch
        let minVx = 25;
        for (let n = 0; n < 12 && !ballEvent; ++n)
        {
            ballUpdate();
            minVx = Math.min(minVx, ball.vx);
        }
        ballEvent = 0;
        return minVx;
    };
    eq(clip(0) < 0, true, 'a ball flown into the pin is kicked back off it');
    eq(clip(4) > 24, true, 'and one passing 4yd wide of it is untouched');
    // ONE strike per shot, latched in shotBegin. A step at flight speed is
    // most of a yard, so the ball tunnels clean through the .2yd post, is
    // reflected onto the far side, and crosses back into it next step - a
    // genuine approach every time, so the dot-product guard cannot stop it.
    // Each pass took another 40% of the horizontal speed until the ball just
    // dropped down the stick; Frank heard the bounce fire four times on one
    // throw. Counted here as sign flips in vx, which needs no sound hook.
    const strikes = (sp)=>
    {
        ball.x = H.pin.x - 3; ball.z = H.pin.z; ball.y = 1;
        ball.vx = sp; ball.vy = ball.vz = 0;
        shotBegin(1);
        let hits = 0, last = sp;
        for (let n = 0; n < 60 && ballAir && !ballEvent; ++n)
        {
            ballUpdate();
            if (ball.vx * last < 0) ++hits;
            last = ball.vx;
        }
        ballEvent = 0;
        return hits;
    };
    for (const sp of [15, 25, 40, 60])
        eq(strikes(sp) < 2, true, `the pin is struck at most once per shot at ${sp}yd/s`);
    // a ball dropping INTO the cup must still drop, stick or no stick
    ball.x = H.pin.x; ball.z = H.pin.z - 5; ball.y = 0;
    launchPutt(5, 0);
    for (let n = 0; n < 3000 && !ballEvent; ++n) ballUpdate();
    eq(ballEvent, EV_HOLED, 'a putt still drops with the pin in');
    ballEvent = 0;
    heightAt = realH; groundAt = realG;
}

// ---- swing meter: the power cursor rises, bounces off the top, and a
// full round trip without a click cancels ----
meterStart();
for (let i=0; i<30; ++i) meterUpdate(0, 0);
eq(meterPos() > .3 && meterPos() < .6, true, 'the cursor climbs during the rise');
for (let i=0; i<70; ++i) meterUpdate(0, 0);     // 100 frames = past the apex
eq(meterPos() < .99 && meterPos() > .3, true, 'the cursor comes back down after the top');
const posBefore = meterPos();
eq(meterUpdate(1, 0), MET_POWER, 'a click on the way down still sets power');
eq(Math.abs(meterPower - posBefore) < .05, true, 'power = the cursor position at the click');
eq(meterPhase, 2, 'the accuracy sweep follows the power click');
meterStart();
let mev = '';
for (let i=0; i<300 && !mev; ++i) mev = meterUpdate(0, 0);
eq(mev, MET_CANCEL, 'a full rise and fall without a click cancels the swing');
meterStart();
for (let i=0; i<30; ++i) meterUpdate(0, 1);
eq(meterUpdate(1, 1), MET_SWING, 'a putt swings on the power click alone');
meterPhase = 0;

// ---- meshHeightAt: props sit on the DRAWN terrain (the coarse periphery
// cells cut chords through the analytic hills - far trees floated) ----
genHole(1113, 0, CLASSIC_HOLES[0]);
buildGrid();
eq(meshHeightAt(meshXs[3], meshZs[5]), meshH[5][3], 'a grid vertex returns its own height');
const cx = (meshXs[3]+meshXs[4])/2, cz = (meshZs[5]+meshZs[6])/2;
eq(Math.abs(meshHeightAt(cx, cz) - (meshH[5][3]+meshH[6][4])/2) < 1e-9, true,
    'a cell centre lies on the strip diagonal (mean of the diagonal pair)');
eq(Math.abs(meshHeightAt(cx, meshZs[5]) - (meshH[5][3]+meshH[5][4])/2) < 1e-9, true,
    'an edge midpoint is the mean of its two vertices');

// ---- tree collision: a ball flying into a near tree's canopy drops out of
// it (forgiving: the sphere sits well inside the drawn canopy) ----
genHole(1113, 0, CLASSIC_HOLES[0]);
const shot = (near)=>
{
    H.near = near;
    ball.x = ball.z = 0; ball.y = groundAt(0, 0).h;
    treeHit = 0;
    launchBall(0, 1, 0, 0, 0, 1);            // driver, dead straight down z
    for (let n=0; n<900 && !ballEvent; ++n) ballUpdate();
    ballEvent = 0;
    return Math.hypot(ball.x, ball.z);
};
eq(shot([]) > 200, true, 'with no near trees a driver carries the fairway');
// t.y is the CANOPY CENTRE, not the ground - trunkH() is the one definition
// of that offset, shared by the renderer, genHole and this fixture
const prop = (z, s, k)=> ({x: 0, z, s, k, y: groundAt(0, z).h + trunkH({s, k})});
eq(shot([prop(30, 2.5, 0)]) < 60, true, 'a tree in the flight path stops the ball near it');
eq(treeHit, 1, 'the hit is flagged for the HUD');

// A BUSH IS A LOW TREE: same sphere, same code path, just a shorter trunk.
// It must sit low enough that a driver clears it and high enough to matter
// near the ground - that is the whole gameplay difference between the two.
eq(trunkH({s: 2, k: 2}) < trunkH({s: 2, k: 0}), true, 'a bush canopy sits below a tree canopy');
eq(shot([prop(30, 2, 2)]) > 200, true, 'a driver flies clean over a bush 30yd out');

// ---- the TRUNK sweeps the step path like the pin post. At 60yd/s a step
// is a whole yard, and the old position-only test let a liner pass clean
// through a half-yard trunk whenever no sample landed inside it - the
// bulletproof-paper bug. This flight is tuned so its samples STRADDLE the
// trunk (z 10, 11 against a trunk at 10.5): position-testing misses by
// .5yd on both sides, sweeping cannot miss. ----
{
    const realH = heightAt, realG = groundAt, realNear = H.near, realWind = H.wind;
    heightAt = ()=> 0; groundAt = ()=> ({h: 0, s: SURF_FAIRWAY});
    H.wind = {a: 0, s: 0};
    // canopy centre 5yd up: a ball at y~1 is in trunk territory (dy < 0)
    H.near = [{x: 0, z: 10.5, s: 1, k: 0, y: 5}];
    ball.x = 0; ball.z = 0; ball.y = 1;
    ball.vx = 0; ball.vz = 60; ball.vy = 0;
    shotBegin(1, 0);
    let minVz = 60;
    for (let n = 0; n < 12 && !ballEvent; ++n)
    {
        ballUpdate();
        minVz = Math.min(minVz, ball.vz);
    }
    eq(minVz < 0, true, 'a liner through a thin trunk is stopped, not tunnelled');
    eq(ball.z < 10.6, true, 'and rolled back to the impact point, not left past the tree');
    ballEvent = 0; ballAir = ballRolling = 0;
    heightAt = realH; groundAt = realG; H.near = realNear; H.wind = realWind;
}

// ---- resting rule: the ball only comes to rest where friction can hold it
// (a synthetic hillside: heightAt is a plain global, so swap it) ----
const realHeight = heightAt;
heightAt = (x, z)=> x*.7;                      // a 35-degree hillside (pull 7.7 > fairway friction 6) at (0,100)
ball.x = 0; ball.z = 100; ball.vx = ball.vz = ball.vy = 0;
ballRolling = 1; ballAir = 0; ballEvent = 0;
for (let n=0; n<180; ++n) ballUpdate();
eq(ballEvent, 0, 'at rest on a hillside steeper than friction can hold, the ball keeps rolling');
eq(ball.x < -3, true, 'and it rolls downhill');
heightAt = (x, z)=> 0;                         // flat
ball.x = 0; ball.vx = .3; ball.vz = 0; ballRolling = 1; ballEvent = 0;
for (let n=0; n<60; ++n) ballUpdate();
eq(ballEvent, EV_STOPPED, 'on the flat it comes to rest');
heightAt = realHeight;

// ---- the landing prediction shares flyStep: predicting a flight into a
// tree must NOT flag a hit (it played the tree sound 60x a second in aim) ----
H.near = [{x: 0, z: 30, s: 2.5, k: 0, y: groundAt(0, 30).h}];
ball.x = ball.z = 0; ball.y = groundAt(0, 0).h; treeHit = 0;
const pTree = predictLanding(0, 0, 0, 1);
eq(treeHit, 0, 'predicting a flight into a tree does not flag a hit');
eq(Math.hypot(pTree.x, pTree.z) > 100, true, 'and it flies straight past: the ring ignores trees, so it cannot jump');


// ---- the DRAW ORDER is pinned. genHole spends its seeded randoms in a
// fixed sequence, and the wind's two draws sit BEFORE the scenery precisely
// so that scenery edits cannot move what a hole plays like. If the number or
// order of draws ever changes, every hole on the course silently re-rolls -
// which is what these fingerprints exist to catch.
//
// The rows are LITERALS here, not CLASSIC_HOLES[n], and that matters: the
// hole table is design data Frank tunes (hole 1's lenScale went .85 -> .90
// on 2026-08-28 to make it feel like a par 4). Reading the live table made
// every such tweak fail this test, which trains you to re-baseline on
// reflex - and re-baselining on reflex is exactly how a real draw-order
// change would slip through. Against a fixed row, only genHole moving can
// break it, so a failure here is always worth reading.
//
// (These two rows were CLASSIC_HOLES 1 and 13 when the fingerprints were
// captured on 2026-08-23. They no longer need to match the table.)
//
// RE-PINNED 2026-08-29 when the par-4 base length went 370 -> 410 and par-5
// 505 -> 620. That is a deliberate geometry change, so these had to move -
// and HOW they moved is the evidence it was clean: the x coordinates are
// byte-identical (21.100 and 54.102) and only z grew. Lengthening a hole
// pushes props downrange and nowhere else, and an unshifted x means the R
// stream is still spending its draws in the same order. Had x moved too,
// the length change would have re-rolled the course and that WOULD have
// been worth stopping for.
//
// RE-PINNED AGAIN 2026-08-30 for two tuning tweaks in 78fbb6e/f686394: the
// tree scatter's near end went -10 -> -9 (moves tree 5's z, x untouched)
// and a dogleg's bend range .45-.62 -> .45-.6. Both are deliberate.
//
// RE-PINNED AGAIN 2026-08-31 for Frank's course overhaul (ddcab41): the
// flower hue now spends an R draw, the wind left the R stream entirely
// (it is pure rand() now - no throwaway draws to protect any more), and
// the tree scatters changed their draw pattern. x moved as well as z,
// which is the signature of a full deliberate re-roll - Frank tuned the
// re-rolled course by playing it, so these values are the new baseline. ----
genHole(1113, 0, [4, .85, 34, 0, 1, 0, .5, .3]);
eq(H.bunkers[0].x.toFixed(3) + ',' + H.bunkers[0].z.toFixed(3), '5.391,324.790', 'the draw order still puts bunker 0 where it always was');
eq(H.trees[5].x.toFixed(3) + ',' + H.trees[5].z.toFixed(3), '-45.463,129.655', 'and tree 5 where it always was');
genHole(1113, 12, [4, 1.05, 22, 1, 3, .3, 1.2, 1]);
eq(H.trees[5].x.toFixed(3) + ',' + H.trees[5].z.toFixed(3), '50.009,322.853', 'a dogleg hole with water and hills too');

// pathPointAt itself, because the fingerprints above did NOT catch it
// breaking: a backward rewrite made every call return from the final path
// segment, and trees[5] on the dogleg hole landed in that segment either
// way. Its neighbours moved by up to 232yd. A prop fingerprint is a sample,
// not a contract - so pin the contract.
genHole(1113, 12, [4, 1.05, 22, 1, 3, .3, 1.2, 1]);
const P0 = H.path[0], P1 = H.path[1], mid = pathPointAt(P1.cum/2);
eq(H.path.length, 3, 'the dogleg has two segments to get wrong');
eq(pathPointAt(0).z, P0.z, 'd 0 is the tee, not the bend');
eq(Math.hypot(mid.x - P1.x/2, mid.z - P1.z/2) < 1e-9, true, 'a point in the FIRST segment interpolates within it');
eq(pathPointAt(H.len).z.toFixed(3), H.green.z.toFixed(3), 'd = len is the green');
eq(pathPointAt(-50).z, P0.z, 'behind the tee clamps to the tee');
eq(pathPointAt(H.len*2).z.toFixed(3), H.green.z.toFixed(3), 'past the green clamps to the green');
// ---- wind: calm holes and windy holes, within the HUD's range. Rolled per
// PLAY from Math.random (seeded in unit.mjs), not from the hole's seed ----
// NEVER ZERO: the arrow always points somewhere, so a reading of 0 reads as
// a bug rather than as calm. And the round must actually vary - a whole
// round of light air is what made wind irrelevant before.
let lo = 99, hi = 0;
for (let h=0; h<18; ++h)
{
    genHole(1113, h, CLASSIC_HOLES[h]);
    eq(H.wind.s >= 1 && H.wind.s <= 21, true, 'hole ' + (h+1) + ' wind is within 1..21');
    lo = Math.min(lo, H.wind.s); hi = Math.max(hi, H.wind.s);
}
eq(hi - lo > 4, true, 'a round carries a real spread of wind, not one flat value');
eq(hi > 6, true, 'and at least one hole is genuinely windy');

// ---- every classic hole generates finite terrain and features (hole 13
// lost its hills column to a sed in the palette change and went NaN; the
// ball-under-terrain case above passed vacuously because NaN compares false) ----
for (let h=0; h<18; ++h)
{
    genHole(1113, h, CLASSIC_HOLES[h]);
    const ok = isFinite(heightAt(0, 0) + heightAt(H.green.x, H.green.z) + H.greenH)
        && H.bunkers.every(b => isFinite(b.x + b.z + b.rx + b.rz));
    eq(ok, true, 'hole ' + (h+1) + ' has finite terrain and bunkers');
}

// ---- wind has to BITE, and reading it is the PLAYER's job. Until
// 2026-08-30 solveAim quietly corrected the default aim for drift and
// elevation; now the ring marks where you aimed, so this miss is the
// feature rather than a bug (Frank: "I'd rather the player would have to").
// The pair matters: the shot misses in wind and does NOT miss in calm, so
// the drift is the wind and not a broken prediction. ----
genHole(1113, 15, CLASSIC_HOLES[15]);           // hole 16: island green
// Wind is rolled per PLAY, so this case pins its own rather than hoping the
// hole rolls windy.
ball.x = ball.z = 0; ball.y = groundAt(0, 0).h;
const c16 = autoClub(), max16 = CLUBS[c16][1];
const atPin = ()=> predictLanding(c16, Math.atan2(H.pin.x, H.pin.z), 0, 1, ballToPin()/max16);
H.wind = {a: 1, s: 8};
const windy = atPin();
eq(Math.hypot(windy.x-H.pin.x, windy.z-H.pin.z) > 3, true, 'aiming straight at the pin misses by yards in the wind');
H.wind = {a: 1, s: 1};
const calm = atPin();
// vs the SAME aim in calm, not vs the pin: this hole's green is well above
// the tee, so the straight aim falls short whatever the wind does. Comparing
// the two isolates the wind, which is the thing the player has to read.
eq(Math.hypot(windy.x-calm.x, windy.z-calm.z) > 3, true, 'and the wind alone is what moved it');

// ---- launchPutt takes YARDS, so the meter is linear in distance: half a
// meter rolls half as far. It used to take a speed fraction, and roll goes
// as v^2, so a half-power putt only reached a quarter of the target ----
genHole(1113, 0, CLASSIC_HOLES[0]);
const puttRoll = (surf, dist)=>
{
    const realGround = groundAt, realHeight = heightAt;
    groundAt = ()=> ({h: 0, s: surf});   // a flat synthetic surface
    heightAt = ()=> 0;
    ball.x = ball.z = ball.y = 0;
    launchPutt(dist, 0);
    for (let i=0; i<900 && !ballEvent; ++i) ballUpdate();
    ballEvent = 0;
    const d = Math.hypot(ball.x, ball.z);
    groundAt = realGround; heightAt = realHeight;
    return d;
};
const full = puttRoll(SURF_GREEN, 40), half = puttRoll(SURF_GREEN, 20);
eq(Math.abs(full - 40) < 3, true, 'a putt asked for 40yd rolls about 40yd');
eq(Math.abs(half - 20) < 2, true, 'and half the distance rolls half as far');
// OFF the green a putt is measured against the GREEN's friction anyway, so
// it falls SHORT - the lie eats it, and the player adds power to compensate.
// This used to be measured against the LIE, which made the asked distance a
// lie the moment the ball rolled onto the green: it was launched hard enough
// to cover 8yd of rough, then crossed onto a surface with 4.7x less friction
// and kept going. Frank's telemetry, asking 8yd from rough: 15, 17 and 24yd.
// The invariant that matters is the last one - a putt must NEVER outrun what
// the meter promised.
const fw = puttRoll(SURF_FAIRWAY, 20), rg = puttRoll(SURF_ROUGH, 20);
eq(fw < 19 && fw > 5, true, 'a fairway putt falls short of the asked distance');
eq(rg < fw, true, 'and one from the rough falls shorter still');
eq(rg > .5, true, 'but a rough putt still moves');
for (const surf of [SURF_GREEN, SURF_FAIRWAY, SURF_ROUGH, SURF_BUNKER])
    eq(puttRoll(surf, 20) < 21, true, 'a putt never outruns its asked distance on surface ' + surf);

// ---- hideTrees: props close to the ball leave BOTH the picture and the
// collision set (a hidden tree used to still block the ball), and the set
// is rebuilt from scratch each shot so they come back.
// H.near is everything the ball can hit: the EVEN kinds, trees (k=0) and
// bushes (k=2). The odd kinds are scenery - k=1 the far forest, k=3 the
// wildflowers. A bush is a low tree; a flower is a lower one. ----
genHole(1113, 0, CLASSIC_HOLES[0]);
const hittable = (t)=> !(t.k & 1);
const allNear = H.trees.filter(hittable).length;
const victim = H.trees.find(hittable);
ball.x = victim.x + 4; ball.z = victim.z; ball.y = 0;
hideTrees();
eq(H.near.includes(victim), false, 'a tree beside the ball is dropped from H.near');
eq(H.near.every(t => Math.hypot(t.x-ball.x, t.z-ball.z) > 18), true, 'nothing within HIDE_R survives');
eq(H.near.length < allNear, true, 'and the set really shrank');
ball.x = victim.x + 500; ball.z = victim.z + 500;
hideTrees();
eq(H.near.length, allNear, 'moving the ball away restores every near tree');
// Wildflowers are scenery and must NEVER be collidable: they are scattered
// through the rough, where the ball actually lands, so a collidable one
// would be an invisible wall in play (bushes moved difficulty +2.2 when
// they gained collision, and they are far bigger and far fewer).
const flowers = H.trees.filter(t => t.k == 3);
eq(flowers.length > 0, true, 'hole 1 scatters wildflowers');
eq(H.near.some(t => t.k == 3), false, 'no wildflower is ever in the collision set');
eq(flowers.every(t => t.s < .4), true, 'and they stay small enough to read as flowers');

// ---- SPIN HOLDS THE CARRY AND TRADES THE ROLL. All three land in much the
// same place; what differs is the arc getting there and the run afterwards.
// Spin is a launch-angle change (SPIN_LOFT), and launchVel solves velocity
// from the angle to hit the club's stated carry, so equal carries are the
// mechanism working rather than a coincidence to be tolerated. Backspin
// used to fly 13.6% further than no spin, which made it a free upgrade ----
genHole(1113, 0, CLASSIC_HOLES[0]);
H.wind.s = 0;
{
    const realNear = H.near, realGround = groundAt, realHeight = heightAt;
    H.near = [];                                  // flat fairway, no trees
    groundAt = ()=> ({h: 0, s: SURF_FAIRWAY});
    heightAt = ()=> 0;
    const shot = (spin)=>
    {
        ball.x = ball.z = ball.y = 0;
        launchBall(0, 1, 0, spin, 0, 1);          // driver, full, perfect
        let carry = 0, apex = 0;
        for (let i=0; i<3000 && !ballEvent; ++i)
        {
            ballUpdate();
            if (ballAir) apex = Math.max(apex, ball.y);
            // TRUE first touchdown. NOT `!ballAir`: that only clears once the
            // ball has finished BOUNCING, which is a different number and 45yd
            // further out on a driver. Reading it as carry is what hid a 13.6%
            // backspin advantage behind an apparent 0.2%.
            if (bounces && !carry) carry = ball.z;
        }
        ballEvent = 0;
        return {carry, apex, total: ball.z, run: ball.z - carry};
    };
    const back = shot(-1), flat = shot(0), top = shot(1);
    H.near = realNear; groundAt = realGround; heightAt = realHeight;
    // BACKSPIN lands where a normal shot lands - the loft change holds the
    // carry on its own. TOPSPIN gives carry up on purpose (a 6% power cut in
    // launchBall) so that its roll is bought rather than handed to it.
    // 6%, not 3%: with real drag and lift the loft change no longer holds
    // the carry exactly - backspin measures -3.8% on a driver - and spin
    // costing a little carry is honest. What must not come back is backspin
    // being LONGER, which is what made it a free upgrade.
    eq(Math.abs(back.carry/flat.carry - 1) < .06, true,
        'backspin lands about where no spin lands: carry within 6%');
    eq(back.carry < flat.carry, true, 'and never further: backspin is not a free upgrade');
    eq(top.carry < flat.carry*.97, true, 'topspin gives up carry for its roll');
    eq(back.apex > flat.apex && flat.apex > top.apex, true,
        'backspin flies the highest arc, topspin the flattest');
    eq(back.run < flat.run && flat.run < top.run, true,
        'backspin stops fastest, topspin runs out furthest');
    // Topspin is now the longest in TOTAL, which is the design (and real
    // golf): it buys roll and pays by not being able to stop. The bound just
    // catches a retune running away with it.
    const spread = Math.max(back.total, flat.total, top.total)/Math.min(back.total, flat.total, top.total);
    eq(spread < 1.25, true, 'the roll advantage stays bounded: totals within 25%');
}

// ---- autoClub must not hand you a club that cannot reach: off the green
// the putter's range is 120/friction (20yd on fairway), but it used to be
// picked for anything inside 26yd ----
genHole(1113, 0, CLASSIC_HOLES[0]);
{
    const realGround = groundAt;
    groundAt = ()=> ({h: 0, s: SURF_FAIRWAY});
    ball.x = H.pin.x + 23; ball.z = H.pin.z; ball.y = 0;
    eq(autoClub() != CLUB_PUTTER, true, 'a 23yd shot from the fairway is not a putt (the putter only reaches 20)');
    ball.x = H.pin.x + 12;
    eq(autoClub(), CLUB_PUTTER, 'but a 12yd bump-and-run still is');
    groundAt = realGround;
}

// ---- a ball resting against a trunk must be able to leave. It used to be
// trapped: the collision fires on the first step of every shot, kills the
// speed and drops it back, so the bot creeped 0.2yd a stroke to the mercy
// cap. Only a ball moving INTO a tree is stopped now ----
genHole(1113, 0, CLASSIC_HOLES[0]);
H.wind.s = 0;
{
    const realGround = groundAt, realHeight = heightAt;
    groundAt = ()=> ({h: 0, s: SURF_FAIRWAY});
    heightAt = ()=> 0;
    const tree = {x: 0, z: 0, s: 2.64, k: 0, y: 0};
    H.near = [tree];
    ball.x = ball.z = ball.y = 0;              // dead inside the trunk
    // CLUB_PUTTER-1 is the SW: an index that survives a club being added
    // to the bag, which 8 did not - the 13 iron shifted it to the PW and
    // the extra 30yd of carry sailed straight past this check.
    launchBall(CLUB_PUTTER-1, 1, 0, 0, 0, 1);  // SW straight down z
    for (let i=0; i<900 && !ballEvent; ++i) ballUpdate();
    ballEvent = 0;
    const escaped = Math.hypot(ball.x, ball.z);
    // And a ball flying INTO the same tree is still stopped by it. SIX yards
    // back with a driver, not 40 with a wedge: since drag and lift went in, a
    // wedge from 40 flies clean over a canopy centred at ground level and
    // rolls past, so the old case tested nothing. Six yards is inside the
    // climb, where the ball is still at canopy height.
    ball.x = 0; ball.z = -6; ball.y = 0;
    launchBall(0, 1, 0, 0, 0, 1);
    for (let i=0; i<900 && !ballEvent; ++i) ballUpdate();
    ballEvent = 0;
    const blocked = ball.z + 6;
    groundAt = realGround; heightAt = realHeight;
    eq(escaped > 30, true, 'a ball resting in a trunk escapes on the next shot');
    eq(blocked < 45, true, 'but a ball flying into that tree is still stopped');
}

// ---- a ball that comes DOWN in the cup is holed whatever its speed. The
// rolling test has a speed limit a shot in flight can never meet, so
// without this a hole in one is impossible.
// pinOut is forced: this is about the CUP, and with the flagstick in, the
// post deflects the ball before it ever gets there. The old .81yd aerial
// cup was wide enough to catch it anyway, which hid the confound. ----
genHole(1113, 0, CLASSIC_HOLES[0]);
{
    const realGround = groundAt, realHeight = heightAt, realNear = H.near;
    groundAt = ()=> ({h: 0, s: SURF_GREEN});
    heightAt = ()=> 0;
    H.near = [];
    const realPinOut = pinOut;
    pinOut = 1;
    ball.x = H.pin.x; ball.z = H.pin.z - .3; ball.y = .5;
    ball.vx = 0; ball.vy = -10; ball.vz = 10;   // dropping onto the cup, fast
    ballAir = 1; ballRolling = 0; bounces = 0; ballEvent = 0;
    for (let i=0; i<120 && !ballEvent; ++i) ballUpdate();
    const ev = ballEvent;
    ballEvent = 0; ballAir = ballRolling = 0;
    groundAt = realGround; heightAt = realHeight; H.near = realNear;
    pinOut = realPinOut;
    eq(ev, EV_HOLED, 'a fast ball landing in the cup is holed (a hole in one can happen)');
}

// ---- the cup is wider to a ball dropping in than to one rolling across:
// a chip or a bounce landing on the rim can drop, where a putt skidding
// over the same spot would not ----
genHole(1113, 0, CLASSIC_HOLES[0]);
{
    const realGround = groundAt, realHeight = heightAt, realNear = H.near;
    groundAt = ()=> ({h: 0, s: SURF_GREEN});
    heightAt = ()=> 0;
    H.near = [];
    const rim = (HOLE_R + AIR_HOLE)/2;      // outside the rolling cup, inside the air one
    // dropping onto the rim: in
    ball.x = H.pin.x + rim; ball.z = H.pin.z; ball.y = .5;
    ball.vx = 0; ball.vy = -10; ball.vz = 0;
    ballAir = 1; ballRolling = 0; bounces = 0; ballEvent = 0;
    for (let i=0; i<120 && !ballEvent; ++i) ballUpdate();
    const air = ballEvent;
    // rolling gently across the same spot: not in
    ballEvent = 0; ballAir = 0;
    ball.x = H.pin.x + rim; ball.z = H.pin.z - 2; ball.y = 0;
    ball.vx = 0; ball.vy = 0; ball.vz = 2;
    ballRolling = 1;
    for (let i=0; i<120 && !ballEvent; ++i) ballUpdate();
    const roll = ballEvent;
    ballEvent = 0; ballAir = ballRolling = 0;
    groundAt = realGround; heightAt = realHeight; H.near = realNear;
    eq(air, EV_HOLED, 'a ball dropping onto the rim is holed');
    eq(roll, EV_STOPPED, 'the same spot rolled over is not');
}

// ---- the landing prediction must work from a bunker. groundAt drops .5yd
// inside one (the scoop) but the flight loop ends against heightAt, so a
// ball started at groundAt+.1 was already "below ground" on step one and
// the ring stuck to the ball ----
genHole(1113, 0, CLASSIC_HOLES[0]);
{
    const realGround = groundAt, realHeight = heightAt, realNear = H.near;
    groundAt = ()=> ({h: -.5, s: SURF_BUNKER});   // a scooped bunker at height 0
    heightAt = ()=> 0;
    H.near = [];
    H.wind.s = 0;
    ball.x = ball.z = 0; ball.y = -.5;
    const p = predictLanding(8, 0, 0, SURF_PHYS[SURF_BUNKER][3]);
    groundAt = realGround; heightAt = realHeight; H.near = realNear;
    eq(Math.hypot(p.x-ball.x, p.z-ball.z) > 20, true, 'a sand shot is predicted to fly, not to land on the ball');
}

// ---- the predicted landing must slide smoothly as the aim turns. It used
// to stop at the END of whichever step first went under the ground, and a
// step is over half a yard at landing speed, so the ring snapped whenever
// the step count changed ----
genHole(1113, 0, CLASSIC_HOLES[0]);
H.wind.s = 0;
ball.x = ball.z = 0; ball.y = groundAt(0, 0).h;
{
    // .003 rad is the aim's real turn rate, so this is what the eye sees
    let maxJump = 0, sum = 0, n = 0, prev = 0;
    for (let i = 0; i <= 60; ++i)
    {
        const p = predictLanding(0, i*.003, 0, 1);
        if (prev)
        {
            const j = Math.hypot(p.x-prev.x, p.z-prev.z);
            maxJump = Math.max(maxJump, j); sum += j; ++n;
        }
        prev = p;
    }
    // the worst frame must not far outrun the average one: it used to be
    // twice it, which is the snap
    eq(maxJump < sum/n*1.25, true, 'the landing point slides evenly as the aim turns (no step snapping)');
}

///////////////////////////////////////////////////////////////////////////////
// Shader effect bands. The vertex shader picks effects off the ALPHA channel,
// which is a contract split across two files that cannot see each other: the
// alpha at the push site here, and a threshold inside a shader STRING in
// glRender.js. Nothing but these checks keeps them agreeing.
//
//     (.995, 1.)  water   - vertical swell + white glint
//     (.9, .995)  foliage - lateral rustle, amplitude = (a-.9)*3
//      1.0 exactly        - opaque, MUST match neither
//
// Alpha is RGBA8, so every value is an exact multiple of 1/255; the bands are
// compared after that quantisation, which is what the GPU actually sees.
const bandOf = (a)=>
{
    const q = Math.round(a*255)/255;   // what packColor stores
    return q >= 1 ? 'opaque' : q > .995 ? 'water' : q > .9 ? 'foliage' : 'none';
};

// the two markers the game actually emits. The foliage expression MIRRORS
// pushTreeGL's leaf.a line - it had drifted out of sync once and passed
// vacuously; keep them identical or this check pins nothing.
eq(bandOf(.997), 'water', 'water marker (groundColor) lands in the water band');
for (let wind=0; wind<=20; ++wind)
    eq(bandOf(.92 + Math.min(wind/12, 1)*.07), 'foliage',
        `foliage marker stays in its band at wind ${wind}`);

// opaque geometry - trunks, terrain, pin, ball - must match NOTHING. This is
// the p61 bug: alpha 1 fell through the water test into the foliage branch
// and every solid vertex in the game swayed.
eq(bandOf(1), 'opaque', 'fully opaque geometry matches no effect band');

// every alpha the dynamic batch emits must stay clear of both bands
for (const a of [.1, .3, .35, .5, .55, .7, .75, .8])
    eq(bandOf(a), 'none', `dynamic-batch alpha ${a} claims no effect band`);

// ---- the swing meter. Phase 1 offers every power twice, climbing and
// falling, and BOTH give the same sweep: it starts at the power mark and
// only ever falls, so the cursor never reverses under the player and the
// reaction time is a pure function of the power chosen. Making the falling
// click bounce off the top was tried on 2026-08-30 and reverted the same
// day (Frank: "it feels a little bit weird"), so these cases exist to stop
// it coming back by accident. ----
const swing = (target, onWayDown)=>
{
    meterStart();
    for (let f = 0; f < 600; ++f)
        if (meterUpdate(onWayDown ? meterT > 1 && meterPos() <= target
                                  : meterPos() >= target, 0) == MET_POWER) break;
    const power = meterPower;
    let prev = meterPos(), peak = prev, rose = 0, frames = 0;
    for (; frames < 900; ++frames)
    {
        const done = meterUpdate(0, 0) == MET_SWING;
        rose |= meterPos() > prev + 1e-9;
        peak = Math.max(peak, prev = meterPos());
        if (done) break;
    }
    return {power, peak, rose, secs: frames/60, impact: meterImpact};
};
const up = swing(.2, 0), down = swing(.2, 1);
eq(up.rose, 0, 'a power click on the way UP starts the sweep down at once');
eq(down.rose, 0, 'and so does one on the way DOWN - the cursor never reverses');
eq(down.peak <= down.power + 1e-9, true, 'the sweep never rises above the power mark');
// the sweep is (power + METER_OVER)*METER_DOWN_TIME however you got there,
// which is the meter's deliberate trade: less power buys less time to react
const big = swing(.9, 0);
eq(Math.abs(down.secs - up.secs) < .05, true, 'both routes to a power give the same sweep');
eq(big.secs > up.secs*2, true, 'and a bigger power buys proportionally more of it');
// the punishment for running the sweep out is unchanged either way, and a
// click during the climb is judged by where the cursor LOOKS - so the error
// range is still -METER_OVER..1 and the bounce cannot invent a worse miss
eq(up.impact.toFixed(3), (-METER_OVER).toFixed(3), 'a sweep run out is maximally late');
eq(down.impact.toFixed(3), (-METER_OVER).toFixed(3), 'on either route');
meterStart();
for (let f = 0; f < 600; ++f) if (meterUpdate(meterT > 1 && meterPos() <= .2, 0) == MET_POWER) break;
meterUpdate(0, 0); meterUpdate(0, 0);
eq(meterPos() <= 1 && meterPos() >= -METER_OVER, true, 'the cursor stays on the bar while it climbs');

// ---- the ball rolls. pushLathe gained `roll`, and `rot` became a real
// rotation about Y instead of an offset added to the lathe angle. Those are
// the SAME transform - sin(a+rot) expands to cos(rot)sin(a) + sin(rot)cos(a),
// which is what the frame rotation computes - and every other caller (trees,
// bushes, the pin, trunk boxes) relies on that, so it is pinned first. ----
const Q = Math.SQRT1_2;                       // an EXACT unit-sphere profile
const SPHERE = [[0,-1],[Q,-Q],[1,0],[Q,Q],[0,1]];
const CONE = [[0,0],[1,2]];                   // NOT Y-symmetric: rot shows on it
const latheVerts = (prof, ...args)=>
{
    glBatchCount = 0;
    pushLathe(vec3(0,0,0), prof, 8, WHITE, ...args);
    const out = [];
    for (let i = 0; i < glBatchCount; ++i)
    {
        const o = 5*(glBase + i); // glPushVerts writes behind glBase
        out.push([glVertexData[o], glVertexData[o+1], glVertexData[o+2]]);
    }
    return out;
};
const same = (a, b)=> a.length == b.length
    && a.every((p, i)=> Math.hypot(p[0]-b[i][0], p[1]-b[i][1], p[2]-b[i][2]) < 1e-6);
// the old form, written out: the angle carried rot and nothing else moved
const oldForm = (prof, rot)=>
{
    const out = [];
    for (let i = 0; i+1 < prof.length; ++i)
    for (let j = 0; j < 8; ++j)
    {
        const pts = [];
        for (const [r, h] of [prof[i], prof[i], prof[i+1], prof[i+1]]) pts.push([r, h]);
        const as = [j/8*2*Math.PI + rot, (j+1)/8*2*Math.PI + rot];
        const q = (r, h, a)=> [Math.sin(a)*r, h, Math.cos(a)*r];
        const strip = [q(prof[i][0],prof[i][1],as[0]), q(prof[i][0],prof[i][1],as[1]),
                       q(prof[i+1][0],prof[i+1][1],as[0]), q(prof[i+1][0],prof[i+1][1],as[1])];
        out.push(strip[0], ...strip, strip[3]);   // glPushVerts caps both ends
    }
    return out;
};
eq(latheVerts(CONE).length > 0, true, 'the lathe emits vertices at all');
for (const rot of [0, .4, 2.7, -1.3])
    eq(same(latheVerts(CONE, rot), oldForm(CONE, rot)), true,
        `rot ${rot} on a cone still matches the old sin(a+rot) form exactly`);
eq(same(latheVerts(CONE, .4), latheVerts(CONE, .4, 0)), true, 'omitting roll matches passing zero');
// the roll is a ROTATION, so however it is rolled every vertex stays on the
// sphere - it can never squash the ball or drift it off its position. 1e-6,
// not tighter: glVertexData is a Float32Array, so an exact rotation still
// reads back about 1e-7 off.
for (const [rot, roll] of [[0,.7], [1.1,2.4], [-3,-5]])
    eq(latheVerts(SPHERE, rot, roll).every(p => Math.abs(Math.hypot(p[0],p[1],p[2]) - 1) < 1e-6),
        true, `rot ${rot} roll ${roll} keeps every vertex on the sphere`);
// and it rolls the RIGHT WAY: travelling toward +z (rot 0), the top of the
// ball must move toward +z, not away from it
const top = (roll)=> latheVerts(SPHERE, 0, roll).reduce((b, p)=> p[1] > b[1] ? p : b, [0,-9,0]);
eq(top(.3)[2] > .05, true, 'rolling forward carries the top of the ball forward');
eq(top(0)[2] < 1e-6 && top(0)[1] > .99, true, 'and at rest the pole is straight up');

// ---- WHAT YOU SEE IS WHAT YOU GET. A frame is drawn at the END of a fixed
// update, so the cursor the player reacts to is meterPos() as it stood then,
// and the click reaches meterUpdate on the NEXT one. meterUpdate therefore
// reads the click BEFORE moving the cursor. It used to move first: a step is
// DT/METER_DOWN_TIME = .0208, wider than the sweet spot's half-width, so
// clicking dead centre of the painted band scored .0208 late and the band's
// whole lower half could not produce a perfect strike at all. ----
let mismatch = 0, perfectSeen = 0, powersWithNoPerfect = 0;
for (let p = 4; p < 60; ++p)          // a spread of powers, off the step grid
{
    meterStart();
    for (let f = 0; f < 300 && meterPhase == 1; ++f) meterUpdate(f == p, 0);
    if (meterPhase != 2) continue;    // that power cancelled; not this test
    let anyPerfect = 0;
    for (let click = 0; click < 80; ++click)
    {
        // replay the same sweep, clicking on frame `click`
        meterPhase = 2; meterT = meterPower;
        let seen = meterPos();
        for (let f = 0; f < 200; ++f)
        {
            seen = meterPos();        // the frame the player is looking at
            if (meterUpdate(f == click, 0) == MET_SWING) break;
        }
        if (Math.abs(meterImpact - seen) > 1e-9) ++mismatch;
        if (Math.abs(meterImpact) < .02) { ++perfectSeen; anyPerfect = 1; }
    }
    anyPerfect || ++powersWithNoPerfect;
}
eq(mismatch, 0, 'the impact recorded is exactly the cursor position last drawn');
eq(perfectSeen > 0, true, 'and a perfect strike is reachable');
eq(powersWithNoPerfect, 0, 'from every power, not just lucky ones');

// ---- SMACKING A HILL MUST COST DISTANCE, NOT ADD IT. The climbing-slope
// reflection used to preserve the whole tangential velocity and did not
// count as a bounce, so a flat topspin drive banked off a 31-degree face
// 25yd short of its carry, popped 5yd into the air and finished PAST its
// flat-ground total (281 vs 276yd) - with the x1.7 first-bounce topspin
// keep STILL unspent for the eventual landing. That is the shot Frank hit.
// A hill smack is a bounce: it scrubs with the surface keep and spends the
// first-bounce spin bite like any other. ----
genHole(1113, 0, CLASSIC_HOLES[0]);
{
    const realH = heightAt, realG = groundAt, realNear = H.near, realWind = H.wind;
    H.near = []; H.wind = {a: 0, s: 0};
    // faceZ 0 = flat everywhere; else a 60% face rising 30yd from z = faceZ
    const drive = (faceZ)=>
    {
        heightAt = (x, z)=> faceZ ? clamp((z - faceZ)*.6, 0, 30) : 0;
        groundAt = (x, z)=> ({h: heightAt(x, z), s: SURF_FAIRWAY});
        ball.x = ball.z = 0; ball.y = 0;
        launchBall(0, 1, 0, 1, 0, 1);           // driver, full power, topspin
        let contact = 0, pop = 0;
        for (let i = 0; i < 6000 && ballEvent != EV_STOPPED; ++i)
        {
            ballUpdate();
            const h = heightAt(ball.x, ball.z);
            if (!contact && ball.y <= h + 1e-9) contact = ball.z;
            if (contact) pop = Math.max(pop, ball.y - h);
        }
        const total = ball.z;
        ballEvent = 0; ballAir = ballRolling = 0;
        return {contact, pop, total};
    };
    const flat = drive(0);
    const hill = drive(flat.contact - 25);      // steep face 25yd short of the carry
    heightAt = realH; groundAt = realG; H.near = realNear; H.wind = realWind;
    eq(hill.total < flat.total, true,
        'a topspin drive into a hill face finishes short of the same drive on flat ground');
    eq(hill.pop < flat.pop + 3, true,
        'and the face does not launch it higher than a flat-ground bounce would');
}
meterPhase = 0;
