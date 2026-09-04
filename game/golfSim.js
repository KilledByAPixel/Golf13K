'use strict';

/*  SUNSHINE GOLF CLASSIC - swing meter, clubs, ball physics
    Ball flight: launched from the range formula, then flown under real
    aerodynamics - drag along the air-relative velocity and lift across it.
    Bounce/roll on the course heightfield with per-surface restitution
    and friction. */

// [name, carry yards, loft degrees]
const CLUBS =
[
    ['1W',235,11],['3W',215,14],['5W',198,17],['3i',183,19],['5i',168,22],
    ['7i',150,26],['9i',131,31],['13i',120,41],['PW',108,38],['SW',78,48],['PT',0,0]
];
// THE 13 IRON is the jam's number in the bag and breaks the ladder on
// purpose: it fills the set's one real gap (120yd) with MORE loft than the PW
// it outdrives - the highest flight and least run of anything past 100yd.
// NOTE the meter dials any distance under a club's max, so what a club really
// picks is a LAUNCH ANGLE, and with it the arc, the descent and the run.
const CLUB_PUTTER = 10;
// The putter's full-power roll, in yards of GREEN (targetMax reports it, the
// putt prediction launches at power*PUTT_MAX). The lie is NOT baked in:
// puttVel always solves speed against the green's friction, so "40" means 40
// yards of green wherever the ball is standing.
const PUTT_MAX = 40;
// How far PAST the cup resetTarget sets the bar's top, as a multiple of the
// putt. MUST stay above 1: a bar topping out exactly at the cup can only be
// missed short, since every stroke that is not perfect at the very top falls
// under it. At 1.2 the cup marker lands around 82% of the bar, which is also
// what keeps that marker on screen (it is only drawn when it fits).
const PUTT_OVER = 1.2;
// How hard a mis-timed second click PUSHES a putt offline. Its own number
// because push/pull is an ANGLE: the .05 every other club uses is ten yards
// of miss on a 200yd drive and two CENTIMETRES on a ten yard putt.
// MEASURED at .75, whether the putt drops - P perfect, G good (.05), B bad:
//   1-2yd   PGB   tap-ins are safe even off a bad stroke
//   3-6yd   PG-   a good stroke drops, a sloppy one does not
//   10-16yd P--   long putts want a near-perfect strike
// Raise to punish more, .25 to go back to gentle. Between .5 and .75 the
// make/miss outcomes are IDENTICAL and only the visible curve grows.
// Not symmetric: impact runs -METER_OVER..meterPower, so a LATE click is
// capped at -.13 while an early one can be several times that.
const PUTT_PUSH = .75;
const GRAV = 11;         // yards/s^2
// REAL SIZES, then ONE exaggeration. Ball and cup both come off PROP_SCALE so
// the cup stays 2.5x the ball as in real golf; scaling them independently
// makes a hole look wrong for its ball. The camera is 87 degrees vertical,
// about as wide as a lens gets, which is why life size reads tiny.
// MEASURED at 900px tall, and as the share of dead straight putts that drop
// at 3 / 8 / 15yd:
//        ball across   ball px @16yd  @5yd    straight putts
//   1x     .047yd          1.4          4.4    69% / 36% / 20%
//   2x     .093            2.8          8.8    81% / 53% / 28%
//   3x     .140            4.1         13.2    94% / 60% / 36%   <- here
//   4x     .187            5.5         17.7    98% / 62% / 40%
// The FLAGSTICK is deliberately NOT scaled: at 7ft it is big already and 3x
// would make it a 21ft pole.
const PROP_SCALE = 3;
const HOLE_R = .059*PROP_SCALE;   // a 4.25in cup, in yards
const BALL_R = .0233*PROP_SCALE;  // a 1.68in ball
// 2.3, not the true 2.33 - a 13k build pays for every digit nobody can see.
// (HOLE_R and BALL_R SHARE the PROP_SCALE token, which packs better than two
// independent literals would.)
const POLE_H = 2.3;               // a 7ft flagstick, at life size
// The flagstick's strike radius, kept UNDER what the pole draws at
// (.04-.16, distance-compensated) so it never feels like a hidden wall.
// Ball radius is effectively included, so .15 catches all but a graze.
const POST_R = .15;
// THE CUP'S LIP: a local height term finer than the terrain mesh, felt by
// the roll and never drawn; being a HEIGHT rather than a pull, it composes
// with a green that tilts away from the hole. R = reach, D = depth.
// IT IS A LOOK, NOT A DIFFICULTY: at the pace players actually strike (the
// bar sits PUTT_OVER past the hole, so the ball crosses the cup at 3-6yd/s)
// lateral forgiveness is .19yd for EVERY row below, against a cup radius of
// .177. What it does is BEND a passing putt, which reads as the hole sucking
// balls in. MEASURED on a 10yd putt aimed wide, as the yards it drags the
// ball off its own aim line:
//        aimed .25 wide   .40   .60
//   .9 .10      .22       .30   .28   <- a magnet, pulls from 2ft
//   .9 .04      .09       .12   .11
//   .4 .06      .18       .00   .00   <- here
//   .3 .06      .09       .00   .00
// The gradient divides by R, so shrinking R alone makes the funnel STEEPER -
// move both, or only D. Tune by eye; to make putting genuinely harder the
// knob is the CUP: forgiveness tracks HOLE_R almost exactly (PROP_SCALE 3 ->
// .19, 2.5 -> .16, 2 -> .13).
const LIP_R = .4, LIP_D = .06;
// how fast the ball may cross the cup and still drop, yards/second
const CUP_SPEED = 8;
// The cup is wider to a ball coming DOWN into it than to one rolling across,
// or chipping in or an ace is so unlikely it may as well be impossible.
// Applies to every bounce, not just the first.
const AIR_HOLE = HOLE_R*1.8;
const DT = 1/60;         // physics step = one frame
// AIR VELOCITY per unit of wind, yards/second. The wind is not a force with
// its own coefficient - it is the speed of the air, and drag does the pushing
// (a wind that pulls a ball along IS drag). 1.4 = .0055/DRAG_K, the pull per
// unit the course is tuned around.
const WIND_V = 1.4;
// Real golf-ball aerodynamics, in yard units: a 45.9g ball across 1.43e-3
// m^2 gives 0.5*rho*C*A/m near .004 for both (C_d and C_l are both about
// .25). Drag alone at .004 costs a driver 36% of its carry; lift pays it back.
// LIFT_K is FITTED, not physical: lift (v^2) repays fast clubs more while
// drag costs them more, and at this ratio the two skews cancel so every club
// loses the SAME share. MEASURED, driver error vs sand wedge error:
//   LIFT_K .0040   -2.1% / -22.5%   spread 23.2pt
//   LIFT_K .0025  -12.0% / -21.4%   spread 13.0pt
//   LIFT_K .0015  -21.4% / -21.1%   spread  4.3pt   <- here
// A uniform loss is what lets ONE compensation constant (CARRY_K) put the
// whole bag back on its labels.
const DRAG_K = .004, LIFT_K = .0015;
// The launch overshoots so drag can take it back, by 1 + CARRY_K*q where q
// is the fraction of the club's FULL flight being asked for (power x lie).
// Drag's bite grows with speed, so the factor must scale with q: a fixed one
// fitted at full power throws every softer shot 18-30% long and makes the
// lie multipliers lie too. Linear in q is the fit: swept .38-.48, .4 has the
// lowest rms (2.4%, worst 5.5%) and leaves full swings 1-3% under label.
const CARRY_K = .4;
const LIFT_SPIN = .001;
// SPIN IS A LAUNCH ANGLE, not a force: degrees of loft added for backspin
// and taken away for topspin. launchVel solves velocity FROM the angle to hit
// the club's stated carry, so the arc moves (apex = carry*tan(angle)/4) while
// the carry is nominally held; bending GRAVITY instead moves both together
// and no tuning separates them. Under real drag and lift (flyStep) the loft
// change also changes hang time, so the carry still MOVES with spin, and not
// the same way across the bag. MEASURED, flat fairway, calm, full power -
// carry / run / apex:
//   1W   back 224.9 /  6.1 / 48.4   none 233.7 / 21.4 / 31.2   top 219.4 / 56.9 / 14.1
//   7i   back 142.9 /  5.0 / 44.5   none 149.2 / 17.6 / 32.2   top 145.8 / 32.8 / 21.2
//   SW   back  71.0 /  3.2 / 47.3   none  80.5 / 11.4 / 34.9   top  83.8 / 21.0 / 25.8
// The aim preview flies the same integrator, so the ring and the chip show
// whichever it is. If the skew ever matters: a smaller SPIN_LOFT for the
// lofted clubs, or LIFT_SPIN up.
const SPIN_LOFT = 8;

