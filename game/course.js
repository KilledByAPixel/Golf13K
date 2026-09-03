'use strict';

/*  SUNSHINE GOLF CLASSIC - procedural course
    World units are yards. x = lateral, z = downrange from tee, y = up.
    Each hole is an analytic description (no stored grids):
    heightAt / surfaceAt / groundAt are the single source of truth for
    gameplay, the 3D swing view, and the top-down map. */

// surface types (priority order handled in surfaceAt)
// Canopy centre above ground. A bush (k=2) and a flower (k=3) are trees
// whose trunk is too short to draw - this one number is the whole difference.
const trunkH = (t)=> t.s*(t.k > 1 ? 1.2 : 3.4);
const SURF_ROUGH=0, SURF_FAIRWAY=1, SURF_GREEN=2, SURF_TEE=3,
      SURF_BUNKER=4, SURF_WATER=5, SURF_OB=6;
const SURF_NAMES = ['ROUGH','FAIRWAY','GREEN','TEE','SAND','WATER','OB'];

// The look drifts over the round like seasons: every colour is [h,s,l] at
// hole 1 and at hole 18, lerped per hole. The endpoint NUMBERS choose the
// hue path - the horizon's 378 (= 18) goes the long way round so mid-round
// is dusk, not a green sky. hsl() wraps.
const PAL =
{
    rough:[[95,45,36],[42,45,32]], fair:[[112,60,45],[85,45,40]], green:[[130,62,52],[120,55,46]],
    sand:[[47,85,74],[28,85,66]], water:[[203,80,55],[255,60,50]],
    sky0:[[207,90,70],[268,70,58]], sky1:[[168,70,86],[378,95,72]],
    tree:[[118,52,32],[15,55,32]], trunk:[[25,50,30],[-10,30,28]], sun:[[50,100,90],[0,100,60]],
    // WILDFLOWERS: only the saturation and lightness drift over the round.
    // The HUE is replaced per hole in genHole with a random one - flowers are
    // the one thing that does NOT follow the seasonal gradient, so their
    // colour pops instead of easing into the next hole's.
    flower:[[0,90,72],[0,80,68]],
};

// classic 18 hole table: [par, lenScale, fairwayW, dogleg, bunkers, water, treeDen, hills]
// dogleg: 0 none, +-(0..1) single bend strength/direction, 2 = double bend (par 5 S)
// fairwayW is the REAL width (0 = a par 3 with none). Note the hazard and
// tree offsets all measure from fw/2, so widening a hole here also pushes
// its bunkers, water and framing trees out - they sit relative to the
// fairway edge, not to the centreline.
const CLASSIC_HOLES =
[
    // [par, lenScale, fairwayW, dogleg, bunkers, water, treeDen, hills]

    // front: Meadow - wide, flat, learn the game
    [4, .90, 44,   0, 1,  0, .5, .3],
    [3, .80,  0,   0, 1,  0, .6, .3],
    [5, .80, 40,  .5, 1,  1, .7, .4],
    [4, .90, 38, -.7, 3,  0, .9, .5],
    [3,1.10,  0,   0, 2, .3, .5, .6],
    [4,1.00, 36, 1.0, 2,  0,  1, .5],
    // middle: Lake - water arrives, doglegs harden
    [5, .90, 40, -.7, 2, .8, .8, .5],
    [3, .90,  0,   0, 1,  1, .4, .4],
    [4,1.10, 34,  .9, 2, .6,  1, .6],
    [4, .95, 36, -.9, 3, .5,  1, .7],
    [5,1.00, 34,   2, 2, .7,  1, .6],
    [4,1.05, 33,   0, 3, .5, .6, .8],
    // back: Cliffs - narrow, hilly, mean
    [4,1.05, 30,   .5, 3, .3,1.2,1.2],
    [4,1.10, 28,   -1, 3, 0, 1.2, .8],
    [5,1.05, 30,   2.3,2, .5,1.0,  1],
    [3,1.10,  0,   0,  4,  1, .5,  1],
    [4,1.20, 26,   1,  4, .6,1.4,1.3],
    [5,1.10, 28,   2,  3, .8,1.4,1.2],
];

let hole;          // current generated hole
let forestMul = 1; // debug knob (?trees=K): scales the periphery forest
let noiseSeed;  // terrain noise seed for current hole
let lastAlong;  // distance along path from last distToPath call (for stripes)
let lastDist;   // and the distance to it (periphery shading)
let lastWater;  // the lake surfaceAt last returned SURF_WATER for

