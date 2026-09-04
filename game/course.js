'use strict';

/*  SUNSHINE GOLF CLASSIC - procedural course
    World units are yards. x = lateral, z = downrange from tee, y = up.
    Each hole is analytic (no stored grids): heightAt / surfaceAt / groundAt
    are the single source of truth for gameplay, the 3D view and the map. */

// surface types (priority order handled in surfaceAt)
// Canopy centre above ground. A bush (k=2) and a flower (k=3) are trees
// whose trunk is too short to draw - this one number is the whole difference.
const trunkH = (t)=> t.s*(t.k > 1 ? 1.2 : 3.4);
const SURF_ROUGH=0, SURF_FAIRWAY=1, SURF_GREEN=2, SURF_TEE=3,
      SURF_BUNKER=4, SURF_WATER=5, SURF_OB=6;
const SURF_NAMES = ['ROUGH','FAIRWAY','GREEN','TEE','SAND','WATER','OB'];

// Seasons: every colour is [h,s,l] at hole 1 and at hole 18, lerped per
// hole. The endpoint NUMBERS choose the hue path - the horizon's 378 (= 18)
// goes the long way round so mid-round is dusk, not a green sky. hsl() wraps.
const PAL =
{
    rough:[[95,45,36],[42,45,32]], fair:[[112,60,45],[85,45,40]], green:[[130,62,62],[120,55,56]],
    sand:[[47,85,74],[28,85,66]], water:[[203,80,55],[255,60,50]],
    sky0:[[207,90,70],[268,70,58]], sky1:[[168,70,86],[378,95,72]],
    tree:[[127,55,32],[24,48,32]], trunk:[[25,50,30],[-10,30,28]], sun:[[50,100,90],[0,100,60]],
};

// classic 18 hole table. dogleg: 0 none, +-(0..1) single bend
// strength/direction, 2 = double bend (S). ONLY EXACTLY 2 is the S: any
// other value past 1 falls through to a single bend that sharp (2.2 = the
// 50-76 degree hairpin on 15). fairwayW is the REAL
// width (0 = a par 3 with none); hazards and framing trees offset from
// fw/2, so widening a hole here also pushes them out.
const CLASSIC_HOLES =
[
    // [par, lenScale, fairwayW, dogleg, bunkers, water, treeDen, hills]

    // front: Meadow - wide, flat, learn the game
    [4, .90, 50,   0, 1,  0, .5, .3],   // the opener: widest fairway on the course
    [3, .80,  0,   0, 1,  0, .6, .3],   // short par 3
    [5, .68, 40,  .5, 1,  1, .7, .4],   // reachable par 5 with water
    [4,1.00, 36,   2, 2,  0, .9, .5],   // S-bend par 4
    [3,1.30,  0,   0, 2,  0, .6, .5],   // MONSTER par 3: 215yd, a wood into the green
    [4,1.00, 36, 1.0, 2,  0,  1, .5],
    // middle: Lake - water arrives, doglegs harden
    [5, .90, 40, -.7, 2, .8, .8, .5],
    [3, .90,  0,   0, 1,  1, .4, .4],   // island par 3
    [4,1.00, 40,  .5, 4, .5,  0, .3],   // LINKS: not a tree, four bunkers, the wind is the hole
    [4, .95, 36, -.9, 3, .5,  1, .7],   // the river
    [5,1.00, 36,   2, 2, .7,  1, .6],   // S par 5
    [4, .58, 30,   0, 1,  1, .8, .6],   // DRIVABLE island par 4, 238yd: driver over the lake, or lay up and wedge
    // back: Cliffs - narrow, hilly, mean
    [4,1.05, 30,   .5, 3, .3,1.2,1.1],  // the tree in the fairway
    [4,1.10, 26,   -1, 0,  .6,1.2,1.3],  // the HILLS are the hazard: no sand, some water
    [5,1.05, 30,  2.2, 2, .5,1.0,  1],  // hairpin par 5 (see dogleg note)
    [3,1.10,  0,   0,  4, .5, .5,  1],  // bunkered par 3 over broken ground
    [4,1.20, 22,   1,  4, .6,1.3,1.2],  // NARROWEST fairway on the course
    [5,1.10, 28,   2,  2, .9,1.4,1.1],
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
    // shores: terrain eases down to meet each lake (balls roll toward hazards)
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
    // bunkers scoop a ramped bowl. It must live HERE: slopeAt reads heightAt
    // and nothing else, so a scoop in groundAt is a cliff at the ellipse edge
    // with no gradient. The GREEN OUT-RANKS THE SAND, as in surfaceAt - k is
    // the plateau blend above, so (1-k) fades the scoop out under it.
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
    // playable corridor with a noise-perturbed boundary, deep rough before OB
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
        // fairway breathes: width swells and pinches along the hole, edges wiggle
        const fwHere = hole.fw*(1 + (noise2(lastAlong*.014, hole.index*7+3)-.5)*.9);
        if (dp < fwHere/2 + (noise2(x*.09+5, z*.09)-.5)*7)
            return SURF_FAIRWAY;
    }
    return SURF_ROUGH;
}