// per-surface: [bounce restitution, bounce keep, roll friction, power mult]
// Bounce is FITTED TO THE CURRENT FLIGHT. Landing speed and angle move under
// every club whenever drag or lift change, so re-measure with RANGE() + X
// before tuning either of the first two columns.
// THE GREEN must stay softer than the fairway, or backspin becomes
// compulsory: a wedge that runs 15yd on landing runs further than most greens
// are deep. MEASURED roll on a green, 7i / PW / SW, no spin then backspin:
//   .30/.55   18.7 / 15.5 / 11.9    3.1 / 2.0 / 1.1   sim +2
//   .26/.45   13.4 / 10.1 /  7.8    2.1 / 1.4 / 0.8   <- here, sim +5
//   .22/.35    8.0 /  6.4 /  4.9    1.3 / 0.8 / 0.5   sim +9
//   .15/.25    3.6 /  3.0 /  2.3    0.6 / 0.4 / 0.2
// Receptive, not dead - a mid iron still releases while backspin checks it
// inside a yard. Putting is untouched: a putt rolls, on column 3.
// COLUMN 4 IS WHAT THE LIE COSTS THE CARRY, exactly (the overshoot scales
// with it, see CARRY_K). .8 and .65 because the rough is tough enough.
// THE ROUGH'S LANDING (row 1, columns 1-3) must let the ball hop, or a shot
// hit up over a hill out of it sticks where it lands. MEASURED, a 7i landing
// in rough - run after the carry, flat / on a 25% upslope, against 17.4 /
// 10.5 on fairway:
//   .22/.32/14    5.2 /  3.0   a half swing 3.1 / 1.3   no hop at all
//   .26/.40/10    8.0 /  4.4              4.9 / 2.0   <- here, half of fairway
//   .30/.45/8    11.1 /  6.0              6.6 / 2.7   two thirds of fairway
// A ball flown into a 60% face out of rough STAYS on the face in every row
// (friction 8+ holds a 60% grade); a fairway ball rolls back to the bottom.
const SURF_PHYS =
[
    [.26,.4,10, .8 ], // rough
    [.32,.52, 6,  1 ], // fairway
    [.26,.45, 3,  1 ], // green
    [.32,.52, 6,  1 ], // tee
    [.05,.20,30, .65], // bunker
    // WATER'S FRICTION IS ONLY EVER READ BY THE PUTT PREVIEW - a played
    // ball never rolls here, hazardEnd stops it the moment it is wet. It
    // is high so the preview stops at the shoreline too: at 0 the roll
    // never slows and never rests, and a putt aimed over a lake predicts
    // 80yd across it. Columns 1, 2 and 4 are dead for the same reason.
    [ 0,  0, 99,  1 ], // water (splash)
    [.25,.45,14,  1 ], // OB
];

