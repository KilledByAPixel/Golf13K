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

// ---- GL: packed lit colors and the lathe primitive ----
// White lit by a +z normal, derived from the live lighting constants so a
// retune passes and a broken packColor still fails
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
// ---- non-uniform grid: MESH_CELL cells inside, growing steps outside, sorted ----
const ax = gridAxis(0, 40);
eq(ax[12], 0, '12 coarse steps precede the fine range');
eq(ax[13] - ax[12], MESH_CELL, 'fine cells are MESH_CELL wide');
eq(ax.every((v, i)=> !i || v > ax[i-1]), true, 'axis is strictly increasing');
eq(ax[ax.length-1] > 500, true, 'the axis reaches past 500yd beyond the corridor');

// ---- REMIX is the classic course RE-DEALT: the same 18 rows shuffled by
// the course seed. The shuffle must be a true permutation and DETERMINISTIC
// from the seed, since a continued remix round must deal the same order ----
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
// water 1 IS the island rule now: classic deals one island per par
eq(CLASSIC_HOLES.map((r, i)=> r[5] == 1 ? i+1 : 0).filter(h => h).join(),
    '3,8,12', 'classic keeps its island greens on holes 3, 8 and 12');

// ---- forests and bushes ----
forestMul = 1;
genHole(1113, 0, CLASSIC_HOLES[0]);
const kinds = [0,0,0];
for (const t of hole.trees) ++kinds[t.k];
eq(kinds[0] > 40, true, 'the hole keeps its framing trees (+ the near forest)');
eq(kinds[1] > 200, true, 'a periphery forest exists');
eq(kinds[2] > 15, true, 'bushes line the corridor');
eq(hole.trees.every(t => t.k != 1 || distToPath(t.x, t.z) > 75), true, 'forest trees stay off the playable corridor');
forestMul = 0;
genHole(1113, 0, CLASSIC_HOLES[0]);
eq(hole.trees.filter(t => t.k == 1).length, 0, 'forestMul 0 disables the forest');
forestMul = 1;

