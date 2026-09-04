'use strict';

/*  SUNSHINE GOLF CLASSIC - game flow and input
    States: TITLE, INTRO (3d flyback: green -> tee), AIM (tee or landing
    preview cam), SWING (meter), FLIGHT (chase cam), HOLEOUT.
    The 2D overlay lives in hud.js; everything else renders in the 3d view. */

const ST_TITLE=0, ST_INTRO=1, ST_AIM=2, ST_SWING=3, ST_FLIGHT=4, ST_HOLEOUT=5;

const CLASSIC_SEED = 1113;

let state = ST_TITLE, stateTime = 0;
let courseRows, courseSeed = CLASSIC_SEED, remixMode = 0;
let holeIndex = 0, strokes = 0, scores = [];
let aimYaw = 0, clubI = 0, eventWait = 0;
let msgText = '', msgTimer = 0, niceShot = 0;
let spinMode = 0;                       // the spin chip: -1 back, 0 none, 1 top

// Where the shot is predicted to stop, and the yards to it. ONE simulation
// feeds every aim aid (predPath line, ring, printed yards), so none disagree.
let predLand = {x:0, z:0}, predDist = 0;
let placeView = 0, turnHold = 0;        // preview cam on?, turn-accel counter

// Frames the camera holds still after a swing before it starts chasing.
const CAM_HOLD = 9;
// Frames to EASE OUT of the flight camera once a shot settles. ONLY a settled
// shot eases; every deliberate view change (intro, skip, preview, resume) cuts.
const SETTLE_T = 45;
let camFrom = [], camEase = SETTLE_T;   // pose at the last settle, frames since

// The round in progress as localStorage holds it, or undefined. Written from
// enterAim, so the save point is EVERY SHOT rather than every hole.
let savedGame = localStorage['sg_save'];

// (dev-only state - autoPlay, freeCam, telemetry - lives in debugGame.js)

///////////////////////////////////////////////////////////////////////////////
// helpers

const clickPressed = ()=> mouseWasPressed(0) || keyWasPressed('Space')
    || debug && padClick(); // pad A (debugGame.js) - the ONLY pad hook in the
    // shipped files, since the meter reads this; the rest of what the pad
    // does is devUpdate calling the game's own functions

function setState(s) { state = s; stateTime = 0; }

function showMsg(t) { msgText = t; msgTimer = 99; }

function aimAtPin() { aimYaw = Math.atan2(hole.pin.x-ball.x, hole.pin.z-ball.z); }

// The default aim: the PIN when this club can plausibly reach it (its max from
// this lie plus 20yd of roll grace), otherwise a LAYUP down the fairway one
// carry ahead - dead at the pin points a bent hole's tee shot into the woods.
// A putt always passes the first test (PUTT_MAX; autoClub putts inside 19yd).
function aimDefault()
{
    const reach = targetMax();
    if (ballToPin() < reach + 20)
        return aimAtPin();
    distToPath(ball.x, ball.z); // sets lastAlong
    const t = pathPointAt(Math.min(lastAlong + reach*.95, hole.len));
    aimYaw = Math.atan2(t.x-ball.x, t.z-ball.z);
}

const SPIN_NAMES = ['BACKSPIN', 'NO SPIN', 'TOPSPIN']; // indexed by spin+1
// What the lie costs this club, decided in ONE place: targetMax and launchBall
// both read it, so the meter promises what the ball delivers. In sand a wedge
// skids where an iron digs; PW (8) and SW (9) are the wedges, hence `clubI < 8`.
const lieMul = ()=> SURF_PHYS[ballGround().s][3] * (ballGround().s == SURF_BUNKER && clubI < 8 ? .3 : 1);

///////////////////////////////////////////////////////////////////////////////
// THE TARGET. The meter is scaled to it - the bar's top IS shotTarget yards -
// so nothing else ever converts between "power" and "distance".

let shotTarget;

// The longest this club can hit from this lie. The putter is a flat PUTT_MAX:
// what a lie costs a putt depends on how far it rolls through it, which a
// scale cannot know, so the prediction rolls it over the real ground instead.
const targetMax = ()=> clubI == CLUB_PUTTER ? PUTT_MAX : CLUBS[clubI][1]*lieMul();
const setTarget = (d)=> shotTarget = clamp(d, 5, targetMax());