let ball = {x:0, y:0, z:0, vx:0, vy:0, vz:0};
let ballAir = 0, ballRolling = 0, bounces = 0;
// The drawn ball's roll angle, radians per yard, accumulated forever (sin and
// cos wrap). NOT physical: a real ball is 1/radius = 43 rad/yd, which strobes
// into nonsense at 60fps. 3 reads on the putt cam, where a 5yd putt turns
// about 2.4 times. A drive's spin aliases (3.17 rad a frame) - FINE, the ball
// is small, distant and moving; do not cap it.
const ROLL_K = 3;
let ballRoll = 0;
// The heading the ball is ACTUALLY moving on, not shotDir: the break pulls a
// putt's true heading a mean 8.9deg off shotDir in its last quarter, exactly
// when the ball is slow, near the putt cam, and being watched. Written only
// while the ball moves, so a ball at rest keeps its heading rather than
// snapping when its velocity hits exactly zero.
let ballDir = 0;
let pinHit = 0;          // one pin strike per shot, latched (see ballUpdate)
// The pin is PULLED for a shot played from inside 10yd - no post to hit and
// nothing standing over the hole. Decided once in enterAim, not from the
// live ball, or a long approach would lose the pin as it closed in.
let pinOut = 0;
let ballSpin = 0, ballCurve = 0, shotDir = 0;
let treeHit = 0;          // set by flyStep on a tree strike; the HUD clears it
// Frames of tree immunity after a strike, or the reflection sends the ball
// back across the volume it just hit and it ping-pongs in place inside a
// canopy. 8 frames at the reflected tenth-speed is about half a yard.
let treeCool = 0;
const TREE_COOL = 8;
// How the shot ended, 0 = still in motion. EV_WATER/EV_OB deliberately EQUAL
// the surface codes, so hazardEnd stores the surface it was handed. Dev tools
// print names via EV_NAMES.
const EV_HOLED = 1, EV_STOPPED = 2, EV_WATER = SURF_WATER, EV_OB = SURF_OB;
let ballEvent = 0;
let shotStart = {x:0,z:0};// where the shot was played from
let ballSafe = {x:0,z:0}; // last point over safe ground - hazard drop spot

// the ground under the ball, the ball's spot as a record, distance to the pin
const ballGround = ()=> groundAt(ball.x, ball.z);
const ballXZ = ()=> ({x: ball.x, z: ball.z});
const ballToPin = ()=> Math.hypot(ball.x-hole.pin.x, ball.z-hole.pin.z);