///////////////////////////////////////////////////////////////////////////////
// seeded value noise

function hashN(x, z)
{
    const s = Math.sin(x*127.1 + z*311.7 + noiseSeed*74.7)*43758.5453;
    return s - Math.floor(s);
}

function noise2(x, z)
{
    const xi = Math.floor(x), zi = Math.floor(z);
    const u = smoothStep(x-xi), v = smoothStep(z-zi);
    return lerp(lerp(hashN(xi,zi), hashN(xi+1,zi), u),
                lerp(hashN(xi,zi+1), hashN(xi+1,zi+1), u), v);
}

///////////////////////////////////////////////////////////////////////////////
// hole queries

// distance from point to hole centerline, sets lastAlong
function distToPath(x, z)
{
    let best = 1e9;
    const P = hole.path;
    for (let i=P.length-1; i--;)
    {
        const a = P[i], b = P[i+1];
        const bx = b.x-a.x, bz = b.z-a.z;
        const len2 = bx*bx + bz*bz;
        let t = ((x-a.x)*bx + (z-a.z)*bz) / len2;
        t = clamp(t);
        const dx = x - (a.x + bx*t), dz = z - (a.z + bz*t);
        const d = Math.hypot(dx, dz);
        if (d < best)
        {
            best = d;
            lastAlong = a.cum + Math.sqrt(len2)*t;
        }
    }
    return lastDist = best;
}

// point on centerline at distance d from tee
function pathPointAt(d)
{
    const P = hole.path;
    for (let i=P.length-1; i--;)
        if (d > P[i].cum || !i)
        {
            const a = P[i], b = P[i+1];
            const t = clamp((d - a.cum)/(b.cum - a.cum));
            return {x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t)};
        }
}

// distance to an ellipse centre in units of its radii (1 = on the edge)
const ellipseDist = (x, z, e)=> Math.hypot((x-e.x)/e.rx, (z-e.z)/e.rz);

// raw terrain height, before feature flattening
function heightRaw(x, z)
{
    return (noise2(x*.017+9, z*.017)-.5)*24*hole.hills
         + (noise2(x*.06, z*.06+7)-.5)*6*hole.hills;
}

function heightAt(x, z)
{
    let h = heightRaw(x, z);
    // periphery: the hole sits in a valley - past the OB band the ground
    // rises into hills (same distToPath query surfaceAt uses)
    const far = clamp((distToPath(x, z) - 110)/250);
    h += far*far*(18 + 50*noise2(x*.004+3, z*.004));
    // shores: terrain eases down to meet each lake so hillside water reads
    // naturally (and balls roll toward hazards - real golf cruelty)
    for (const w of hole.waters)
    {
        const nd = ellipseDist(x, z, w);
        if (nd < 1.5)
            h = lerp(h, w.h+.3, smoothStep(clamp((1.5-nd)/.5)));
    }
    // green plateau
    const dg = Math.hypot(x-hole.green.x, z-hole.green.z);
    const k = smoothStep(clamp(1 - dg/(hole.gr*2.4)));
    h = lerp(h, hole.greenH, k) + k*.7;
    // tee pad (the tee is the origin)
    const kt = smoothStep(clamp(1 - Math.hypot(x, z)/14));
    h = lerp(h, hole.teeH, kt);
    // BUNKERS SCOOP A BOWL, ramped like the shores above - and it has to
    // live HERE, in heightAt, not in groundAt. slopeAt reads heightAt and
    // nothing else, so a scoop applied later gave the ball half a yard of
    // cliff to fall down at the exact ellipse edge and no gradient at all to
    // feel on the way out: it dropped like a stair and then rolled off as if
    // the sand were flat. Every other feature here is smoothed; this was the
    // one that was not. As a bowl the sand also gathers a ball the way it
    // should, instead of merely recolouring the ground under it.
    // ...and the GREEN OUT-RANKS THE SAND, exactly as surfaceAt has it: a
    // bunker ellipse often laps over the putting surface, and without this
    // the scoop dents a green that reads as green. k is the plateau blend
    // computed above, so (1-k) fades the sand out under it for free.
    for (const b of hole.bunkers)
        h -= .5*(1-k)*smoothStep(clamp((1 - ellipseDist(x, z, b))/.3));
    return h;
}

// terrain slope [dh/dx, dh/dz] by central difference over +-e
function slopeAt(x, z, e=.5)
{
    return [(heightAt(x+e, z) - heightAt(x-e, z))/(2*e),
            (heightAt(x, z+e) - heightAt(x, z-e))/(2*e)];
}