// Yards per chip click and per wheel notch. 1 is the floor: the chip prints
// whole yards, so a finer step buys clicks that leave the number where it was.
const TARGET_STEP = 1;

// THE DEFAULT TARGET, and the one fudge in the game: wind has an arrow but
// ELEVATION has no cue, so a full shot adds 1.95yd of carry per yard of climb
// (a fit over reachable tee shots; calm-air error 14.4yd rms down to 2.3).
// A PUTT takes no climb term - rollStep already rolls the slope, so it would
// double-count - and aims PUTT_OVER past the cup instead (golfSim.js).
const resetTarget = ()=> setTarget(clubI == CLUB_PUTTER ? ballToPin()*PUTT_OVER
    : ballToPin() + (hole.greenH - ballGround().h)*1.95);

// meter fraction -> launchBall power, so a full meter delivers exactly shotTarget
const shotPower = (mp)=> Math.min(1, mp*shotTarget/targetMax());

const parTotal = (n)=> courseRows.slice(0, n).reduce((t, row)=> t + row[0], 0);
const scoreTotal = ()=> scores.reduce((a, b)=> a+b, 0);
// score against par in golf's own shorthand: E for level, else signed
const relPar = (d)=> d ? (d>0?'+':'')+d : 'E';

const SCORE_NAMES = ['🦄 ALBATROSS!','🦄 EAGLE!','🌈 BIRDIE!','PAR','BOGEY','DOUBLE BOGEY'];
function scoreName(strokes, par)
{
    return strokes - 1 ? SCORE_NAMES[clamp(strokes-par+3, 0, 5)] : '🦄 HOLE IN ONE!';
}

///////////////////////////////////////////////////////////////////////////////
// flow

// REMIX is the classic 18 RE-DEALT: genCourse shuffles the same hand-tuned
// rows under a fresh seed, which also re-rolls every hole's land.
function startCourse(remix)
{
    remixMode = remix;
    courseSeed = remix ? randInt(9,2e6): CLASSIC_SEED;
    courseRows = genCourse(courseSeed, remix);
    holeIndex = 0;
    scores = [];
    debug && tlog('round', {mode: remix ? 'remix' : 'classic', seed: courseSeed});
    startHole();
    saveGame();
}

// w = the wind restored from a save. It MUST be set before buildWorld: the
// foliage sway is baked into the leaf alpha from hole.wind.s.
function startHole(w)
{
    genHole(courseSeed, holeIndex, courseRows[holeIndex]);
    if (w) hole.wind = w;
    glContext && buildWorld();
    ball.y = ballGround().h;
    // the tee is the origin
    ball.x = ball.z = ball.vx = ball.vy = ball.vz = strokes = 0;
    trail = [];
    setState(ST_INTRO);
}

// Everything needed to resume. The trailing '' matters: without it savedGame
// holds an ARRAY while localStorage holds a string, and split() throws.
// NOT called from startHole - gameInit calls that for the title backdrop and
// would overwrite the real save on every load. AI TEST MODE NEVER WRITES: the
// save goes out every shot, so the bot would grind a real round away.
const saveGame = ()=> debug && autoPlay ? 0 :
    localStorage['sg_save'] = savedGame =
    [courseSeed, holeIndex, hole.wind.a, hole.wind.s,
     ball.x, ball.z, strokes, ...scores] + '';

// Predict the shot the meter promises. shotTarget is the INPUT (it scales the
// meter, so the power); everything on screen is an OUTPUT of this one
// simulation. Every club: predictLanding rolls a putt too, so putting has no
// aim code. MUST STAY EXACT: predLand feeds the ring, line end, cup marker
// and printed yards, and the marker divides by predDist, so a lerp here comes
// out MULTIPLIED and sweeps the bar. Smooth at a consumer, never here.
function updatePredict()
{
    predLand = predictLanding(clubI, aimYaw, spinMode, lieMul(), shotPower(1));
    predDist = Math.hypot(predLand.x-ball.x, predLand.z-ball.z);
}