// Closest approach of this step's PATH (x0,z0 -> b) to a point, in 2D. The
// whole segment is tested, not just where it ended: the ball covers a quarter
// of a yard in a rolling step and most of a yard in the air, so a position-
// only test tunnels clean through anything thin. The cup, the pin post and
// every TREE TRUNK all go through here. segT keeps the closest-approach param
// so a trunk hit can roll the ball back to the impact point.
let segT = 0;
function pathDist(b, x0, z0, px, pz)
{
    const dx = b.x-x0, dz = b.z-z0, l2 = dx*dx + dz*dz;
    segT = l2 ? clamp(((px-x0)*dx + (pz-z0)*dz)/l2) : 0;
    return Math.hypot(px-x0-dx*segT, pz-z0-dz*segT);
}
const cupHit = (x0, z0, r=HOLE_R)=> pathDist(ball, x0, z0, hole.pin.x, hole.pin.z) < r;

// ball trail: recent positions with timestamps. The renderer draws a ribbon
// through them whose alpha fades with age; trailPrune drops expired samples,
// so the trail dies on its own ~1s after the ball stops.
const TRAIL_LIFE = 1; // seconds a sample stays visible
let trail = [];
let trailTotal = 0;

function trailPush(t)
{
    trail.push({x: ball.x, y: ball.y, z: ball.z, t});
}

function trailPrune(t)
{
    while (trail.length && t - trail[0].t > TRAIL_LIFE)
    {
        trail.shift();
        ++trailTotal;
    }
}

///////////////////////////////////////////////////////////////////////////////
// swing meter

const METER_UP_TIME = 1, METER_DOWN_TIME = .8, METER_OVER = .13;
let meterPhase = 0;  // 0 off, 1 power (up + bounce back down), 2 accuracy sweep
let meterT = 0, meterPower = 0, meterImpact = 0;

function meterStart() { meterPhase = 1; meterT = 0; }

// The on-bar cursor, ONE formula for both phases: meterT is a position on a
// folded line, up to the top at 1 and back down. Phase 1 runs it forwards
// 0..2, which is the two chances at every power; phase 2 always starts below
// the fold, so the same expression reads straight through.
const meterPos = ()=> meterT > 1 ? 2 - meterT : clamp(meterT, -METER_OVER, 1);

// Returns an event code when a phase resolves, 0 nothing yet.
const MET_POWER = 1, MET_SWING = 2, MET_CANCEL = 3;
// A CLICK IS READ BEFORE THE CURSOR MOVES: the frame was drawn at the end of
// the previous update, so advancing first would score a position one step
// (DT/METER_DOWN_TIME = .0208, wider than the sweet spot's half-width) past
// the one the player aimed at. EVERY CLUB TAKES THE SAME THREE CLICKS, the
// putter included, so a pushed putt misses the hole.
function meterUpdate(clicked)
{
    if (meterPhase == 1)
    {
        if (clicked)
        {
            meterPower = meterPos();
            // The sweep starts from the power mark and only ever falls: a
            // cursor reversing under you does not read as one continuous
            // swing, whatever reaction time running it back up would buy.
            meterPhase = 2;
            meterT = meterPower;
            return MET_POWER;
        }
        if (meterT >= 2)
        {
            meterPhase = 0; // full round trip with no click, swing cancels
            return MET_CANCEL;
        }
        meterT += DT/METER_UP_TIME;
    }
    else if (meterPhase == 2)
    {
        if (clicked || meterT < -METER_OVER)
        {
            // impact error: 0 = perfect, + early, - late. The cursor's own
            // position (where it LOOKS), so the range is -METER_OVER..1.
            meterImpact = meterPos();
            meterPhase = 0;
            return MET_SWING;
        }
        meterT -= DT/METER_DOWN_TIME;
    }
    return '';
}

///////////////////////////////////////////////////////////////////////////////
// shot launch

// launch velocity for a club from a lie: the range formula gives the carry
// (+7deg of loft so the flight climbs like a real one), power scales it
function launchVel(b, clubI, dir, lieMul, power=1, spin=0)
{
    const c = CLUBS[clubI], la = (c[2] + 7 - spin*SPIN_LOFT)*Math.PI/180, q = lieMul*power;
    const v = Math.sqrt(c[1]*q*(1 + CARRY_K*q)*GRAV/Math.sin(2*la));
    b.vx = Math.sin(dir)*Math.cos(la)*v;
    b.vy = Math.sin(la)*v;
    b.vz = Math.cos(dir)*Math.cos(la)*v;
    return b;
}

// every shot starts here: remember where it was played from, reset the
// flight state, and set shotDir (the trail, the curve and the putt camera
// all read it, so a putt must set it too)
function shotBegin(air, dir)
{
    shotStart = ballSafe = ballXZ();
    ballAir = air; ballRolling = !air; bounces = 0; pinHit = 0; treeCool = 0; ballEvent = 0;
    shotDir = dir;
}

