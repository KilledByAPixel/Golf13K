'use strict';

/*  RAINBOW GOLF TOUR - swing meter, clubs, ball physics
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
// The 13 IRON is the jam's number in the bag, and being invented it is the
// one club that gets to break the ladder. Every other club is monotonic -
// more loft, less distance - so a club dropped at the 9i/PW midpoint on
// BOTH axes has no character at all; it is just the average of its
// neighbours. So it keeps the midpoint distance (120yd, filling what was a
// 23yd gap, the only real hole in a set otherwise spaced 15-20) and takes
// MORE loft than the PW it outdrives: 41 degrees, launching at 48.
// That makes it the drop-it-on-a-dime club - the highest flight and the
// least roll of anything that reaches past a hundred yards. Physically odd
// for a real bag, which is the joke, and it is the only club whose loft
// does not follow from its number.
// NOTE club gaps do not constrain play here the way they do in real golf:
// the meter dials any distance under a club's max, so what a club really
// chooses is a LAUNCH ANGLE - the arc, the descent and therefore the run.
const CLUB_PUTTER = 10;
const GRAV = 11;         // yards/s^2
// REAL SIZES, then ONE exaggeration. The ball and cup had drifted to 5.6x
// and 8.5x life size independently, so the hole read half again too big FOR
// THE BALL - that mismatch, not the size itself, is what looked wrong. Both
// now come off the same PROP_SCALE, so the cup is always 2.5x the ball
// exactly as in real golf, and one number moves them together.
// Broadcast golf games keep true sizes and use a long lens instead; this
// camera is 87 degrees vertical, about as wide as a lens gets, which is why
// true size read as tiny. MEASURED at 900px tall, and as the share of DEAD
// STRAIGHT putts that drop at 3 / 8 / 15yd:
//        ball across   ball px @16yd  @5yd    straight putts
//   1x     .047yd          1.4          4.4    69% / 36% / 20%
//   2x     .093            2.8          8.8    81% / 53% / 28%
//   3x     .140            4.1         13.2    94% / 60% / 36%   <- here
//   4x     .187            5.5         17.7    98% / 62% / 40%
//   5.6x   .262            7.7         24.7   100% / 66% / 40%  (the old ball)
// The FLAGSTICK is not scaled: at 7ft it is a big object already, and 3x
// would make it a 21ft pole. Exaggerate what is too small to see, not what
// is not.
const PROP_SCALE = 3;
const HOLE_R = .059*PROP_SCALE;   // a 4.25in cup, in yards
const BALL_R = .0233*PROP_SCALE;  // a 1.68in ball
// 2.3, not 2.33: real sizes are not ROUND, and that is what a size pass
// costs in a 13k build - the pin's numbers went from 4 / 1 / .1 / 2 to
// 2.33 / .58 / .058 / 1.17 and cost 7 bytes for digits nobody can see.
// Rounded to a tolerance the eye cannot resolve, they give it back.
// NOT worth doing to HOLE_R and BALL_R though: replacing .059*PROP_SCALE
// with a flat .18 measured +6, because the shared PROP_SCALE token packs
// better than two independent literals.
const POLE_H = 2.3;               // a 7ft flagstick, at life size
// the flagstick's strike radius. Was .2 - wider than the cup reads and
// chunky against a pole DRAWN at .04-.16 (it is distance-compensated);
// Frank called it a bit big even for a helpful obstacle. Ball radius is
// effectively included, so .15 still catches everything but a graze.
const POST_R = .15;
// The cup's LIP: a local height term far finer than the terrain mesh, felt
// by the roll and never drawn. Being a height and not a pull, it composes
// with a green that tilts AWAY from the hole.
// It is DELIBERATELY NOT TIED TO HOLE_R. The lip is not a real object - it
// is the game's forgiveness, invisible and tuned - and it has to be RE-TUNED
// whenever the cup changes size, which is how .3 came to be too generous:
// it was set to rescue a true-size .059 cup, then PROP_SCALE made the cup
// three times bigger and the rescue stayed.
// R is how far the funnel reaches, D how deep. MEASURED against today's
// .177 cup, as make rate on a DEAD STRAIGHT putt at 3 / 8 / 15yd, and the
// total lateral yards you can miss by and still drop:
//   R   D        made              forgiveness
//   .9  .3    94% / 60% / 36%    1.48 / 1.32 / 1.05   (was here)
//   .9  .2    88% / 47% / 36%    1.27 / 1.07 / 0.83   (then here)
//   .6  .2    90% / 47% / 24%     .99 /  .75 /  .70
//   .9  .15   88% / 47% / 28%     .51 /  .50 /  .56
//   none      71% / 38% / 16%     .35 /  .35 /  .34
// NOTE those rows predate the drag/lift flight and the green softening -
// treat them as SHAPE, not truth. RE-MEASURED 2026-08-31 under the
// current physics (exact-pace straight putts, lateral miss tolerance):
//   .9  .2    forgiveness .48 / .44 / .40
//   .9  .1    forgiveness .40 / .40 / .36   <- here (Frank: rescues that
//             "should not have made it" kept dropping; dead-straight
//             putts still make 100%)
// NOTE THE CLIFF between D .2 and .15: the make rate barely moves but
// forgiveness halves. Below about .2 the funnel stops catching a ball that
// would otherwise roll past the cup and only helps one already dropping in,
// so it is two different mechanisms rather than one dial. Reach for LIP_R
// to rein in LONG putts specifically - it is what takes 15yd from 36% to
// 24% while leaving 3yd alone.
const LIP_R = .9, LIP_D = .1;
// how fast the ball may cross the cup and still drop, yards/second
const CUP_SPEED = 8;
// The cup is wider to a ball coming DOWN into it than to one rolling
// across. A chip or a bounce that lands on the rim can drop in, where a
// putt skidding over the same spot would not - and without the extra
// width, chipping in or holing one from the tee is so unlikely it may as
// well be impossible. Applies to every bounce, not just the first.
const AIR_HOLE = HOLE_R*1.8;
const DT = 1/60;         // physics step = one frame
// The wind used to be its own force with its own coefficient, scaled by
// airspeed to imitate the one thing drag does. It is now simply the SPEED
// OF THE AIR, and real drag does the pushing - which is what Frank spotted:
// a wind that pulls a ball along is drag, and half of drag was missing.
// AIR VELOCITY per unit of wind, yards/second. The wind is no longer a
// force with its own coefficient - it is the speed of the air, and drag
// does the pushing. Chosen to reproduce the old model's measured pull:
// the old accel was s*WIND_K*|v| and the new one is DRAG_K*|v|*wv, so
// wv = s*.0055/DRAG_K.
const WIND_V = 1.4;
// Real golf-ball aerodynamics, in yard units. A ball is 45.9g across
// 1.43e-3 m^2, so 0.5*rho*C*A/m works out near .004 for both coefficients
// at the drag and lift numbers a driven ball actually sees (C_d and C_l are
// both about .25). They belong together: drag alone at .004 costs a driver
// 36% of its carry, and lift is what pays that back in the real world.
// LIFT_K is FITTED, not physical, and the fit is the whole trick. Lift
// scales with v^2, so it repays fast clubs more than slow ones, while drag
// costs fast clubs more - the two skews run opposite ways and there is a
// ratio where they cancel and every club loses the SAME share of its carry.
// MEASURED, driver error vs sand wedge error at DRAG_K .004:
//   LIFT_K .0040   -2.1% / -22.5%   spread 23.2pt
//   LIFT_K .0025  -12.0% / -21.4%   spread 13.0pt
//   LIFT_K .0015  -21.4% / -21.1%   spread  4.3pt   <- here
// A uniform loss is what makes ONE compensation constant able to put the
// whole bag back on its labels, which is the only reason the club numbers
// can stay honest with real aerodynamics underneath them.
const DRAG_K = .004, LIFT_K = .0015;
// The launch overshoots by this much so drag can take it back. Sub-linear -
// more speed means more drag - so it is fitted, not derived: 1.27 left every
// club 5-9% short, 1.43 lands the bag inside 4%.
const CARRY_K = 1.43;
const LIFT_SPIN = .001;
// SPIN IS A LAUNCH ANGLE, not a force. Degrees of loft added for backspin
// and taken away for topspin.
// This replaced a gravity bend (SPIN_LIFT) on 2026-08-31. Bending gravity
// changes the ARC and the CARRY together, so backspin flew higher AND
// further and no amount of tuning separated them - it kept coming back as a
// free upgrade, and cancelling the carry with a power penalty flattened the
// arc right back out (MEASURED: apex 19.0 / 18.9 / 18.9, no arc left).
// Loft decouples them for free, because launchVel solves velocity FROM the
// angle to hit the club's stated carry: change the angle and the carry is
// held automatically, while apex = carry*tan(angle)/4 moves a long way.
// MEASURED at 8 degrees, driver, flat and calm - carry / run / apex:
//   back  235.1 /  4.8 / 28.4
//   none  235.5 / 18.1 / 18.9
//   top   236.9 / 40.4 / 10.2
// which is the whole design in one table: land in the same place, then
// stop dead or run away, on a visibly different flight.
const SPIN_LOFT = 8;

// per-surface: [bounce restitution, bounce keep, roll friction, power mult]
// FAIRWAY/TEE .32/.52 is the value the table REALLY holds, on purpose.
// The history reads like a contradiction without the order: on 2026-08-31
// morning these were cut to .22/.30 (under the OLD no-drag flight a
// driver bounce-ran 52yd and finished 22% past the aim ring), and then
// real drag+lift landed the SAME DAY (052f0b5) - landing speed and angle
// changed under every club and the bounce was deliberately refitted BACK
// to .32/.52. Do not "fix" the table toward the cut values; that cut was
// for a flight model that no longer exists. The run table below was
// MEASURED under the OLD model - re-measure (RANGE() + X) before using
// it to tune. 1W / 5i / PW run:
//   .32/.52   52 / 35 / 22   (total 287)  <- here since the refit; the
//                                            old-model numbers, not today's
//   .32/.30   25 / 18 / 11   (total 260)
//   .22/.30   18 / 12 /  7   (total 254)  <- the superseded morning cut
//   .22/.20   11 /  8 /  5   (total 246)
// THE GREEN was softened from .30/.55 on 2026-08-31, once drag and lift
// made approach shots real. It had been BOUNCIER than the fairway, which is
// backwards, and under the new flight a wedge landing on a green ran 15
// yards - further than most greens are deep, so backspin stopped being a
// choice and became compulsory on every approach. MEASURED roll on a green,
// 7i / PW / SW, no spin then backspin:
//   .30/.55   18.7 / 15.5 / 11.9    3.1 / 2.0 / 1.1   (was here) sim +2
//   .26/.45   13.4 / 10.1 /  7.8    2.1 / 1.4 / 0.8   <- here      sim +5
//   .22/.35    8.0 /  6.4 /  4.9    1.3 / 0.8 / 0.5               sim +9
//   .15/.25    3.6 /  3.0 /  2.3    0.6 / 0.4 / 0.2
// .22/.35 is the more realistic green and .26/.45 the safer one: halving
// the roll is what fixes the compulsion, and the rest is firmness taste.
// Receptive, not dead: a mid iron still releases and has to be flown short
// of a back pin, while backspin checks it up inside a yard. Bounce does not
// touch putting - a putt rolls, and roll friction (column 3) is unchanged.
const SURF_PHYS =
[
    [.22,.32,14, .7 ], // rough
    [.32,.52, 6,  1 ], // fairway
    [.26,.45, 3,  1 ], // green
    [.32,.52, 6,  1 ], // tee
    [.05,.20,30, .55], // bunker
    [ 0,  0,  0,  1 ], // water (splash)
    [.25,.45,14,  1 ], // OB
];

let ball = {x:0, y:0, z:0, vx:0, vy:0, vz:0};
let ballAir = 0, ballRolling = 0, bounces = 0;
// The drawn ball's roll angle: 3 radians per yard travelled, accumulated
// forever and never reset - sin and cos wrap, so a shot starting mid-turn
// looks like any other. NOT physical: a real ball is 1/radius = 43 rad/yd,
// which strobes into nonsense at 60fps. 3 reads on the putt cam, where a
// 5yd putt turns about 2.4 times. Frank's knob.
const ROLL_K = 3;
// A driver rolls 3.17 rad in a frame, past Nyquist, so a drive's spin
// aliases. That is FINE and expected (Frank, 2026-08-30) - the ball is
// small, distant and moving; capping it was tried and thrown away.
let ballRoll = 0;
// The heading the ball is ACTUALLY moving on, not shotDir. This is what a
// putt needs: MEASURED over 40 putts, the break pulls the true heading off
// shotDir by a mean 0.7deg in the first quarter of the roll but 8.9deg in
// the last (90th pct 27.5, worst 58) - and the last quarter is exactly when
// the ball is slow, near the putt cam, and being watched.
// Written only while the ball moves, so a ball at rest keeps its last
// heading rather than snapping when its velocity hits exactly zero.
let ballDir = 0;
let pinHit = 0;          // one pin strike per shot, latched (see ballUpdate)
// The pin is PULLED for a shot played from inside 10yd - no post to hit and
// nothing standing over the hole. Decided once in enterAim, not from the
// live ball, or a long approach would lose the pin as it closed in.
let pinOut = 0;
let ballSpin = 0, ballCurve = 0, shotDir = 0;
let treeHit = 0;          // set by flyStep on a tree strike; the HUD clears it
// Frames of tree immunity after a strike - the pin's disease, tree-shaped:
// the reflection sends the ball back across the volume it just hit, every
// crossing is a genuine approach, and the ball ping-pongs in place inside
// a canopy. 8 frames at the reflected tenth-speed is about half a yard,
// enough to fall clear before collision re-arms.
let treeCool = 0;
const TREE_COOL = 8;
// How the shot ended - integers since 2026-08-31 (no player ever sees
// them; the meter codes paid the same day). EV_WATER/EV_OB deliberately
// EQUAL the surface codes, so hazardEnd stores the surface it was handed.
// 0 = the ball is still in motion. Dev tools print names via EV_NAMES.
const EV_HOLED = 1, EV_STOPPED = 2, EV_WATER = SURF_WATER, EV_OB = SURF_OB;
let ballEvent = 0;
let shotStart = {x:0,z:0};// where the shot was played from
let ballSafe = {x:0,z:0}; // last point over safe ground - hazard drop spot

// the ground under the ball, the ball's spot as a record, distance to the pin
const ballGround = ()=> groundAt(ball.x, ball.z);
const ballXZ = ()=> ({x: ball.x, z: ball.z});
const ballToPin = ()=> Math.hypot(ball.x-H.pin.x, ball.z-H.pin.z);

// Closest approach of this step's PATH (x0,z0 -> b) to a point, in 2D.
// The whole segment is tested, not just where it ended: the ball covers
// a quarter of a yard in a rolling step and most of a yard in the air,
// so a position-only test tunnels clean through anything thin. The cup,
// the pin post and every TREE TRUNK all go through here - the trunk used
// to be a position test and had the bulletproof-paper bug the pole never
// did. segT keeps the closest-approach param so a trunk hit can roll the
// ball back to the impact point instead of leaving it out the far side.
let segT = 0;
function pathDist(b, x0, z0, px, pz)
{
    const dx = b.x-x0, dz = b.z-z0, l2 = dx*dx + dz*dz;
    segT = l2 ? clamp(((px-x0)*dx + (pz-z0)*dz)/l2) : 0;
    return Math.hypot(px-x0-dx*segT, pz-z0-dz*segT);
}
const cupHit = (x0, z0, r=HOLE_R)=> pathDist(ball, x0, z0, H.pin.x, H.pin.z) < r;

// ball trail: recent positions with timestamps. The renderer draws a ribbon
// through them whose alpha fades with age, and trailPrune drops expired
// samples - so the trail dies on its own ~1s after the ball stops and
// nothing has to clear it per shot.
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

// Returns an event code when a phase resolves - integers, since no player
// ever sees them (they were strings until 2026-08-31): 0 nothing yet.
const MET_POWER = 1, MET_SWING = 2, MET_CANCEL = 3;
// A CLICK IS READ BEFORE THE CURSOR MOVES, and that ordering is the whole
// contract with the player: the frame was drawn at the end of the previous
// update, so advancing first and sampling after recorded a position one
// step past the one they aimed at. A step is DT/METER_DOWN_TIME = .0208 -
// wider than the sweet spot's whole half-width - so clicking dead centre of
// the painted band scored .0208 LATE and the band's entire lower half could
// not produce a perfect strike at all.
function meterUpdate(clicked, isPutt)
{
    if (meterPhase == 1)
    {
        if (clicked)
        {
            meterPower = meterPos();
            if (isPutt)
            {
                meterPhase = 0;
                meterImpact = 0;
                return MET_SWING;
            }
            // The sweep starts from the power mark and only ever falls.
            // Letting it run back UP to the top when the power was taken on
            // the way down was tried on 2026-08-30 and reverted the same
            // day - Frank: "it feels a little bit weird". It bought a lot of
            // reaction time (.2s -> 1.6s at low power) but the cursor
            // reversing under you does not read as one continuous swing.
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
            // position, so a hit on the way back up is judged by where the
            // cursor LOOKS, and the range stays -METER_OVER..1 either way.
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
    const c = CLUBS[clubI], la = (c[2] + 7 - spin*SPIN_LOFT)*Math.PI/180;
    const v = Math.sqrt(c[1]*CARRY_K*lieMul*GRAV/Math.sin(2*la)*power);
    b.vx = Math.sin(dir)*Math.cos(la)*v;
    b.vy = Math.sin(la)*v;
    b.vz = Math.cos(dir)*Math.cos(la)*v;
    return b;
}

// every shot: remember where it was played from, reset the flight state
// every shot starts here, so shotDir is set here: a putt used to leave it
// holding the last full shot's heading, which the trail, the curve and now
// the putt camera all read
function shotBegin(air, dir)
{
    shotStart = ballSafe = ballXZ();
    ballAir = air; ballRolling = !air; bounces = 0; pinHit = 0; treeCool = 0; ballEvent = 0;
    shotDir = dir;
}

function launchBall(clubI, power, impact, spin, dir, lieMul)
{
    // snap tiny errors to perfect, scale the rest
    const err = Math.abs(impact) < .02 ? 0 : impact;
    // A miss either way loses power, and TOPSPIN gives some up on purpose:
    // the loft change alone holds every carry equal, and Frank wants topspin
    // to buy its roll rather than be handed it. MEASURED on hole 1 at 6%,
    // carry / roll: back 237.7 / 4.9, none 239.7 / 18.8, top 226.9 / 44.4 -
    // so it trades 13yd of flight for 26yd of run. Do not push it to 10%:
    // topspin's total falls back level with no spin and the trade vanishes.
    power *= 1 - Math.max(err, -err)*.35; // a miss either way loses power
    dir += err*.05;     // push/pull
    ballCurve = err*22; // hook/slice curve accel
    ballSpin = spin;
    shotBegin(1, dir);
    // spin goes in as LOFT, so the carry is held and only the arc moves
    launchVel(ball, clubI, dir, lieMul, Math.max(.05, power), spin);
    ball.y = ballGround().h + .1;
    return err;
}

// a putt is asked for in YARDS: rolling distance is v^2/2f, so this is the
// one place that conversion lives - and the meter stays linear in yards
// (as a speed fraction, half a meter reached a quarter of the target).
// b = the ball, or the putt preview's scratch copy
function puttVel(b, dist, dir)
{
    // Speed is worked out against the GREEN's friction whatever the ball is
    // sitting in, so "8 yards" always means 8 yards of green roll. Using the
    // CURRENT lie made the number a lie: 8yd of rough speed carries far
    // further once the ball crosses onto grass 4.7x slicker. Now a putt out
    // of rough travels LESS than asked and the player adds power.
    const v = Math.sqrt(6*dist)*1.02;
    b.vx = Math.sin(dir)*v;
    b.vz = Math.cos(dir)*v;
    b.vy = 0;
    return b;
}

function launchPutt(dist, dir)
{
    ballSpin = ballCurve = 0; // a lip-out flies; no stale spin or curve there
    shotBegin(0, dir);
    puttVel(ball, dist, dir);
}

///////////////////////////////////////////////////////////////////////////////
// simulation

// Trunk collision radius as a fraction of tree size. The DRAWN trunk is
// .3*s at the base tapering to .22*s at the top, and collision must sit
// on the FORGIVING side of what the eye sees - the old sqrt(.1) = .316
// was a shade over the drawn base and read as unfair. The C debug view
// draws this same number, so what it shows is what the ball hits.
const TRUNK_R = .22;

// one step of flight for b (the ball, or predictLanding's scratch copy):
// gravity, wind, and the hook/slice curve across the shot direction. Spin
// does not appear here - it is baked into the launch angle (see SPIN_LOFT)
function flyStep(b, curve)
{
    // Velocity RELATIVE TO THE AIR, which is the only thing either force
    // acts on. Wind is a real air velocity now, so one pair of terms does
    // every job at once: drag slows the ball in still air, drags it toward
    // the air when the air is moving, and lift holds it up.
    const ry = b.vy, wv = H.wind.s*WIND_V;
    const rx = b.vx - Math.sin(H.wind.a)*wv, rz = b.vz - Math.cos(H.wind.a)*wv;
    const sp = Math.hypot(rx, ry, rz), vh = Math.hypot(rx, rz) || 1;
    const d = DRAG_K*sp*DT;
    // LIFT is perpendicular to the airflow in the vertical plane, and it is
    // what backspin physically buys - a longer float and a steeper finish.
    // Topspin subtracts it. This is the real mechanism SPIN_LOFT was faking.
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
    for (const t of H.near)
    {
        const dx = b.x-t.x, dz = b.z-t.z, dy = b.y-t.y, r2 = dx*dx+dz*dz, s2 = t.s*t.s;
        // only a ball moving INTO the volume is stopped (the dot uses the
        // START of the step, like the pin's). A ball already inside one
        // (it came to rest against the trunk) has to be able to leave:
        // otherwise every shot from there dies on its first step and the
        // ball creeps a few inches a stroke until the mercy rule.
        // The CANOPY keeps a position test - a step is under 1.2yd and the
        // sphere at least 2 across, so only a shallow graze can slip by.
        // The TRUNK sweeps through pathDist exactly like the pin post, or
        // a flight step tunnels clean through it (bulletproof paper) -
        // then rolls back to the impact point, or a detected hit would
        // still leave the ball out the far side of the tree.
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
    const cx = b.x-H.pin.x, cz = b.z-H.pin.z, cd = Math.hypot(cx, cz);
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
        // THE PIN, a thin post the ball can clatter off. Only a ball still
        // IN THE AIR can hit it: one reaching the ground is the cup's
        // business, which is why a chip-in is never knocked away and no
        // "was it going in" flag is needed. cupHit sweeps the whole step
        // PATH - at flight speed a step is most of a yard, so a position
        // test would tunnel through a .2yd post. The dot product uses the
        // position BEFORE the step, so a ball at REST against the post
        // cannot kill its own first step.
        if (ball.y > g.h)
        {
            // ...and only up the DRAWN stick: the window was g.h+3 while
            // the pole is 2.3 tall, so 0.7yd of invisible pole struck balls
            if (!pinHit && !pinOut && ball.y < g.h + POLE_H && cupHit(x0, z0, POST_R)
                && (x0-H.pin.x)*ball.vx + (z0-H.pin.z)*ball.vz < 0)
            {
                // ONCE PER SHOT: the ball tunnels through, reflects onto the
                // far side and crosses back, and every crossing is a genuine
                // approach the dot product cannot reject. Four passes took
                // 40% of the speed each and it dropped down the stick.
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
            // straight in off the flight. No speed limit here: a shot
            // arrives far faster than a putt may cross the cup, so without
            // this a hole in one could never happen at all.
            ballAir = 0;
            ballEvent = EV_HOLED;
            return;
        }
        const P = SURF_PHYS[g.s];
        if (ball.vy >= 0)
        {
            // flew into a rising slope while still climbing: reflect off
            // the slope normal (-gx, 1, -gz). A height field must never be
            // tunnelled - balls used to sail under hills into the water.
            // A hill smack IS a bounce, so it scrubs with the surface keep
            // and counts toward the first-bounce spin bite: the reflection
            // alone kept the whole tangential velocity, so a flat topspin
            // drive banked off a steep face, popped into the air and
            // finished PAST its flat-ground total - then collected its
            // x1.7 topspin keep at the eventual landing on top of that
            const [gx, gz] = slopeAt(ball.x, ball.z);
            const k = (ball.vy - ball.vx*gx - ball.vz*gz)/(gx*gx + 1 + gz*gz)*(1 + P[0]);
            if (k < 0)
            {
                ++bounces;
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
            // spin bites on first bounce
            // Bite on the first bounce. One symmetric number: raising it
            // stops backspin harder AND lets topspin run further, so .7 is
            // where the three totals sit closest (295/286/294).
            keep *= 1 + ballSpin*.7;
            if (g.s == SURF_GREEN && ballSpin < 0)
            {
                // backspin sucks back
                ball.vx += Math.sin(shotDir)*ballSpin*7;
                ball.vz += Math.cos(shotDir)*ballSpin*7;
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
            // hops out instead of gliding across, which reads as a lip-out
            // bounces is NOT reset here: it tells the pin this ball is no
            // longer on its approach. Resetting re-armed the post every pass
            // and a fast putt rattled 34 times before holing.
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
    for (let i=CLUBS.length-2; i >= 0; --i)
        if (CLUBS[i][1] >= d + 2 || !i)
            return i;
}

// The full flight, integrated. It no longer feeds the aim: the ring marks
// where you AIMED, at shotTarget yards, and reading the wind is the player's
// job (Frank, 2026-08-30). Only the debug arc calls this now, so the release
// build drops it and everything below it that nothing else uses.
// The flight path predictLanding just walked, sampled - debug only, and the
// arc it draws is the SAME integrator the ball will fly, so it cannot
// disagree with the shot the way a separate approximation would.
let predPath = [];
function predictLanding(clubI, dir, spin, lieMul, power=1)
{
    // start from heightAt, NOT ballGround: a bunker's groundAt is .5yd
    // below the terrain (the scoop) while the loop below ends against
    // heightAt, so a sand shot began already under its own finish line and
    // the ring stuck to the ball
    const b = launchVel({x: ball.x, y: heightAt(ball.x, ball.z) + .1, z: ball.z}, clubI, dir, lieMul, power, spin);
    // SEED IT AT THE BALL. The loop below samples every fifth step and 599
    // is not a multiple of 5, so the first point it caught was four steps
    // out - about 4yd on a driver - and the ribbon visibly started in mid
    // air ahead of the ball.
    debug && PRED_ARC && (predPath = [{x: b.x, y: b.y, z: b.z}]);
    let d0 = .1; // height above the ground, carried from the last step
    for (let i=600; i--;)
    {
        const x0 = b.x, z0 = b.z;
        debug && PRED_ARC && !(i%5) && predPath.push({x: b.x, y: b.y, z: b.z});
        flyStep(b, 0);
        const d1 = b.y - heightAt(b.x, b.z);
        if (d1 <= 0)
        {
            // ONLY A DESCENDING BALL HAS LANDED. Clipping a rise on the way
            // UP is not a landing - ballUpdate reflects off the slope and
            // carries on over it. Ending on any contact put the ring at the
            // player's feet whenever they aimed up a slope.
            if (b.vy < 0)
            {
                // Land where the step CROSSED the ground, not at the end of
                // it. A step is over half a yard at landing speed, so
                // stopping at its end made the ring snap by that much
                // whenever the step count changed - which is every few
                // frames while turning.
                const t = d0/(d0 - d1);
                b.x = lerp(x0, b.x, t);
                b.z = lerp(z0, b.z, t);
                break;
            }
            b.y -= d1;  // still climbing: skim up the face and fly on
        }
        d0 = Math.max(d1, 0);
    }
    return b;
}