function enterAim()
{
    // the one cut worth easing: the ball has stopped and the eye is still on it
    if (state == ST_FLIGHT)
        camFrom = [camX, camY, camZ, camYaw, camPitch], camEase = 0;
    hideTrees();    // once per shot, so rotating the aim stays smooth
    // pin out on the green only: a chip from sand or rough wants it to rattle off
    pinOut = ballToPin() < 15 && ballGround().s == SURF_GREEN;
    meterPhase = 0; // Escape mid-sweep otherwise leaves a stale power mark
    spinMode = 0;   // spin is per shot, not a setting to be left switched on
    clubI = autoClub();
    aimDefault();
    resetTarget();
    updatePredict();
    saveGame();     // every AIM, so quitting mid-hole resumes mid-hole
    placeView = 0;
    setState(ST_AIM);
}

// every flight starts from the swing camera, even after a swing from the preview
function startFlight()
{
    placeView = 0;
    setSwingCam(aimYaw);
    eventWait = 0;
    // a putt is all roll: its carry starts at zero, no touchdown ever comes
    carryDist = clubI == CLUB_PUTTER ? 0 : -1;
    setState(ST_FLIGHT);
}

function endHole()
{
    scores[holeIndex] = strokes;
    debug && tlog('hole', {par: hole.par, len: hole.len|0, score: strokes - hole.par,
        name: scoreName(strokes, hole.par)});
    debug && autoPlay && console.log(`RESULT hole ${holeIndex+1} par ${hole.par} strokes ${strokes}`);
    showMsg(scoreName(strokes, hole.par));
    // ONE sound: the fanfare REPLACES the cup rattle under par, so which one
    // you hear is itself the result. (Also fires on a max-strokes pickup.)
    (strokes < hole.par ? snd_fanfare : snd_hole).play();
    setState(ST_HOLEOUT);
}

function nextHole()
{
    if (++holeIndex >= 18)
    {
        debug && autoPlay && console.log(`RESULT total ${scoreTotal()} par ${parTotal(18)}`);
        // Stored OVER OR UNDER PAR, not as a stroke total: a remix course
        // need not share the classic 18's par, so totals are not comparable.
        const key = (remixMode ? 'sg_best_r' : 'sg_best_c');
        const rel = scoreTotal() - parTotal(18);
        const best = localStorage[key];
        if (!best || rel < best)
            localStorage[key] = rel;
        // nothing left to continue; '' is falsy, so it reads like an absent key
        localStorage['sg_save'] = savedGame = '';
        // no results state: hole 18's card IS the results card
        setState(ST_TITLE);
    }
    else
    {
        startHole();
        saveGame();
    }
}

///////////////////////////////////////////////////////////////////////////////
// per-state updates

// The title menu. CONTINUE greys out with no save, REMIX until it is unlocked.
const MENU = ['CONTINUE', 'CLASSIC', 'REMIX'];
// one ROW of three, centred, near the bottom of the screen
function menuRect(i)
{
    const W = mainCanvasSize.x, T = mainCanvasSize.y;
    const w = W*.3, h = T*.18;
    return {x: (W-w)/2 + (i-1)*w*1.1, y: T*.8, w, h};
}
// the button under p: 1 CONTINUE, 2 CLASSIC, 3 REMIX, 0 none
function menuAt(p)
{
    for (let i=3; i--;)
    {
        const r = menuRect(i);
        if (p.x > r.x & p.x < r.x+r.w & p.y > r.y & p.y < r.y+r.h)
            return i+1;
    }
    return 0;
}

function continueGame()
{
    const s = savedGame.split(',').map(Number);
    courseSeed = s[0];
    remixMode = courseSeed != CLASSIC_SEED;
    holeIndex = s[1];
    scores = s.slice(7);
    courseRows = genCourse(courseSeed, remixMode);
    startHole({a: s[2], s: s[3]});
    // startHole tees the ball and zeroes the card, so the shot in progress is
    // put back AFTER it. y is not stored - the terrain is the same terrain.
    ball.x = s[4];
    ball.z = s[5];
    ball.y = ballGround().h;
    strokes = s[6];
    // MID-HOLE skips the flyback - it ends at the tee, where the ball is not
    strokes && enterAim();
}

// The round is over but its card still recoverable: nextHole leaves holeIndex
// past the end with every score in memory, so CONTINUE re-opens the scorecard
// (renderScorecard reads this for the reviewing mood). Lasts only as long as
// the tab: a reload reads holeIndex from the save the round's end cleared.
const roundOver = ()=> holeIndex > 17;