// THE ONE LAUNCH, putter included. power is a fraction of the club's max from
// this lie (shotPower gives it), so for the putter it scales PUTT_MAX and
// lands on exactly the yards the bar promised. The impact error is read the
// same way for every club, which is what makes a putt missable.
function launchBall(clubI, power, impact, spin, dir, lieMul)
{
    const putt = clubI == CLUB_PUTTER;
    // snap tiny errors to perfect
    const err = Math.abs(impact) < .02 ? 0 : impact;
    // a miss either way loses power. No spin term here: see the table at
    // SPIN_LOFT for what spin does to carry, club by club.
    power *= 1 - Math.max(err, -err)*.35;
    // push/pull. An ANGLE, so a putt needs its own - see PUTT_PUSH
    dir += err*(putt ? PUTT_PUSH : .05);
    ballCurve = err*22; // hook/slice curve accel
    ballSpin = spin;
    shotBegin(!putt, dir);
    if (putt)
        // yards, not a speed: puttVel owns the v = sqrt(2fd) conversion, so
        // the bar stays linear in distance
        puttVel(ball, power*PUTT_MAX, dir);
    else
    {
        launchVel(ball, clubI, dir, lieMul, Math.max(.05, power), spin);
        ball.y = ballGround().h + .1;
    }
    return err;
}

// a putt is asked for in YARDS: rolling distance is v^2/2f, so this is the
// one place that conversion lives, and the meter stays linear in yards (as a
// speed fraction, half a meter would reach a quarter of the target).
// b = the ball, or the putt preview's scratch copy
function puttVel(b, dist, dir)
{
    // Solved against the GREEN's friction whatever the ball is sitting in, so
    // "8 yards" always means 8 yards of green roll: a putt out of rough
    // travels LESS than asked and the player adds power, rather than 8yd of
    // rough speed running away on grass 4.7x slicker.
    const v = Math.sqrt(6*dist)*1.02;
    b.vx = Math.sin(dir)*v;
    b.vz = Math.cos(dir)*v;
    b.vy = 0;
    return b;
}

// A putt asked for in YARDS, with no meter and no error: the BOT's putt and
// the unit tests' (the player goes through launchBall). botSwing is behind
// `debug` and nothing else calls this, so the release build drops it. A bot
// on a clean stroke keeps `npm run sim` measuring the COURSE, not the meter.
function launchPutt(dist, dir)
{
    ballSpin = ballCurve = 0; // a lip-out flies; no stale spin or curve there
    shotBegin(0, dir);
    puttVel(ball, dist, dir);
}

///////////////////////////////////////////////////////////////////////////////
// simulation

// Trunk collision radius as a fraction of tree size. The DRAWN trunk is .3*s
// at the base tapering to .22*s at the top, and collision must sit on the
// FORGIVING side of what the eye sees or it reads as unfair. The C debug
// view draws this same number, so what it shows is what the ball hits.
const TRUNK_R = .22;

// one step of flight for b (the ball, or a scratch copy): gravity, wind, drag,
// lift and the hook/slice curve across the shot direction. wv is the AIR's
// speed and defaults to the hole's wind; the aim preview passes 0 to fly the
// same integrator through still air (it sets ballSpin itself).
function flyStep(b, curve, wv = hole.wind.s*WIND_V)
{
    // Velocity RELATIVE TO THE AIR, the only thing either force acts on: drag
    // slows the ball in still air, drags it toward the air when the air is
    // moving, and lift holds it up.
    const ry = b.vy;
    const rx = b.vx - Math.sin(hole.wind.a)*wv, rz = b.vz - Math.cos(hole.wind.a)*wv;
    const sp = Math.hypot(rx, ry, rz), vh = Math.hypot(rx, rz) || 1;
    const d = DRAG_K*sp*DT;
    // LIFT is perpendicular to the airflow in the vertical plane; backspin
    // adds to it (a longer float, a steeper finish), topspin subtracts.
    const l = (LIFT_K - ballSpin*LIFT_SPIN)*sp*DT;
    b.vx += Math.cos(shotDir)*curve*DT - rx*d - ry*rx/vh*l;
    b.vz -= Math.sin(shotDir)*curve*DT + rz*d + ry*rz/vh*l;
    b.vy += vh*l - ry*d - GRAV*DT;
    b.x += b.vx*DT;
    b.y += b.vy*DT;
    b.z += b.vz*DT;
    // Canopy sphere plus a trunk cylinder; a strike kills most of the speed.
    // ONLY the real ball collides - the prediction ignores trees, so the ring
    // does not jump as the aim sweeps past one.
    if (b == ball && treeCool) --treeCool;
    else if (b == ball)
    {
    const x0 = b.x - b.vx*DT, z0 = b.z - b.vz*DT;
    for (const t of hole.near)
    {
        const dx = b.x-t.x, dz = b.z-t.z, dy = b.y-t.y, r2 = dx*dx+dz*dz, s2 = t.s*t.s;
        // only a ball moving INTO the volume is stopped (the dot uses the
        // START of the step, like the pin's), or a ball at rest against the
        // trunk could never leave. The CANOPY keeps a position test - a step
        // is under 1.2yd and the sphere at least 2 across. The TRUNK sweeps
        // through pathDist like the pin post, or a flight step tunnels clean
        // through it, then rolls back to the impact point so the ball is not
        // left out the far side of the tree.
        const canopy = r2 + dy*dy < s2;
        if (canopy ? dx*b.vx + dy*b.vy + dz*b.vz < 0
            : dy < 0 && pathDist(b, x0, z0, t.x, t.z) < t.s*TRUNK_R
              && (x0-t.x)*b.vx + (z0-t.z)*b.vz < 0)
        {
            if (!canopy)
            {
                b.x = lerp(x0, b.x, segT);
                b.z = lerp(z0, b.z, segT);
            }
            // the flag and sound are for the first strike only: a ball
            // falling out of the canopy re-enters the sphere every step
            const sp = Math.hypot(b.vx, b.vz);
            if (sp > 2)
            {
                treeHit = 1;
                sfxBounce(SURF_ROUGH, sp);
            }
            b.vx *= -.1; b.vz *= -.1; b.vy = Math.min(b.vy, 0);
            treeCool = TREE_COOL;
            break;
        }
    }
    }
}