function surfaceAt(x, z)
{
    const dp = distToPath(x, z);
    // wide playable corridor with a noise-perturbed boundary (organic, not
    // a rectangle) - deep rough band before OB
    if (dp > 62 + (noise2(x*.05, z*.05)-.5)*18)
        return SURF_OB;
    const dg = Math.hypot(x-hole.green.x, z-hole.green.z);
    if (dg < hole.gr)
        return SURF_GREEN;
    if (Math.abs(x) < 5 && Math.abs(z) < 5) // the tee is the origin
        return SURF_TEE;
    for (const b of hole.bunkers)
        if (ellipseDist(x, z, b) < 1)
            return SURF_BUNKER;
    for (const w of hole.waters)
        if (ellipseDist(x, z, w) < 1)
        {
            lastWater = w;
            return SURF_WATER;
        }
    if (hole.fw && lastAlong > 8 && lastAlong < hole.len - 2)
    {
        // fairway breathes: width swells and pinches along the hole,
        // edges wiggle so mow lines read hand-shaped
        const fwHere = hole.fw*(1 + (noise2(lastAlong*.014, hole.index*7+3)-.5)*.9);
        if (dp < fwHere/2 + (noise2(x*.09+5, z*.09)-.5)*7)
            return SURF_FAIRWAY;
    }
    return SURF_ROUGH;
}

// combined ground query: height + surface. Water is flat at its lake level
// (surfaceAt just set lastWater); the bunker scoop is in heightAt, so the
// ground here is simply the terrain.
function groundAt(x, z)
{
    const s = surfaceAt(x, z);
    return {h: s == SURF_WATER ? lastWater.h : heightAt(x, z), s};
}

///////////////////////////////////////////////////////////////////////////////
// generation