function updateTitle()
{
    menuPick(mouseWasPressed(0) ? menuAt(mousePosScreen) : 0);
}

// b: 1 CONTINUE, 2 CLASSIC, 3 REMIX, 0 nothing. Split out so the gamepad
// (debugGame.js) picks from the same place: the remix lock and the abandon
// confirm live here only.
function menuPick(b)
{
    // CONTINUE resumes a save, or puts a finished round's card back up at once
    if (b == 1)
        savedGame ? continueGame()
            : roundOver() && (setState(ST_HOLEOUT), stateTime = CARD_T);
    // REMIX is locked until classic is beaten at PAR OR BETTER: bests are stored
    // OVER par, so `<= 0` is the whole test (undefined <= 0 is false too)
    else if (b && (b < 3 || localStorage['sg_best_c'] <= 0))
        startCourse(b-2);
}

// Flyback length in fixed updates, THE PULLBACK SPEED KNOB. The move eases in
// and out (smoothStep), so judge the speed mid-move. A click skips it
// regardless, and the bot cuts it at 30 frames.
const INTRO_T = 400;
// max intro-camera DESCENT, yards per fixed update (9yd/s); rising is unlimited
const INTRO_FALL = .15;

function updateIntro()
{
    // Solve the aim on frame 1 so the flyback ENDS where the aim will be. State
    // is restored by hand: setState would zero stateTime and re-trigger every
    // frame. enterAim's save write is safe: gameInit's backdrop goes straight
    // to ST_TITLE.
    if (stateTime == 1)
        enterAim(), state = ST_INTRO, stateTime = 1;
    if (clickPressed() || stateTime > (autoPlay ? 30 : INTRO_T + 30))
        enterAim();
}

// meter geometry, shared by render and the click-to-swing hit test
function meterRect()
{
    const W = mainCanvasSize.x, T = mainCanvasSize.y;
    const bw = Math.min(W*.9, T*1.1), bh = T*.05; // (W*.9: phones in portrait)
    return {bx: (W-bw)/2, by: T*.85, bw, bh};
}

function mouseOverMeter()
{
    const m = meterRect();
    return mousePosScreen.x > m.bx - m.bh && mousePosScreen.x < m.bx + m.bw + m.bh
        && mousePosScreen.y > m.by - m.bh/2 && mousePosScreen.y < m.by + m.bh*1.5;
}

// on-screen turn arrow hit test: -1 left, 1 right, 0 neither
function turnBtnAt(p)
{
    const W = mainCanvasSize.x, T = mainCanvasSize.y, s = T*.09, ax = arrowX();
    // MUST return a number on every path: an undefined outside the band makes
    // `dir = turnBtnAt(..) - keyIsDown(..)` NaN and poisons aimYaw. `&&`
    // yields false there, which is arithmetic 0 at the call site.
    return (p.y > T/2 - s*1.4 & p.y < T/2 + s*1.4)
        && (p.x > W - ax - s) - (p.x < ax + s);
}

function updateAim()
{
    // turn: hold the on-screen arrows (or arrow keys), accelerating
    const dir = (mouseIsDown(0) ? turnBtnAt(mousePosScreen) : 0)
        - (keyIsDown('ArrowLeft') || keyIsDown('KeyA')) + (keyIsDown('ArrowRight') || keyIsDown('KeyD'));
    turnHold = dir && ++turnHold;
    aimYaw += dir * (Math.min(turnHold/1e4, .005));
    // Keyboard: arrows/WASD turn, up/down = club (classic PC golf). Everything
    // else is the wheel and the chips - the game assumes a mouse or touch.
    const dc = (keyWasPressed('ArrowDown') || keyWasPressed('KeyS')) - (keyWasPressed('ArrowUp') || keyWasPressed('KeyW'));
    if (dc)
    {
        clubI = clamp(clubI + dc, 0, CLUBS.length-1);
        resetTarget();
        snd_adjust.play();
    }
    // wheel = distance, putts included
    if (mouseWheel)
    {
        setTarget(shotTarget - mouseWheel*TARGET_STEP);
        snd_adjust.play();
    }

    updatePredict();

    if (autoPlay)
    {
        // The bot LINES UP here and swings SETTLE_T later, so this is the
        // pause before it takes aim, not before it hits: 15 + the 45 frame
        // ease is a full second in all, and the view arrives on the aim
        // before the ball leaves rather than with it.
        if (stateTime > 15) botSwing();
        return;
    }
    // the chips above the meter (club / spin / distance), then the meter
    // (or Space) to swing; any other click toggles the landing preview
    const btn = mouseWasPressed(0) ? meterBtnAt(mousePosScreen) : 0;
    if (btn == 3)
        clubI == CLUB_PUTTER || cycleSpin(); // still no spin on a putt
    else if (btn)
    {
        if (btn < 3)
        {
            clubI = mod(clubI + btn*2-3, CLUBS.length);
            resetTarget();
        }
        else
            setTarget(shotTarget + (btn*2-9)*TARGET_STEP);
        snd_adjust.play();
    }
    // The pad's A is named HERE as well as in clickPressed: starting the meter
    // is the one click the game does not route through it.
    else if (keyWasPressed('Space') || (mouseWasPressed(0) && mouseOverMeter())
        || debug && padClick())
    {
        snd_adjust.play();
        meterStart();
        setState(ST_SWING);
    }
    else if (mouseWasPressed(0) && !turnBtnAt(mousePosScreen))
    {
        placeView = !placeView, camEase = SETTLE_T; // (putts too, zoomed in)
        snd_tick.play();
    }
}