// One step of roll for b - the ball, or the putt preview's scratch copy.
// Slope pull, then friction, then move. Returns the speed BEFORE the step
// (the cup test wants that) and sets rollRest when friction can hold the
// ball against the slope here, which is the only place it may stop.
let rollRest = 0;
function rollStep(b)
{
    const P = SURF_PHYS[groundAt(b.x, b.z).s];
    // a stronger pull rolls far more balls into the lakes: the shores slope
    // toward them
    const [gx, gz] = slopeAt(b.x, b.z, .6);
    b.vx -= gx*GRAV*DT;
    b.vz -= gz*GRAV*DT;
    const sp = Math.hypot(b.vx, b.vz);
    if (sp > 0)
    {
        const k = Math.max(0, sp - P[2]*DT)/sp;
        b.vx *= k; b.vz *= k;
    }
    // the lip, added to the gradient before the move so it steers this step
    const cx = b.x-hole.pin.x, cz = b.z-hole.pin.z, cd = Math.hypot(cx, cz);
    if (cd < LIP_R && cd > .01)
    {
        const u = cd/LIP_R;
        const dh = 4*LIP_D*u*(1 - u*u)/LIP_R; // d(height)/d(distance out)
        b.vx -= dh*cx/cd*GRAV*DT;
        b.vz -= dh*cz/cd*GRAV*DT;
    }
    b.x += b.vx*DT;
    b.z += b.vz*DT;
    b.y = groundAt(b.x, b.z).h;
    rollRest = sp < .4 && Math.hypot(gx, gz)*GRAV < P[2];
    return sp;
}

// water or OB ends the shot on the spot (game.js handles the drop)
function hazardEnd(s)
{
    if (s < SURF_WATER) return 0;
    ballAir = ballRolling = 0;
    ballEvent = s; // EV_WATER/EV_OB ARE the surface codes
    return 1;
}