function genHole(courseSeed, index, row)
{
    const R = new RandomGenerator(courseSeed*137 + index*7919 + 1);
    const [par, lenScale, fw, dog, bunkerN, waterC, treeDen, hills] = row;
    const len = (par==3 ? 165 : par==4 ? 410 : 620)*lenScale;
    noiseSeed = R.float(1e3);

    // this hole's colours: the spring->fall lerp at index/17
    const pal = {};
    for (const k in PAL)
        pal[k] = PAL[k][0].map((v, i)=> lerp(v, PAL[k][1][i], index/17));
 
    // ...except the wildflowers, whose hue jumps around per hole instead of
    // easing along with the season, so their colour pops.
    pal.flower[0] = 30 - R.float(240);

    hole = {par, len, fw, hills, pal, index,
         path: [], bunkers: [], waters: [], trees: []};

    // centerline path with doglegs
    const P = hole.path;
    P.push({x:0, z:0, cum:0});
    const addPt = (x, z)=>
    {
        const p = P[P.length-1];
        P.push({x, z, cum: p.cum + Math.hypot(x-p.x, z-p.z)});
    }
    if (par == 3 || !dog)
        addPt(0, len);
    else if (dog == 2)
    {
        // double bend S-curve
        const a1 = R.floatSign(.3, .4), a2 = -a1*R.float(.8, 1.2);
        const z1 = len*.4, z2 = len*.8;
        addPt(0, z1);
        addPt(Math.sin(a1)*(z2-z1), z1 + Math.cos(a1)*(z2-z1));
        const p = P[2];
        addPt(p.x + Math.sin(a2)*(len-z2), p.z + Math.cos(a2)*(len-z2));
    }
    else
    {
        const bendZ = len*R.float(.4, .6);
        const a = dog*R.float(.4, .6);
        addPt(0, bendZ);
        addPt(Math.sin(a)*(len-bendZ), bendZ + Math.cos(a)*(len-bendZ));
    }

    // green on a plateau at path end
    const end = P[P.length-1];
    hole.gr = R.float(12, 20) - hills;
    hole.green = end;
    hole.greenH = heightRaw(end.x, end.z) + .5;
    hole.teeH = heightRaw(0, 0) + .3;
    const pa = R.angle();
    const pd = R.float(0, hole.gr*.5);
    hole.pin = {x: end.x + Math.sin(pa)*pd, z: end.z + Math.cos(pa)*pd};

    // WIND IS ROLLED FRESH EVERY PLAY (rand, not R), so a hole never plays
    // the same twice - and it takes NOTHING from the R stream, so wind can
    // be retuned without re-rolling the course. (The two throwaway R draws
    // that once guarded this spot are gone - there is nothing to protect.)
    // Never zero - an arrow pointing nowhere reads as a bug. MAXWIND scales
    // the WHOLE curve, not just its peak. In closed form, so this does not
    // go stale again: mean wind is 1 + MAXWIND/3, and the share of holes
    // above s is 1 - sqrt((s-1)/MAXWIND). The square law is what keeps most
    // holes gentle - drop it and half of them would be near the top.
    // A UNIT IS NOT A MPH: air velocity is `s*WIND_V` = 1.4 yd/s per unit,
    // which is 2.86 mph, and the HUD prints `s*2.86` as mph (2026-09-02 - it
    // used to print the bare unit, which is why a wind of 12 read as mild
    // and hit like a gale. Frank: "I was wondering why I had set it to
    // twelve and it seemed like a really strong wind - now that makes
    // sense"). THE LABEL WAS THE BUG, NOT THE MAGNITUDE.
    // 9 UNTIL 2026-09-02: range 1..10 = 3..29mph, mean 11mph, 31% of holes
    // over 15mph and 18% over 20. Dropping it was first rejected the same
    // day (the mean barely moves, the tail is the per-play variety), then
    // Frank reopened it on seeing the mph - "it goes a bit high for sure".
    // What decided it is the FLIGHT MODEL: the range was tuned under the
    // old flat-push wind, and wind as air velocity through real drag bites
    // nearly twice as hard per unit. MEASURED at each ceiling, full swings,
    // carry lost into it / cross drift, driver and SW:
    //   MAXWIND 9  29mph  1W -19% 40yd   SW -32% 24yd   >20mph 18% of holes
    //   MAXWIND 7  23mph  1W -14% 32yd   SW -24% 19yd   >20mph  7%   <- here
    //   MAXWIND 6  20mph  1W -13% 28yd   SW -21% 16yd   >20mph  0%
    // 7 is "a little bit" (Frank's words): mean 9.5mph, 22% of holes over
    // 15mph, and it KEEPS about one 20mph+ hole a round, which is the tail
    // he valued the first time. 6 deletes that hole entirely.
    // **glRender's leaf.a divides by the top of this range (1+MAXWIND) to
    // scale the foliage sway - change one and change the other**, or the
    // trees stay half-asleep on the windiest hole in the game.
    const MAXWIND = 7;
    hole.wind = {a: rand(PI, -PI), s: 1 + rand()**2*MAXWIND};

    // bunkers: randomly placed sand
    for (let i=bunkerN; i--;)
    {
        const a = R.angle();
        const d = hole.gr + R.float(2, 7);
        const gx = hole.green.x + Math.sin(a)*d, gz = hole.green.z + Math.cos(a)*d;
        if (!index || R.bool(.5) || par == 3 && waterC == 1)
            hole.bunkers.push({x:gx, z:gz, rx:R.float(6,20), rz:R.float(6,20)});
        else
        {
            // fairway bunker at a landing zone
            const p = pathPointAt(len*R.float(.5, .8));
            const side = R.sign();
            hole.bunkers.push({x: p.x + side*(fw/2 + R.float(-2,4)), z: p.z,
                            rx:R.float(6,18), rz:R.float(6,18)});
        }
    }

    // special holes, keyed by POSITION in the round (so a remix re-deal
    // dresses whatever row lands there)
    const isHardTreeHole = index == 12;
    const isIslandHole = par == 3 && waterC == 1 || index == 11;
    const isRiverHole = index == 9;

    if (isRiverHole)
    {
        // long horizontal in center on hole 14
        const p = pathPointAt(len/2);
        hole.waters.push({x:p.x, z:p.z, rx:60, rz:9});
    }

    // water hazards
    if (isIslandHole)
    {
        // island green: big lake under the green, green pokes out on top
        hole.waters.push({x:end.x, z:end.z - len*.1, rx:R.float(40,60), rz:R.float(40,60)});
    }
    else if (R.bool(waterC))
    {
        const n = 1+R.bool(.3);
        let side = R.sign();
        for (let i=n; i--;)
        {
            const p = pathPointAt(len*R.float(.4, 1));
            side *= -1;
            hole.waters.push({x: p.x + side*(fw/2 + R.float(9, 22)), z: p.z + R.floatSign(15),
                           rx: R.float(14, 26), rz: R.float(16, 34)});
        }
    }
    for (const w of hole.waters)
        w.h = Math.min(heightRaw(w.x, w.z), hole.greenH-2) - 1;

    // trees {x, z, s: size, c: colour jitter, k: kind} - k 0 = full tree,
    // 1 = far tree (draws as one canopy), 2 = bush, 3 = wildflower.
    // ODD kinds are scenery, even kinds collide (see hole.near below)
    const addTree = (x, z, s, k)=> hole.trees.push({x, z, s, c: R.float(), k});

    // framing trees: scattered outside the fairway along the hole
    const treeCount = Math.min(400, treeDen*len*.6 | 0);
    for (let i=treeCount; i-- && hole.trees.length<treeCount;)
    {
        const p = pathPointAt(R.float(-9, len*1.1));
        const x = p.x + R.sign()*((fw/2 || 12) + R.float(4, 38));
        const z = p.z + R.floatSign(9);
        if (surfaceAt(x, z) == SURF_ROUGH)
            addTree(x, z, R.float(1, 2)**2, 0);
    }

    // periphery forest: clumps and clearings over the whole ground off the
    // playable corridor
    let x0 = 0, x1 = 0;
    for (const p of P) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); }
    for (let i = 4e3*forestMul; i--;)
    {
        const x = R.float(x0-450, x1+450), z = R.float(-450, len+450);
        const dp = distToPath(x, z);
        // .48 IS LOAD-BEARING, not a density preference: the draws below
        // are only spent when this passes, so moving it shifts the R stream
        // and re-rolls everything after - including every BUSH, which
        // collides. To tune density, hoist those draws above the if first.
        if (dp > 75 && noise2(x*.02+5, z*.02) > .48)
            addTree(x, z, R.float(1.5, 3)*(1 + R.bool(.25)), dp > 180 ? 1 : 0);
    }

    // Bushes through the rough AND out into the periphery. The offset must
    // reach past the treeline and accept OB as well as ROUGH - ROUGH only
    // exists inside ~62yd, so requiring it leaves a ring hugging the
    // corridor with bare ground beyond.
    for (let i=99; i--;)
    {
        const p = pathPointAt(R.float(0, len));
        const x = p.x + R.floatSign(15, 200), z = p.z + R.floatSign(60);
        const s = surfaceAt(x, z);
        if (s == SURF_ROUGH || s == SURF_OB)
            addTree(x, z, R.float(1, 2), 2);
    }
    // Wildflowers: a flower is a very low tree with no trunk and its own
    // hue. LAST in genHole on purpose - every draw here shifts the ones
    // after it, and there are none.
    // KNOBS: 1000 (count), the offset range (how far out), and the size.
    for (let i=1e3; i--;)
    {
        const p = pathPointAt(R.float(0, len));
        const x = p.x + R.floatSign(8, 400), z = p.z + R.floatSign(80);
        const sf = surfaceAt(x, z);
        if (sf == SURF_ROUGH || sf == SURF_OB)
            addTree(x, z, R.float(.1, .2), 3);
    }
    // THE TREE ON 13: one big trunk in the middle of the fairway, a designed
    // obstacle rather than a scattered one. AFTER the flower loop so its R
    // draw cannot re-roll the hole, and BEFORE the hole.near filter below so it
    // gets a baked t.y and can actually be hit.
    if (isHardTreeHole)
    {
        const p = pathPointAt(len*.28);
        addTree(p.x, p.z, 3, 0);
    }
    // Everything the ball can hit - trees AND bushes. The odd kinds (1 = the
    // far forest, 3 = flowers) are scenery, so the test is the low bit.
    // t.y is the CANOPY CENTRE, not the ground: baking the trunk height in
    // here is what lets flyStep test one sphere per prop with no per-kind
    // branch, and is why a bush is just a low tree.
    for (const t of hole.near = hole.trees.filter(t => !(t.k & 1)))
        t.y = heightAt(t.x, t.z) + trunkH(t);
    return hole;
}

// The 18 hole rows for a course.
// REMIX is the classic course RE-DEALT: the same hand-tuned rows shuffled,
// under a seed that also re-rolls every hole's land, pin, wind and scenery.
// It plays like a new course without synthesising a single row, and the
// authored character - the two island par 3s, the long dogleg fives - rides
// along wherever those rows land. The index-keyed specials (river 10,
// island 12, hard trees 13) then dress whatever arrives there.
// The shuffle MUST derive from the SEED, which the save stores, or a
// continued remix round would re-deal itself a different hole order.
function genCourse(seed, remix)
{
    if (!remix)
        return CLASSIC_HOLES;
    const R = new RandomGenerator(seed);
    const rows = [...CLASSIC_HOLES];
    for (let i=18; i--;)
    {
        const j = R.int(i+1);
        [rows[i], rows[j]] = [rows[j], rows[i]];
    }
    return rows;
}