function cycleSpin()
{
    spinMode = spinMode < 0 ? 1 : spinMode-1; // none -> back -> top -> none
    snd_adjust.play();
}

// turn arrow inset (render + hit tests); the minimum keeps them on screen on phones
const arrowX = ()=> Math.max(mainCanvasSize.x*.06, mainCanvasSize.y*.06);

// the three tap chips above the meter bar: [club] [spin] [distance]
function meterBtns()
{
    const {bx, by, bw, bh} = meterRect();
    return {y: by - bh*2.7, h: bh*1.5, w: bw*.3, xs: [bx, bx + bw*.35, bx + bw*.7]};
}

// chip hit test: 0 none, 1 club-, 2 club+, 3 spin, 4 dist-, 5 dist+
function meterBtnAt(p)
{
    const {y, h, w, xs} = meterBtns();
    if (state != ST_AIM | p.y < y | p.y > y + h) return 0;
    for (let i=3; i--;)
    {
        const dx = p.x - xs[i];
        if (dx >= 0 & dx <= w)
            return i == 1 ? 3 : (i>>1)*3 + 1 + (dx > w/2);
    }
    return 0;
}

function updateSwing()
{
    const isPutt = clubI == CLUB_PUTTER;
    const ev = meterUpdate(clickPressed());
    if (ev == MET_CANCEL)
        setState(ST_AIM);
    else if (ev == MET_POWER)
        snd_tick.play();
    else if (ev == MET_SWING)
    {
        ++strokes;
        niceShot = 0;
        // logged before the launch, from the lie and distance the shot was played from
        debug && tlog('shot', {
            club: CLUBS[clubI][0], lie: SURF_NAMES[ballGround().s],
            toPin: ballToPin()|0, target: shotTarget|0, power: +meterPower.toFixed(2),
            impact: +meterImpact.toFixed(3), spin: spinMode,
            wind: +hole.wind.s.toFixed(1), windDir: +(hole.wind.a - aimYaw).toFixed(2)});
        // ONE LAUNCH for every club; only the sound knows a putt from a drive
        const err = launchBall(clubI, shotPower(meterPower), meterImpact, spinMode, aimYaw, lieMul());
        isPutt ? snd_putt.play(.4 + meterPower*.6)
               : snd_tee.play(.4 + meterPower*.6, .8 + meterPower*.4);
        // THE VERDICT rides on the SECOND click: the three names are launchBall's
        // three bands - err snapped to exactly 0 (so `!err` needs no abs), under
        // .06, the rest. Power earns nothing, or PERFECT is unreachable on a
        // layup. A PUTT IS JUDGED SILENTLY: hook and slice are flight words and a
        // fanfare over a tap-in shouts about nothing (niceShot stays 0: plain trail).
        if (!isPutt)
        {
            if (!err)
            {
                niceShot = 1;
                snd_nice.play();
            }
            showMsg(!err ? 'PERFECT!' : Math.abs(err) < .06 ? 'GOOD'
                : err > 0 ? 'SLICE!' : 'HOOK!');
        }
        startFlight();
    }
}