// combined ground query: height + surface. Water is flat at its lake level
// (surfaceAt just set lastWater); the bunker scoop is already in heightAt.
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

    // WIND IS ROLLED FRESH EVERY PLAY (rand, not R): a hole never plays the
    // same twice, and wind can be retuned without re-rolling the course.
    // Never zero - an arrow pointing nowhere reads as a bug. MAXWIND scales
    // the WHOLE curve: mean wind is 1 + MAXWIND/3 and the share of holes
    // above s is 1 - sqrt((s-1)/MAXWIND); the square law keeps most holes
    // gentle. A UNIT IS 2.86 MPH (air velocity `s*WIND_V` = 1.4 yd/s per
    // unit; the HUD prints `s*2.86`). MEASURED at each ceiling, full swings,
    // carry lost into a headwind / cross drift:
    //   MAXWIND 9  29mph  1W -19% 40yd   SW -32% 24yd   >20mph 18% of holes
    //   MAXWIND 7  23mph  1W -14% 32yd   SW -24% 19yd   >20mph  7%   <- here
    //   MAXWIND 6  20mph  1W -13% 28yd   SW -21% 16yd   >20mph  0%
    // 7 keeps about one 20mph+ hole a round; 6 deletes it. glRender's leaf.a
    // divides by 1+MAXWIND for the foliage sway - change one, change the other.
    const MAXWIND = 7;
    hole.wind = {a: rand(PI*2), s: 1 + rand()**2*MAXWIND};

    // bunkers: randomly placed sand
    for (let i=bunkerN; i--;)
    {
        const a = R.angle();
        const d = hole.gr + R.float(2, 7);
        const gx = hole.green.x + Math.sin(a)*d, gz = hole.green.z + Math.cos(a)*d;
        if (!index || R.bool(.5) || par == 3 && waterC == 1)
            hole.bunkers.push({x:gx, z:gz, rx:R.float(6,18), rz:R.float(6,18)});
        else
        {
            // fairway bunker at a landing zone
            const p = pathPointAt(len*R.float(.5, .8));
            const side = R.sign();
            hole.bunkers.push({x: p.x + side*(fw/2 + R.float(-2,4)), z: p.z,
                            rx:R.float(6,18), rz:R.float(6,18)});
        }
    }

    // special holes keyed by POSITION in the round (so a remix re-deal
    // dresses whatever row lands there); the island is keyed by the ROW
    const isHardTreeHole = index == 12;
    // WATER 1 MEANS AN ISLAND GREEN, whatever the par: the lake goes under
    // the green instead of beside the fairway. Classic deals one per par -
    // 3 (a par 5 nobody reaches in two: lay up, then cross), 8 (par 3), 12
    // (the drivable par 4) - and in remix the islands travel with their rows.
    const isIslandHole = waterC == 1;
    const isRiverHole = index == 9;

    if (isRiverHole)
    {
        // river: a wide lake across the middle of the hole
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
    // 1 = far tree (one canopy), 2 = bush, 3 = wildflower; ODD kinds are scenery
    const addTree = (x, z, s, k)=> hole.trees.push({x, z, s, c: R.float(), l: R.float(), k});

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

    // periphery forest: clumps and clearings off the playable corridor
    let x0 = 0, x1 = 0;
    for (const p of P) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); }
    for (let i = 4e3*forestMul; i--;)
    {
        const x = R.float(x0-450, x1+450), z = R.float(-450, len+450);
        const dp = distToPath(x, z);
        // .48 IS LOAD-BEARING: the draws below are spent only when this passes,
        // so moving it shifts the R stream and re-rolls everything after -
        // including every BUSH, which collides. Hoist the draws to tune density.
        if (dp > 75 && noise2(x*.02+5, z*.02) > .48)
            addTree(x, z, R.float(1.5, 3)*(1 + R.bool(.25)), dp > 180 ? 1 : 0);
    }

    // Bushes through the rough AND out into the periphery: the offset reaches
    // past the treeline and OB counts as well as ROUGH, since ROUGH only exists
    // inside ~62yd and requiring it leaves a ring hugging the corridor.
    for (let i=99; i--;)
    {
        const p = pathPointAt(R.float(0, len));
        const x = p.x + R.floatSign(15, 200), z = p.z + R.floatSign(60);
        const s = surfaceAt(x, z);
        if (s == SURF_ROUGH || s == SURF_OB)
            addTree(x, z, R.float(1, 2), 2);
    }
    // Wildflowers: a very low tree with no trunk and its own hue. LAST of the
    // scatter loops on purpose - every draw here shifts the ones after it.
    // KNOBS: the two counts, the offset range (how far out), and the size.
    // A TREELESS hole gets NINE times the flowers - links land, all colour
    // and no canopy. Static-vertex budget: a flower is ~30 verts, and the
    // treeless hole is the lightest on the course because it carries no
    // framing trees, so 9e3 puts it at 514k of gl_STATIC_MAX's 700k where
    // the heaviest normal hole sits at 454k. 12e3 measured 601k (86%), which
    // is too close given remix runs ~5% heavier on unsampled seeds.
    for (let i=treeDen?1e3:9e3; i--;)
    {
        const p = pathPointAt(R.float(0, len));
        const x = p.x + R.floatSign(8, 400), z = p.z + R.floatSign(80);
        const sf = surfaceAt(x, z);
        if (sf == SURF_ROUGH || sf == SURF_OB)
            addTree(x, z, R.float(.1, .2), 3);
    }
    // THE TREE ON 13: one big trunk in the middle of the fairway, a designed
    // obstacle. AFTER the flower loop so its R draw cannot re-roll the hole,
    // BEFORE the hole.near filter so it gets a baked t.y and can be hit.
    if (isHardTreeHole)
    {
        const p = pathPointAt(len*.28);
        addTree(p.x, p.z, 3, 0);
    }
    // Everything the ball can hit - the even kinds. t.y is the CANOPY CENTRE,
    // not the ground: baking the trunk height in lets flyStep test one sphere
    // per prop with no per-kind branch.
    for (const t of hole.near = hole.trees.filter(t => !(t.k & 1)))
        t.y = heightAt(t.x, t.z) + trunkH(t);
    return hole;
}

// The 18 hole rows. REMIX is the classic course RE-DEALT: the same rows
// shuffled under a seed that also re-rolls every hole's land, pin and
// scenery, and the index-keyed specials (river 10, island 12, hard tree 13)
// dress whatever row arrives there. The shuffle MUST derive from the SEED
// the save stores, or a continued remix round would re-deal a new order.
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