function ballUpdate()
{
    if (ballAir)
    {
        const x0 = ball.x, z0 = ball.z;
        flyStep(ball, ballCurve);
        const g = ballGround();
        if (g.s < SURF_WATER)
            ballSafe = ballXZ(); // track hazard drop spot
        // THE PIN, a thin post the ball can clatter off. Only a ball still IN
        // THE AIR can hit it: one reaching the ground is the cup's business,
        // so a chip-in is never knocked away. cupHit sweeps the whole step
        // PATH - at flight speed a step is most of a yard and a position test
        // would tunnel through a .2yd post. The dot product uses the position
        // BEFORE the step, so a ball at REST against the post cannot kill its
        // own first step.
        if (ball.y > g.h)
        {
            // ...and only up the DRAWN stick, or invisible pole strikes balls
            if (!pinHit && !pinOut && ball.y < g.h + POLE_H && cupHit(x0, z0, POST_R)
                && (x0-hole.pin.x)*ball.vx + (z0-hole.pin.z)*ball.vz < 0)
            {
                // ONCE PER SHOT: the ball tunnels through, reflects onto the
                // far side and crosses back, and every crossing is a genuine
                // approach the dot product cannot reject - unlatched, it
                // rattles down the stick losing 40% a pass.
                pinHit = 1;
                // a vertical post reflects HORIZONTAL velocity only
                ball.vx *= -.6; ball.vz *= -.6;
                snd_bounce.play(.6);
            }
            return;
        }
        ball.y = g.h;
        if (hazardEnd(g.s)) return;
        if (cupHit(x0, z0, AIR_HOLE))

        {
            // straight in off the flight. No speed limit: a shot arrives far
            // faster than a putt may cross the cup, or an ace could never happen.
            ballAir = 0;
            ballEvent = EV_HOLED;
            return;
        }
        const P = SURF_PHYS[g.s];
        if (ball.vy >= 0)
        {
            // flew into a rising slope while still climbing: reflect off the
            // slope normal (-gx, 1, -gz) - a height field must never be
            // tunnelled, or balls sail under hills into the water. A hill
            // smack IS a bounce (scrubs with the surface keep, counts toward
            // the spin bite), or a flat topspin drive banks off a steep face
            // at full speed and finishes PAST its flat-ground total.
            const [gx, gz] = slopeAt(ball.x, ball.z);
            const k = (ball.vy - ball.vx*gx - ball.vz*gz)/(gx*gx + 1 + gz*gz)*(1 + P[0]);
            if (k < 0)
            {
                ++bounces;
                // and it SOUNDS like one: the turf blip at the impact speed.
                // -k is the normal speed, near enough (1+P[0] is at most 1.32)
                sfxBounce(g.s, -k);
                ball.vx = (ball.vx + gx*k)*P[1];
                ball.vy = (ball.vy - k)*P[1];
                ball.vz = (ball.vz + gz*k)*P[1];
            }
            return;
        }
        ++bounces;
        sfxBounce(g.s, -ball.vy);   // vy is still the incoming speed here
        let keep = P[1];
        if (bounces == 1)
        {
            // Bite on the first bounce. One symmetric number: raising it
            // stops backspin harder AND lets topspin run further, so .7 is
            // where the three totals sit closest (295/286/294).
            keep *= 1 + ballSpin*.7;
            if (g.s == SURF_GREEN && ballSpin < 0)
            {
                // backspin sucks back: 3yd/s of draw against the shot, AFTER
                // the keep below scrubs the landing speed - hence the /keep,
                // since this line runs before that multiply. MEASURED as run
                // after the carry for 1W / 7i / PW / SW at full power, and a
                // 10yd wedge chip:
                //   7   -5.2 / -6.0 / -7.1 / -8.1, chip -4.7   (far too much)
                //   3     .1 /  -.6 / -1.4 / -2.2, chip -1.4   <- here
                //   2    1.4 /   .7 /   .0 /  -.7, chip  -.7
                // Green only: keep is never 0 here (water's is, and water
                // never reaches this line).
                ball.vx += Math.sin(shotDir)*ballSpin*3/keep;
                ball.vz += Math.cos(shotDir)*ballSpin*3/keep;
            }
            ballSpin *= .3;
        }
        ball.vy = -ball.vy*P[0];
        ball.vx *= keep;
        ball.vz *= keep;
        if (ball.vy < 1.6)
        {
            ball.vy = 0;
            ballAir = 0;
            ballRolling = 1;
        }
    }
    else if (ballRolling)
    {
        const g = ballGround();
        if (hazardEnd(g.s)) return;
        ballSafe = ballXZ();
        const x0 = ball.x, z0 = ball.z;
        const sp = rollStep(ball);
        const hit = cupHit(x0, z0);
        if (hit && sp < CUP_SPEED)
        {
            ballRolling = 0;
            ballEvent = EV_HOLED;
        }
        else if (hit)
        {
            // over the rim too fast: tip the SAME speed upward so it visibly
            // hops out instead of gliding across, which reads as a lip-out.
            // bounces is NOT reset here, so the hop is not a first bounce
            // and the spin bite does not run again.
            ballAir = 1; ballRolling = 0;
            ball.vy = sp*.35;
            ball.vx *= .93; ball.vz *= .93; // keeps |v| about the same
        }
        else if (rollRest)
        {
            ball.vx = ball.vz = 0;
            ballRolling = 0;
            ballEvent = EV_STOPPED;
        }
    }
}