function updateFlight()
{
    if (!ballEvent)
    {
        const rx = ball.x, rz = ball.z;
        for (let k = fastMode ? 6 : 1; k-- && !ballEvent;)
            ballUpdate();
        // measured out here, not in ballUpdate; a frame of travel is straight enough
        const dx = ball.x-rx, dz = ball.z-rz, d = Math.hypot(dx, dz);
        d && (ballDir = Math.atan2(dx, dz));
        ballRoll += d*ROLL_K;
        // Latch the carry at the FIRST TOUCHDOWN (the bounce counter), NOT
        // `!ballAir`, which stays set through every bounce. A putt never bounces.
        if (debug && bounces && carryDist < 0)
            carryDist = Math.hypot(ball.x-shotStart.x, ball.z-shotStart.z);
        if (treeHit)
        {
            showMsg('TREE!');
            treeHit = 0;
            debug && tlog('tree', {});
        }
        trailPush(time);
    }
    else if (ballEvent == EV_HOLED && eventWait < 14)
    {
        // the ball rolls over and drops down into the cup
        ++eventWait;
        ball.x += (hole.pin.x-ball.x)*.3;
        ball.z += (hole.pin.z-ball.z)*.3;
        ball.y -= .035;
    }
    // A HOLED ball has had its beat in the 14-frame drop above, so the fanfare
    // follows at once (water and OB play theirs at eventWait == 1)
    else if (++eventWait > (fastMode ? 8 : ballEvent == EV_HOLED ? 16 : 50))
    {
        // resolve the shot result after a beat
        const ev = ballEvent;
        ballEvent = 0;
        if (debug)
        {
            // CARRY is where it first came down (what clears a hazard), TOTAL
            // where it stopped (what the meter promised); the ROLL is what spin buys
            const dist = Math.hypot(ball.x-shotStart.x, ball.z-shotStart.z);
            // still -1 = never touched down, straight into the cup: all carry
            const carry = carryDist < 0 ? dist : carryDist;
            tlog('land', {ev: EV_NAMES[ev || EV_STOPPED], lie: SURF_NAMES[ballGround().s],
                toPin: ballToPin()|0, carry: carry|0, total: dist|0});
            console.log(`SHOT ${strokes} ${CLUBS[clubI][0]}`
                + ` ${SPIN_NAMES[spinMode+1]}:`
                + ` carry ${carry|0}yd, roll ${dist-carry|0}yd,`
                + ` total ${dist|0}yd for ${shotTarget|0}yd asked`
                + ` - ${EV_NAMES[ev || EV_STOPPED]} in the ${SURF_NAMES[ballGround().s]}`
                + `, ${ballToPin()|0}yd to pin`);
        }
        if (ev == EV_HOLED)
            return debug && puttMode ? puttDrop() : endHole();
        if (ev >= EV_WATER) // the two hazard codes ARE the surface codes
        {
            // penalty: drop at the hazard edge, nudged back toward the shot
            ++strokes;
            showMsg(ev == EV_WATER ? 'SPLASH! +1' : 'OUT OF BOUNDS! +1');
            const dx = shotStart.x-ballSafe.x, dz = shotStart.z-ballSafe.z;
            const dl = Math.hypot(dx, dz) || 1;
            // WALK BACK along the shot until the ball can actually STAY:
            // safe surface AND flat enough for friction to beat the slope,
            // which is rollStep's resting rule. ballSafe is the last point
            // over SAFE ground, and at a green with a lake at its rim that is
            // the bank - a fixed step back leaves the ball on a slope that
            // feeds it straight back in, and the penalty repeats to MAX
            // STROKES. The walk STOPS AT shotStart (dl is the distance to it):
            // the ball was at rest there, so it is the one spot guaranteed to
            // hold, and it is stroke-and-distance when the line back crosses
            // the water - an island green has no land between.
            for (let d = 2; ; d += 2)
            {
                const t = Math.min(d, dl);
                ball.x = ballSafe.x + dx/dl*t;
                ball.z = ballSafe.z + dz/dl*t;
                const g = ballGround();
                ball.y = g.h;
                if (t == dl || g.s < SURF_WATER
                    && Math.hypot(...slopeAt(ball.x, ball.z))*GRAV < SURF_PHYS[g.s][2])
                    break;
            }
        }
        if (strokes >= hole.par+5)
        {
            // mercy pickup, announced so it doesn't feel like a bug
            endHole();
            showMsg('MAX STROKES!');
            return;
        }
        enterAim();
    }
    else if (eventWait == 1)
    {
        if (ballEvent == EV_WATER) snd_splash.play();
        if (ballEvent == EV_OB) snd_ob.play();
    }
}