// ---- the ball never goes under the height field: a climbing ball reflects
// off the slope instead of tunnelling into the hill ----
genHole(1113, 12, CLASSIC_HOLES[12]); // hilly back-nine hole
let under = 0;
for (let i=0; i<24; ++i)
{
    ball.x = hole.path[0].x; ball.z = hole.path[0].z; ball.y = groundAt(ball.x, ball.z).h;
    // i % CLUB_PUTTER = every club that flies, whatever the bag holds
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

// ---- the aim ring must not collapse at the player's feet when they aim up
// a slope: ballUpdate only LANDS a descending ball, and clipping a rise on
// the way up reflects off it, so predictLanding must do the same ----
{
    genHole(1113, 0, CLASSIC_HOLES[0]);
    const realH = heightAt, realG = groundAt;
    hole.near = []; hole.wind = {a: 0, s: 0};
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
// that was NOT going in: the cup is settled first. cupHit sweeps the step's
// whole PATH, since at flight speed a step is most of a yard ----
{
    genHole(1113, 0, CLASSIC_HOLES[0]);
    const realH = heightAt, realG = groundAt;
    hole.near = []; hole.wind = {a: 0, s: 0};
    heightAt = ()=> 0;
    groundAt = ()=> ({h: 0, s: SURF_GREEN});
    // fly a ball through the pin's airspace, offset sideways by 'off'
    const clip = (off)=>
    {
        ball.x = hole.pin.x - 1; ball.z = hole.pin.z + off; ball.y = 1.5;
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
    // ONE strike per shot, latched in shotBegin: the ball tunnels through the
    // post, reflects and crosses back next step, so the dot-product guard
    // alone cannot stop repeat hits. Counted as sign flips in vx.
    const strikes = (sp)=>
    {
        ball.x = hole.pin.x - 3; ball.z = hole.pin.z; ball.y = 1;
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
    ball.x = hole.pin.x; ball.z = hole.pin.z - 5; ball.y = 0;
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
// A PUTT TAKES THE SAME THREE CLICKS: meterUpdate has no putt case, and this
// pins that one does not creep back in.
meterStart();
for (let i=0; i<30; ++i) meterUpdate(0);
eq(meterUpdate(1), MET_POWER, 'a putt takes the power click, not the swing');
eq(meterPhase, 2, 'and goes on to the accuracy sweep like every other club');
for (let i=0; i<300 && meterPhase == 2; ++i) meterUpdate(0);
eq(meterImpact.toFixed(3), (-METER_OVER).toFixed(3), 'a putt sweep run out is maximally late');
meterPhase = 0;

// ---- meshHeightAt: props sit on the DRAWN terrain, since the coarse
// periphery cells cut chords through the analytic hills and a prop would float ----
genHole(1113, 0, CLASSIC_HOLES[0]);
buildGrid();
// pushTerrain fills meshH from its per-vertex groundAt and needs a GL context,
// so fill the grid the same way; under test is meshHeightAt's interpolation
meshH = meshZs.map(z => meshXs.map(x => groundAt(x, z).h));
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
    hole.near = near;
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

// A BUSH IS A LOW TREE: same sphere, same code path, shorter trunk - low
// enough that a driver clears it, high enough to matter near the ground.
eq(trunkH({s: 2, k: 2}) < trunkH({s: 2, k: 0}), true, 'a bush canopy sits below a tree canopy');
eq(shot([prop(30, 2, 2)]) > 200, true, 'a driver flies clean over a bush 30yd out');

// ---- the TRUNK sweeps the step path like the pin post: at 60yd/s a step
// is a whole yard, so a position-only test lets a liner through. These
// samples STRADDLE the trunk (z 10, 11 against 10.5), so only a sweep hits ----
{
    const realH = heightAt, realG = groundAt, realNear = hole.near, realWind = hole.wind;
    heightAt = ()=> 0; groundAt = ()=> ({h: 0, s: SURF_FAIRWAY});
    hole.wind = {a: 0, s: 0};
    // canopy centre 5yd up: a ball at y~1 is in trunk territory (dy < 0)
    hole.near = [{x: 0, z: 10.5, s: 1, k: 0, y: 5}];
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
    heightAt = realH; groundAt = realG; hole.near = realNear; hole.wind = realWind;
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
// tree must NOT flag a hit (or the tree sound fires 60x a second in aim) ----
hole.near = [{x: 0, z: 30, s: 2.5, k: 0, y: groundAt(0, 30).h}];
ball.x = ball.z = 0; ball.y = groundAt(0, 0).h; treeHit = 0;
const pTree = predictLanding(0, 0, 0, 1);
eq(treeHit, 0, 'predicting a flight into a tree does not flag a hit');
eq(Math.hypot(pTree.x, pTree.z) > 100, true, 'and it flies straight past: the ring ignores trees, so it cannot jump');


// ---- the DRAW ORDER is pinned: genHole spends its seeded randoms in a
// fixed sequence, and a change in their number or order silently re-rolls
// every hole. The rows are LITERALS, not CLASSIC_HOLES[n], so tuning the
// hole table cannot fail this and only genHole moving can - a failure here
// is always worth reading. On a deliberate geometry change re-pin, and check
// HOW the values moved: lengthening a hole pushes z only; x moving too means
// the R stream changed the order of its draws. ----
genHole(1113, 0, [4, .85, 34, 0, 1, 0, .5, .3]);
eq(hole.bunkers[0].x.toFixed(3) + ',' + hole.bunkers[0].z.toFixed(3), '5.391,324.790', 'the draw order still puts bunker 0 where it always was');
eq(hole.trees[5].x.toFixed(3) + ',' + hole.trees[5].z.toFixed(3), '-45.463,129.655', 'and tree 5 where it always was');
genHole(1113, 12, [4, 1.05, 22, 1, 3, .3, 1.2, 1]);
eq(hole.trees[5].x.toFixed(3) + ',' + hole.trees[5].z.toFixed(3), '50.009,322.853', 'a dogleg hole with water and hills too');

// pathPointAt itself: a prop fingerprint is a sample, not a contract (a
// wrong segment can still leave trees[5] where it was), so pin the contract
genHole(1113, 12, [4, 1.05, 22, 1, 3, .3, 1.2, 1]);
const P0 = hole.path[0], P1 = hole.path[1], mid = pathPointAt(P1.cum/2);
eq(hole.path.length, 3, 'the dogleg has two segments to get wrong');
eq(pathPointAt(0).z, P0.z, 'd 0 is the tee, not the bend');
eq(Math.hypot(mid.x - P1.x/2, mid.z - P1.z/2) < 1e-9, true, 'a point in the FIRST segment interpolates within it');
eq(pathPointAt(hole.len).z.toFixed(3), hole.green.z.toFixed(3), 'd = len is the green');
eq(pathPointAt(-50).z, P0.z, 'behind the tee clamps to the tee');
eq(pathPointAt(hole.len*2).z.toFixed(3), hole.green.z.toFixed(3), 'past the green clamps to the green');
// ---- wind: rolled per PLAY from Math.random (seeded in unit.mjs), never
// zero (an arrow pointing nowhere reads as a bug), with a real spread ----
let lo = 99, hi = 0;
for (let h=0; h<18; ++h)
{
    genHole(1113, h, CLASSIC_HOLES[h]);
    eq(hole.wind.s >= 1 && hole.wind.s <= 8, true, 'hole ' + (h+1) + ' wind is within 1..8'); // 1 + MAXWIND (course.js)
    lo = Math.min(lo, hole.wind.s); hi = Math.max(hi, hole.wind.s);
}
eq(hi - lo > 4, true, 'a round carries a real spread of wind, not one flat value');
eq(hi > 6, true, 'and at least one hole is genuinely windy');

// ---- every classic hole generates finite terrain and features: a NaN hole
// passes every "never happens" case above vacuously, since NaN compares false ----
for (let h=0; h<18; ++h)
{
    genHole(1113, h, CLASSIC_HOLES[h]);
    const ok = isFinite(heightAt(0, 0) + heightAt(hole.green.x, hole.green.z) + hole.greenH)
        && hole.bunkers.every(b => isFinite(b.x + b.z + b.rx + b.rz));
    eq(ok, true, 'hole ' + (h+1) + ' has finite terrain and bunkers');
}

// ---- WIND BITES, AND THE PREVIEW IS BLIND TO IT: the wind must move the
// real ball by yards, and the aim preview (which draws the ring and the arc)
// must NOT follow it, because reading the wind is the player's job ----
genHole(1113, 15, CLASSIC_HOLES[15]);           // hole 16: island green
// Wind is rolled per PLAY, so this case pins its own rather than hoping the
// hole rolls windy.
ball.x = ball.z = 0; ball.y = groundAt(0, 0).h;
const c16 = autoClub(), max16 = CLUBS[c16][1];
const aim16 = Math.atan2(hole.pin.x, hole.pin.z), pow16 = ballToPin()/max16;
hole.near = [];  // trees would stop the ball before the wind could show
// the REAL shot, flown to rest (or to the water this hole is ringed with)
const flyReal = ()=>
{
    ball.x = ball.z = 0; ball.y = groundAt(0, 0).h;
    ballEvent = 0;
    launchBall(c16, pow16, 0, 0, aim16, 1);
    for (let n=0; n<900 && !ballEvent; ++n) ballUpdate();
    ballEvent = 0;
    return {x: ball.x, z: ball.z};
};
// back to the tee first: predictLanding starts from wherever the ball IS,
// and flyReal has just left it downrange
const preview = ()=>
{
    ball.x = ball.z = 0; ball.y = groundAt(0, 0).h;
    return predictLanding(c16, aim16, 0, 1, pow16);
};
hole.wind = {a: 1, s: 8};
const windyReal = flyReal(), windyPred = preview();
hole.wind = {a: 1, s: 1};
const calmReal = flyReal(), calmPred = preview();
eq(Math.hypot(windyReal.x-calmReal.x, windyReal.z-calmReal.z) > 3, true,
    'the wind moves the real ball by yards');
eq(Math.hypot(windyPred.x-calmPred.x, windyPred.z-calmPred.z) < 1e-9, true,
    'and the aim preview does not follow it - still air, always');

// ---- launchPutt takes YARDS, so the meter is linear in distance: half a
// meter rolls half as far (roll goes as v^2, so a speed fraction would not) ----
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
// OFF the green a putt is measured against the GREEN's friction, so it falls
// SHORT and the player adds power; measured against the LIE it would cross
// onto the green and keep going. A putt must NEVER outrun the meter's promise.
const fw = puttRoll(SURF_FAIRWAY, 20), rg = puttRoll(SURF_ROUGH, 20);
eq(fw < 19 && fw > 5, true, 'a fairway putt falls short of the asked distance');
eq(rg < fw, true, 'and one from the rough falls shorter still');
eq(rg > .5, true, 'but a rough putt still moves');
for (const surf of [SURF_GREEN, SURF_FAIRWAY, SURF_ROUGH, SURF_BUNKER])
    eq(puttRoll(surf, 20) < 21, true, 'a putt never outruns its asked distance on surface ' + surf);

// ---- PUTTING IS THE SAME SYSTEM AS EVERY OTHER CLUB: it shares
// predictLanding (ring, chip yardage, target cam, meter scale), which only
// ROLLS it instead of flying it. These pin what the rest of the game leans on ----
genHole(1113, 0, CLASSIC_HOLES[0]);
// ON A FLAT SYNTHETIC GREEN, not hole 1's real one: these pin the PUTT
// CONTRACT (the bar's top is a target in yards and the roll delivers it), and
// a bunker behind the real green would make "10yd short" a sand shot.
const realGroundP = groundAt, realHeightP = heightAt;
groundAt = ()=> ({h: 0, s: SURF_GREEN});
heightAt = ()=> 0;
// on the green, a few yards below the cup, putting straight at it
const puttFrom = (out, power)=>
{
    ball.x = hole.pin.x; ball.z = hole.pin.z - out;
    ball.y = groundAt(ball.x, ball.z).h;
    const p = predictLanding(CLUB_PUTTER, Math.atan2(hole.pin.x-ball.x, hole.pin.z-ball.z),
        0, 1, power);
    return {stop: Math.hypot(p.x-ball.x, p.z-ball.z), p};
};
// the bar's top is a TARGET in yards, and a putt delivers it (a shade over,
// which is the pace you want - a putt dying at the cup never drops)
for (const yd of [6, 10, 16])
{
    const r = puttFrom(yd, yd/PUTT_MAX);
    eq(r.stop > yd && r.stop < yd + 1.5, true,
        `a ${yd}yd putt target rolls ${yd}yd and a touch past, not ` + r.stop.toFixed(1));
}
// half the bar is half the roll - the same linearity launchPutt has, which
// is what lets the meter be read as yards
{
    const f = puttFrom(20, 20/PUTT_MAX).stop, h = puttFrom(20, 10/PUTT_MAX).stop;
    eq(Math.abs(h - f/2) < 2, true, 'half the putt bar rolls half as far');
}
// THE PATH ENDS ON THE STOP POINT: the ring is drawn at the returned point
// and the dashed line along predPath, so they must not part company.
{
    const r = puttFrom(12, 12/PUTT_MAX);
    const end = predPath[predPath.length-1];
    eq(Math.hypot(end.x-r.p.x, end.z-r.p.z) < 1e-9, true,
        'the putt line ends exactly on the ring');
    eq(Math.abs(end.y - groundAt(end.x, end.z).h) < 1e-9, true, 'and on the ground');
    eq(predPath.length > 8, true, 'and has enough points to read as a line');
}
groundAt = realGroundP; heightAt = realHeightP;
// THE DEFAULT PUTT TARGET MUST OVERSHOOT THE CUP: with the bar topping out AT
// the cup every stroke short of perfect falls short. This pins that the cup
// lands strictly INSIDE the bar (the condition under which renderMeter draws
// its marker) with real room past it, on a FLAT SYNTHETIC GREEN.
{
    const realGround = groundAt, realHeight = heightAt;
    groundAt = ()=> ({h: 0, s: SURF_GREEN});
    heightAt = ()=> 0;
    for (const yd of [4, 8, 12, 20, 30])
    {
        ball.x = hole.pin.x; ball.z = hole.pin.z - yd;
        ball.y = 0;
        // resetTarget's putter rule, through setTarget's 5yd floor and PUTT_MAX
        const target = Math.min(Math.max(ballToPin()*PUTT_OVER, 5), PUTT_MAX);
        const p = predictLanding(CLUB_PUTTER, Math.atan2(hole.pin.x-ball.x, hole.pin.z-ball.z),
            0, 1, target/PUTT_MAX);
        const cup = ballToPin()/Math.hypot(p.x-ball.x, p.z-ball.z);
        eq(cup < .95 && cup > .4, true,
            `a ${yd}yd putt puts the cup at ` + (cup*100).toFixed(0) + '% of the bar, inside it with room');
    }
    groundAt = realGround; heightAt = realHeight;
}
eq(PUTT_OVER > 1, true, 'the putt bar always reaches past the hole');

// THE SECOND CLICK HAS TO BITE ON A PUTT. Push/pull is an ANGLE, and the .05
// the rest of the bag uses is centimetres on a ten yard putt, so PUTT_PUSH is
// the putter's own coefficient: it must bite, and stay kind to the short ones.
{
    const realGround = groundAt, realHeight = heightAt;
    groundAt = ()=> ({h: 0, s: SURF_GREEN});    // the METER, not the terrain
    heightAt = ()=> 0;
    // struck at the pace that stops it AT the cup, which is how it is played
    const puttAt = (out, impact)=>
    {
        ball.x = hole.pin.x; ball.z = hole.pin.z - out; ball.y = 0;
        ball.vx = ball.vy = ball.vz = 0;
        ballEvent = 0;
        launchBall(CLUB_PUTTER, ballToPin()/PUTT_MAX, impact, 0,
            Math.atan2(hole.pin.x-ball.x, hole.pin.z-ball.z), 1);
        for (let i=0; i<900 && !ballEvent; ++i) ballUpdate();
        const holed = ballEvent == EV_HOLED;
        ballEvent = 0;
        return holed;
    };
    // the curve, short to long: tap-ins survive anything, mid putts want a
    // good stroke, long putts want a near-perfect one. Nothing unmakeable.
    eq(puttAt(2, .12), true, 'a tap-in drops even off a bad stroke');
    eq(puttAt(6, .05), true, 'a GOOD stroke drops a 6yd putt');
    eq(puttAt(6, .12), false, 'a bad one misses from the same 6yd');
    eq(puttAt(16, 0), true, 'a perfectly struck 16yd putt drops');
    eq(puttAt(16, .05), false, 'a merely GOOD one does not - long putts want the strike');
    groundAt = realGround; heightAt = realHeight;
}

// A PUTT PREDICTION SIMULATES THE LIE: the same target from the rough does
// not get there, and the chip says so. Same FLAT SYNTHETIC ground for both.
{
    const realGround = groundAt, realHeight = heightAt;
    heightAt = ()=> 0;
    groundAt = ()=> ({h: 0, s: SURF_GREEN});
    const onGreen = puttFrom(15, 15/PUTT_MAX).stop;
    ball.x = hole.pin.x; ball.z = hole.pin.z - 15;
    groundAt = ()=> ({h: 0, s: SURF_ROUGH});
    const inRough = puttFrom(15, 15/PUTT_MAX).stop;
    groundAt = realGround; heightAt = realHeight;
    eq(inRough < onGreen/2, true,
        'the same putt target from rough predicts less than half the roll');
}

// ---- hideTrees: props close to the ball leave BOTH the picture and the
// collision set, rebuilt each shot so they come back. hole.near is the EVEN
// kinds the ball can hit, trees (k=0) and bushes (k=2); the odd kinds are
// scenery, k=1 the far forest and k=3 the wildflowers ----
genHole(1113, 0, CLASSIC_HOLES[0]);
const hittable = (t)=> !(t.k & 1);
const allNear = hole.trees.filter(hittable).length;
const victim = hole.trees.find(hittable);
ball.x = victim.x + 4; ball.z = victim.z; ball.y = 0;
hideTrees();
eq(hole.near.includes(victim), false, 'a tree beside the ball is dropped from hole.near');
eq(hole.near.every(t => Math.hypot(t.x-ball.x, t.z-ball.z) > 18), true, 'nothing within HIDE_R survives');
eq(hole.near.length < allNear, true, 'and the set really shrank');
ball.x = victim.x + 500; ball.z = victim.z + 500;
hideTrees();
eq(hole.near.length, allNear, 'moving the ball away restores every near tree');
// Wildflowers are scenery and must NEVER be collidable: they are scattered
// through the rough, where the ball lands, so one would be an invisible wall.
const flowers = hole.trees.filter(t => t.k == 3);
eq(flowers.length > 0, true, 'hole 1 scatters wildflowers');
eq(hole.near.some(t => t.k == 3), false, 'no wildflower is ever in the collision set');
eq(flowers.every(t => t.s < .4), true, 'and they stay small enough to read as flowers');

// ---- SPIN HOLDS THE CARRY AND TRADES THE ROLL: spin is a launch-angle
// change (SPIN_LOFT) and launchVel solves velocity to hit the stated carry,
// so all three land together. Backspin flying FURTHER would be a free upgrade ----
genHole(1113, 0, CLASSIC_HOLES[0]);
hole.wind.s = 0;
{
    const realNear = hole.near, realGround = groundAt, realHeight = heightAt;
    hole.near = [];                                  // flat fairway, no trees
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
            // TRUE first touchdown, NOT `!ballAir`: that only clears once the
            // ball has finished BOUNCING, 45yd further out on a driver
            if (bounces && !carry) carry = ball.z;
        }
        ballEvent = 0;
        return {carry, apex, total: ball.z, run: ball.z - carry};
    };
    const back = shot(-1), flat = shot(0), top = shot(1);
    hole.near = realNear; groundAt = realGround; heightAt = realHeight;
    // BACKSPIN lands about where no spin lands (drag and lift cost it ~4% on
    // a driver, which is honest); TOPSPIN gives carry up on purpose (a 6%
    // power cut in launchBall) so its roll is bought. Backspin is never LONGER.
    eq(Math.abs(back.carry/flat.carry - 1) < .06, true,
        'backspin lands about where no spin lands: carry within 6%');
    eq(back.carry < flat.carry, true, 'and never further: backspin is not a free upgrade');
    eq(top.carry < flat.carry*.97, true, 'topspin gives up carry for its roll');
    eq(back.apex > flat.apex && flat.apex > top.apex, true,
        'backspin flies the highest arc, topspin the flattest');
    eq(back.run < flat.run && flat.run < top.run, true,
        'backspin stops fastest, topspin runs out furthest');
    // Topspin is the longest in TOTAL by design: it buys roll and pays by not
    // stopping. The bound catches a retune running away with it.
    const spread = Math.max(back.total, flat.total, top.total)/Math.min(back.total, flat.total, top.total);
    eq(spread < 1.25, true, 'the roll advantage stays bounded: totals within 25%');
}

// ---- autoClub must not hand you a club that cannot reach: off the green
// the putter's range is 120/friction (20yd on fairway) ----
genHole(1113, 0, CLASSIC_HOLES[0]);
{
    const realGround = groundAt;
    groundAt = ()=> ({h: 0, s: SURF_FAIRWAY});
    ball.x = hole.pin.x + 23; ball.z = hole.pin.z; ball.y = 0;
    eq(autoClub() != CLUB_PUTTER, true, 'a 23yd shot from the fairway is not a putt (the putter only reaches 20)');
    ball.x = hole.pin.x + 12;
    eq(autoClub(), CLUB_PUTTER, 'but a 12yd bump-and-run still is');
    groundAt = realGround;
}

// ---- a ball resting against a trunk must be able to leave: only a ball
// moving INTO a tree is stopped, or every shot dies on its first step ----
genHole(1113, 0, CLASSIC_HOLES[0]);
hole.wind.s = 0;
{
    const realGround = groundAt, realHeight = heightAt;
    groundAt = ()=> ({h: 0, s: SURF_FAIRWAY});
    heightAt = ()=> 0;
    const tree = {x: 0, z: 0, s: 2.64, k: 0, y: 0};
    hole.near = [tree];
    ball.x = ball.z = ball.y = 0;              // dead inside the trunk
    // CLUB_PUTTER-1 is the SW: an index that survives a club being added
    // to the bag
    launchBall(CLUB_PUTTER-1, 1, 0, 0, 0, 1);  // SW straight down z
    for (let i=0; i<900 && !ballEvent; ++i) ballUpdate();
    ballEvent = 0;
    const escaped = Math.hypot(ball.x, ball.z);
    // And a ball flying INTO the same tree is still stopped. SIX yards back
    // with a driver: inside the climb, where the ball is still at canopy height.
    ball.x = 0; ball.z = -6; ball.y = 0;
    launchBall(0, 1, 0, 0, 0, 1);
    for (let i=0; i<900 && !ballEvent; ++i) ballUpdate();
    ballEvent = 0;
    const blocked = ball.z + 6;
    groundAt = realGround; heightAt = realHeight;
    eq(escaped > 30, true, 'a ball resting in a trunk escapes on the next shot');
    eq(blocked < 45, true, 'but a ball flying into that tree is still stopped');
}

// ---- a ball that comes DOWN in the cup is holed whatever its speed, or a
// hole in one is impossible (the rolling test has a speed limit a shot in
// flight never meets). pinOut is forced: with the stick in, the post deflects ----
genHole(1113, 0, CLASSIC_HOLES[0]);
{
    const realGround = groundAt, realHeight = heightAt, realNear = hole.near;
    groundAt = ()=> ({h: 0, s: SURF_GREEN});
    heightAt = ()=> 0;
    hole.near = [];
    const realPinOut = pinOut;
    pinOut = 1;
    ball.x = hole.pin.x; ball.z = hole.pin.z - .3; ball.y = .5;
    ball.vx = 0; ball.vy = -10; ball.vz = 10;   // dropping onto the cup, fast
    ballAir = 1; ballRolling = 0; bounces = 0; ballEvent = 0;
    for (let i=0; i<120 && !ballEvent; ++i) ballUpdate();
    const ev = ballEvent;
    ballEvent = 0; ballAir = ballRolling = 0;
    groundAt = realGround; heightAt = realHeight; hole.near = realNear;
    pinOut = realPinOut;
    eq(ev, EV_HOLED, 'a fast ball landing in the cup is holed (a hole in one can happen)');
}

// ---- the cup is wider to a ball dropping in than to one rolling across: a
// chip landing on the rim can drop where a putt skidding over it would not ----
genHole(1113, 0, CLASSIC_HOLES[0]);
{
    const realGround = groundAt, realHeight = heightAt, realNear = hole.near;
    groundAt = ()=> ({h: 0, s: SURF_GREEN});
    heightAt = ()=> 0;
    hole.near = [];
    const rim = (HOLE_R + AIR_HOLE)/2;      // outside the rolling cup, inside the air one
    // dropping onto the rim: in
    ball.x = hole.pin.x + rim; ball.z = hole.pin.z; ball.y = .5;
    ball.vx = 0; ball.vy = -10; ball.vz = 0;
    ballAir = 1; ballRolling = 0; bounces = 0; ballEvent = 0;
    for (let i=0; i<120 && !ballEvent; ++i) ballUpdate();
    const air = ballEvent;
    // rolling gently across the same spot: not in
    ballEvent = 0; ballAir = 0;
    ball.x = hole.pin.x + rim; ball.z = hole.pin.z - 2; ball.y = 0;
    ball.vx = 0; ball.vy = 0; ball.vz = 2;
    ballRolling = 1;
    for (let i=0; i<120 && !ballEvent; ++i) ballUpdate();
    const roll = ballEvent;
    ballEvent = 0; ballAir = ballRolling = 0;
    groundAt = realGround; heightAt = realHeight; hole.near = realNear;
    eq(air, EV_HOLED, 'a ball dropping onto the rim is holed');
    eq(roll, EV_STOPPED, 'the same spot rolled over is not');
}

// ---- the landing prediction must work from a bunker: groundAt drops .5yd
// inside the scoop while the flight loop ends against heightAt, so a ball
// started at groundAt+.1 must not read as "below ground" on step one ----
genHole(1113, 0, CLASSIC_HOLES[0]);
{
    const realGround = groundAt, realHeight = heightAt, realNear = hole.near;
    groundAt = ()=> ({h: -.5, s: SURF_BUNKER});   // a scooped bunker at height 0
    heightAt = ()=> 0;
    hole.near = [];
    hole.wind.s = 0;
    ball.x = ball.z = 0; ball.y = -.5;
    const p = predictLanding(8, 0, 0, SURF_PHYS[SURF_BUNKER][3]);
    groundAt = realGround; heightAt = realHeight; hole.near = realNear;
    eq(Math.hypot(p.x-ball.x, p.z-ball.z) > 20, true, 'a sand shot is predicted to fly, not to land on the ball');
}

// ---- the predicted landing must slide smoothly as the aim turns: a step is
// over half a yard at landing speed, so ending at the END of the first step
// under ground would snap the ring whenever the step count changes ----
genHole(1113, 0, CLASSIC_HOLES[0]);
hole.wind.s = 0;
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
    // the worst frame must not far outrun the average one (twice it is the snap)
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
// pushTreeGL's leaf.a line: keep them identical or this check pins nothing.
eq(bandOf(.997), 'water', 'water marker (groundColor) lands in the water band');
for (let wind=0; wind<=8; ++wind)
    eq(bandOf(.92 + wind/8*.07), 'foliage',
        `foliage marker stays in its band at wind ${wind}`);

// opaque geometry - trunks, terrain, pin, ball - must match NOTHING: alpha 1
// falling into the foliage branch would make every solid vertex sway
eq(bandOf(1), 'opaque', 'fully opaque geometry matches no effect band');

// every alpha the dynamic batch emits must stay clear of both bands
for (const a of [.1, .3, .35, .5, .55, .7, .75, .8])
    eq(bandOf(a), 'none', `dynamic-batch alpha ${a} claims no effect band`);

// ---- the swing meter. Phase 1 offers every power twice, climbing and
// falling, and BOTH give the same sweep: it starts at the power mark and only
// ever falls, so the cursor never reverses under the player and the reaction
// time is a pure function of the power chosen ----
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
// running the sweep out is punished the same either way, and a click during
// the climb is judged by where the cursor LOOKS: the error range stays -METER_OVER..1
eq(up.impact.toFixed(3), (-METER_OVER).toFixed(3), 'a sweep run out is maximally late');
eq(down.impact.toFixed(3), (-METER_OVER).toFixed(3), 'on either route');
meterStart();
for (let f = 0; f < 600; ++f) if (meterUpdate(meterT > 1 && meterPos() <= .2, 0) == MET_POWER) break;
meterUpdate(0, 0); meterUpdate(0, 0);
eq(meterPos() <= 1 && meterPos() >= -METER_OVER, true, 'the cursor stays on the bar while it climbs');

// ---- the ball rolls. pushLathe's `rot` is a real rotation about Y, which
// must equal the plain sin(a+rot) offset form every other caller (trees,
// bushes, the pin, trunk boxes) relies on, so that is pinned first ----
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
// the offset form, written out: the angle carries rot and nothing else moves
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
// the roll is a ROTATION, so every vertex stays on the sphere - it can never
// squash the ball or drift it off its position. 1e-6, not tighter:
// glVertexData is a Float32Array, so an exact rotation reads back ~1e-7 off.
for (const [rot, roll] of [[0,.7], [1.1,2.4], [-3,-5]])
    eq(latheVerts(SPHERE, rot, roll).every(p => Math.abs(Math.hypot(p[0],p[1],p[2]) - 1) < 1e-6),
        true, `rot ${rot} roll ${roll} keeps every vertex on the sphere`);
// and it rolls the RIGHT WAY: travelling toward +z (rot 0), the top of the
// ball must move toward +z, not away from it
const top = (roll)=> latheVerts(SPHERE, 0, roll).reduce((b, p)=> p[1] > b[1] ? p : b, [0,-9,0]);
eq(top(.3)[2] > .05, true, 'rolling forward carries the top of the ball forward');
eq(top(0)[2] < 1e-6 && top(0)[1] > .99, true, 'and at rest the pole is straight up');

// ---- WHAT YOU SEE IS WHAT YOU GET: a frame is drawn at the END of a fixed
// update and the click reaches meterUpdate on the NEXT one, so meterUpdate
// reads the click BEFORE moving the cursor. A step (.0208) is wider than the
// sweet spot's half-width, so moving first would make half the band unmakeable ----
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

// ---- SMACKING A HILL MUST COST DISTANCE, NOT ADD IT: a hill smack is a
// bounce, scrubbing with the surface keep and spending the first-bounce spin
// bite, or a topspin drive banked off a face finishes PAST its flat total ----
genHole(1113, 0, CLASSIC_HOLES[0]);
{
    const realH = heightAt, realG = groundAt, realNear = hole.near, realWind = hole.wind;
    hole.near = []; hole.wind = {a: 0, s: 0};
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
    heightAt = realH; groundAt = realG; hole.near = realNear; hole.wind = realWind;
    eq(hill.total < flat.total, true,
        'a topspin drive into a hill face finishes short of the same drive on flat ground');
    eq(hill.pop < flat.pop + 3, true,
        'and the face does not launch it higher than a flat-ground bounce would');
}
meterPhase = 0;