// pick the best club for the remaining distance
function autoClub()
{
    const d = ballToPin(), s = ballGround().s;
    // putt, or bump-and-run from short grass - but only within the putter's
    // reach off the green, which is 120/friction = 20yd on fairway or tee
    if (s == SURF_GREEN || (d < 19 && s != SURF_BUNKER && s != SURF_ROUGH))
        return CLUB_PUTTER;
    if (s == SURF_BUNKER)
        return 9; // SW
    // 15% OF HEADROOM, never a bare fit. A club chosen to
    // just barely reach the pin cannot be pushed any further, and INTO A
    // WIND it has to be: a headwind at the top of the range takes about 14%
    // off a driver and more off the short clubs, so a bag matched exactly to
    // the distance leaves the player stuck. The target is still the pin
    // (resetTarget), so clubbing up only moves the top of the meter out and
    // gives the power somewhere to go.
    // Bigger margins were measured and are worse: 1.2 costs 2 bytes and the
    // bot went +1 to +6, because a longer club flies flatter and runs on,
    // which is exactly what an approach does not want.
    // THE LIE IS IN IT TOO: k is the surface's power multiplier over that
    // margin, so the test is the club's REAL carry from here against the
    // distance. Without it the rough would be handed clubs that cannot reach
    // at any power, which is the same trap as the wind one above.
    // `i--` walks 9 down to 0 (shortest club first) and `!i` hands over the
    // driver when nothing reaches.
    const k = SURF_PHYS[s][3]/1.15;
    for (let i=CLUB_PUTTER; i--;)
        if (CLUBS[i][1]*k >= d || !i)
            return i;
}

// THE AIM PREVIEW, and the whole of it: the full flight integrated down to
// the ground, returning where it lands and leaving the PATH in predPath. The
// arc is predPath drawn, the ring sits on the return value, and the chip's
// yardage is the distance to it, so none of them can disagree with each other
// or with the shot. FLOWN IN STILL AIR (the 0 passed to flyStep): reading the
// wind is the player's job and the arrow is there for it.
// predHit: the predPath index where the arc first clips a RISING face, or
// 1e9 for a clear flight. The prediction skims such a face at full speed
// where the real ball reflects off it and scrubs, so this marks the shots
// the ring is lying about (measured: a driver into a 60% slope is
// predicted 138yd and stops at 25).
let predPath = [];
function predictLanding(clubI, dir, spin, lieMul, power=1)
{
    // A PUTT walks rollStep to a standstill instead, and the "landing" is
    // where it stops - so putting shares the ring, the yardage, the target
    // cam and the meter scale with every other club, and the number accounts
    // for the LIE, the SLOPE and the break by simulating them.
    if (clubI == CLUB_PUTTER)
    {
        const b = puttVel({x: ball.x, y: ball.y, z: ball.z}, power*PUTT_MAX, dir);
        // counts UP, unlike the flight below, so that i=0 samples the ball
        // itself and the path needs no separate seed (the flight counts down
        // to 0 and so has to be seeded, or it starts four steps out)
        predPath = [];
        rollRest = 0;
        for (let i=0; i<600 && !rollRest; ++i)
        {
            !(i%5) && predPath.push({x: b.x, y: b.y, z: b.z});
            rollStep(b);
        }
        // the resting place itself, so the dashes run into the middle of the
        // ring exactly as the flight arc does
        predPath.push({x: b.x, y: b.y, z: b.z});
        return b;
    }
    // start from heightAt, which is what the loop below lands against
    // (groundAt().h and heightAt agree everywhere but water)
    const b = launchVel({x: ball.x, y: heightAt(ball.x, ball.z) + .1, z: ball.z}, clubI, dir, lieMul, power, spin);
    // fly the spin it was ASKED for, not whatever the last real shot left in
    // ballSpin: it launches with spin as loft, so it must lift with it too
    ballSpin = spin;
    // SEED IT AT THE BALL: the loop samples every fifth step and 599 is not a
    // multiple of 5, so without this the ribbon starts four steps out.
    predPath = [{x: b.x, y: b.y, z: b.z}];
    let d0 = .1; // height above the ground, carried from the last step
    for (let i=600; i--;)
    {
        const x0 = b.x, z0 = b.z;
        !(i%5) && predPath.push({x: b.x, y: b.y, z: b.z});
        flyStep(b, 0, 0);
        const d1 = b.y - heightAt(b.x, b.z);
        if (d1 <= 0)
        {
            // ONLY A DESCENDING BALL HAS LANDED: clipping a rise on the way UP
            // is a reflection in ballUpdate, not a landing, and ending on any
            // contact puts the ring at the player's feet when aiming up a slope.
            if (b.vy < 0)
            {
                // Land where the step CROSSED the ground, not at its end: a
                // step is over half a yard at landing speed, and the ring
                // would snap by that much whenever the step count changed.
                const t = d0/(d0 - d1);
                b.x = lerp(x0, b.x, t);
                b.z = lerp(z0, b.z, t);
                // END THE LINE ON THE GROUND at the exact point the ring is
                // drawn, or the ribbon finishes up to 2.5yd short and hangs in
                // the air beside it (the step ended UNDER the ground)
                b.y = heightAt(b.x, b.z);
                predPath.push({x: b.x, y: b.y, z: b.z});
                break;
            }
            b.hit = 1;
            b.y -= d1;  // still climbing: skim up the face and fly on
        }
        d0 = Math.max(d1, 0);
    }
    return b;
}