// hole-out: banner + confetti, then at CARD_T the scorecard, which waits for a click
const CARD_T = 80;
function updateHoleOut()
{
    // THE LAST CARD HOLDS A SECOND LONGER before it takes a click: it is the
    // round's result with no screen behind it, and a click still in flight from
    // the banner must not throw it away. Only the dismiss waits; hud.js draws
    // the card at CARD_T on its own test. The bot uses its own 40-frame clock.
    if (stateTime > (holeIndex > 16 ? 140 : CARD_T) && clickPressed()
        || autoPlay && stateTime > 40)
        nextHole();
}

///////////////////////////////////////////////////////////////////////////////
// engine callbacks

function gameInit()
{
    // Title backdrop: the saved hole, on its own seed. |0 rather than +, so a
    // corrupt save cannot take the game down at STARTUP.
    if (savedGame)
    {
        const v = savedGame.split(',');
        courseSeed = v[0]|0;
        remixMode = courseSeed != CLASSIC_SEED;
        holeIndex = v[1]|0;
    }
    courseRows = genCourse(courseSeed, remixMode);
    startHole();
    setState(ST_TITLE);

    debug && devInit(); // debugGame.js: console help, URL params, hooks
}
function gameUpdate()
{
    ++stateTime;
    if (msgTimer > 0) --msgTimer;
    trailPrune(time);

    // debugGame.js: debug keys and the free cam; returns 1 when it swallowed the frame
    if (debug && devUpdate())
        return;

    // music in the quiet states only - never under a swing
    if (MUSIC && (state < ST_AIM || state > ST_FLIGHT))
        updateMusic();
    [updateTitle, updateIntro, updateAim, updateSwing,
     updateFlight, updateHoleOut][state]();
    if (keyWasPressed('Escape'))
        setState(ST_TITLE);
}

// EVERY camera's home. Smoothing is PER CALL, and this runs once per fixed
// update while gameRender runs once per RENDERED frame - smoothing there is
// frame-rate dependent (2.4x faster at 144Hz than at 60). In dev the free cam
// holds still while a thrown ball flies.
function gameUpdatePost()
{
    // THE INTRO CAMERA: one continuous pull-back, hovering short of the green
    // facing the pin, then flying backwards along the hole path into the tee
    // pose over the last 30%. The 20yd head start keeps the pin ahead of the
    // camera from frame 0.
    if (state == ST_INTRO && !(debug && (freeCam || mapView)))
    {
        const e = smoothStep(clamp(stateTime/INTRO_T));
        const a = pathPointAt(hole.len*(1-e) - 20);
        const w = clamp((e-.7)/.3);
        // The descent cap chains from the previous UPDATE's camY, so read it
        // BEFORE setSwingCam overwrites it. Not on entry: a new hole is a
        // deliberate cut and starts AT the hover height. -1e9 opts out by
        // LOSING the Math.max below; +1e9 would put the camera a billion yards up.
        const y0 = stateTime > 1 ? camY : -1e9;
        setSwingCam(aimYaw);
        camX = lerp(a.x, camX, w);
        camZ = lerp(a.z, camZ, w);
        // heightAt, NOT groundAt: the bunker's -.5 scoop is a SURFACE step that
        // jumps the camera where the path crosses greenside sand
        camY = lerp(heightAt(a.x, a.z) + 11 - e*5, camY, w);
        // FLOAT DOWN, CLAMP UP: descent capped at INTRO_FALL, rising instant, and
        // the ground under the camera a hard floor (the end blend can cut a
        // dogleg under a hill)
        camY = Math.max(camY, y0 - INTRO_FALL, heightAt(camX, camZ) + 2);
        camYaw = lerp(Math.atan2(hole.pin.x-camX, hole.pin.z-camZ), camYaw, w);
        camPitch = lerp(.3 - e*.2, camPitch, w);
    }

    // The HOLD matters: at launch the camY target is BELOW where setSwingCam
    // left the camera, so an immediate chase dips before it climbs. A putt
    // takes the hold too and barely notices.
    if (state == ST_FLIGHT && stateTime > CAM_HOLD
        && !(debug && (freeCam || mapView)))
    {
        // A fixed offset BEHIND the ball, so break slides the camera sideways
        // and the ball holds its place on screen (a putt needs no yaw of its
        // own). What the 8yd frames is the ball slowing and stopping; in fast
        // flight the .05 trails well behind anyway. Same zoom as the aim pose.
        const k = camZoom(PUTT_ZOOM);
        camX = lerp(camX, ball.x - Math.sin(shotDir)*8*k, .05);
        camZ = lerp(camZ, ball.z - Math.cos(shotDir)*8*k, .05);
        camY = lerp(camY, Math.max(ball.y + 3*k, groundAt(camX, camZ).h + 2.4*k), .05);
        // the aim, a pure function of camera and ball, so it belongs on this step too
        const hd = Math.hypot(ball.x-camX, ball.z-camZ);
        // Yaw needs no ease after the hold: the ball has flown almost straight
        // away from a camera that has not moved (0.18 degrees in an 8-unit crosswind)
        camYaw = Math.atan2(ball.x-camX, ball.z-camZ);
        // Pitch does: it starts 21 degrees below where setSwingCam left it. The
        // .1 must match setSwingCam; stateTime counts fixed updates, so no extra state.
        camPitch = lerp(.1, Math.atan2(camY - ball.y - 1, Math.max(hd, 8)),
            smoothStep(clamp((stateTime - CAM_HOLD)/30)));
    }
    ++camEase; // fixed step, so the settle ease is frame-rate independent

    // The last two poses, BELOW the increment: the settle ease reads camEase.
    if (!(debug && (freeCam || mapView)))
    {
        if (state == ST_TITLE)
        {
            // A slow orbit of the pin at a FIXED height above the green (greenH
            // is constant for the hole, so nothing snaps over a bunker or slope).
            // THE 12 IS A CLEARANCE, not a taste: some greens sit in a bowl whose
            // rim is above them. Tightest gap over the orbit, classic 18 plus
            // eight remix seeds: +8 goes 1.9yd UNDERGROUND, +10 clears by .1,
            // +12 by 2.1, +14 by 4.1.
            camYaw = time*.1;
            camX = hole.pin.x - Math.sin(camYaw)*20;
            camZ = hole.pin.z - Math.cos(camYaw)*20;
            camY = hole.greenH + 12;
            // THE PITCH KNOB: from 20yd out and 12 up the pin sits 31 degrees
            // below the horizon, half-FOV 43.5, so it lands (31 - pitch) degrees
            // below centre. As a fraction of the half-screen: .54 centre, .30 a
            // third down (here), .06 two thirds, -.10 almost off. Raise to lift.
            camPitch = .1;
        }
        else if (state == ST_AIM || state == ST_SWING)
        {
            placeView ? setPlaceCam() : setSwingCam(aimYaw);
            // Blend FROM the stored pose, not last frame's, so the ease is exact
            // and lands on the swing camera. Yaw has to wrap.
            if (camEase < SETTLE_T && !placeView)
            {
                const w = smoothStep(camEase/SETTLE_T);
                camX = lerp(camFrom[0], camX, w);
                camY = lerp(camFrom[1], camY, w);
                camZ = lerp(camFrom[2], camZ, w);
                camYaw = lerpAngle(camFrom[3], camYaw, w);
                camPitch = lerp(camFrom[4], camPitch, w);
            }
        }
        // HOLEOUT and the pre-hold flight keep the last camera
    }
}

// EVERY camera pose is set in gameUpdatePost on the fixed step; this only
// draws. Nothing in here may move anything.
function gameRender()
{
    if (debug && mapView)
    {
        glFogScale = 0; // the whole hole from 300yd up must not fog out
        setMapCam();
        renderView3d();
        glFogScale = 1;
        return;
    }
    renderView3d();
}

///////////////////////////////////////////////////////////////////////////////
// (engineInit lives at the end of hud.js: it names gameRenderPost, so it has
// to run after hud.js has defined it, and hud.js loads last.)
