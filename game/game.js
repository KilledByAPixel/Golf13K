'use strict';

/*  SUNSHINE GOLF CLASSIC - game flow and input
    States: TITLE, INTRO (3d flyback: green -> tee), AIM (tee or landing
    preview cam), SWING (meter), FLIGHT (chase cam), HOLEOUT.
    The 2D overlay lives in hud.js; everything else renders in the 3d view. */

const ST_TITLE=0, ST_INTRO=1, ST_AIM=2, ST_SWING=3, ST_FLIGHT=4,
      ST_HOLEOUT=5;

const CLASSIC_SEED = 1113;

let state = ST_TITLE, stateTime = 0;
let courseRows, courseSeed = CLASSIC_SEED, remixMode = 0;
let holeIndex = 0, strokes = 0, scores = [];
let aimYaw = 0, clubI = 0, eventWait = 0;
let msgText = '', msgTimer = 0, niceShot = 0;
let spinMode = 0;                       // the spin chip: -1 back, 0 none, 1 top

// Where the shot is predicted to stop, and the yards to it. ONE simulation
// feeds all three aim aids: the line is predPath (golfSim), the ring sits on
// predLand and the chip prints predDist, so they cannot disagree.
let predLand = {x:0, z:0}, predDist = 0;
let placeView = 0, turnHold = 0;        // preview cam on?, turn-accel counter

// Frames the camera holds still after a swing before it starts chasing.
const CAM_HOLD = 9;
// ...and how long it takes to EASE OUT of the flight camera once a shot
// settles, so a hole plays with no cut in it. ONLY a settled shot eases -
// the intro, a skip, the preview toggle, a new hole and a resume all cut,
// which is what a deliberate view change should do.
const SETTLE_T = 45;
let camFrom = [], camEase = SETTLE_T;   // pose at the last settle, frames since

// The round in progress as localStorage holds it, or undefined. Written from
// enterAim, so the save point is EVERY SHOT rather than every hole.
let savedGame = localStorage['sg_save'];

// (the dev-only state - autoPlay, freeCam, telemetry - lives in debugGame.js
// with every tool that reads it, so nothing here is stripped from the build)

///////////////////////////////////////////////////////////////////////////////
// helpers

const clickPressed = ()=> mouseWasPressed(0) || keyWasPressed('Space')
    || debug && padClick(); // enhanced mode: A on the pad (debugGame.js).
    // The ONLY gamepad hook in the shipped files: the meter reads this, so
    // it cannot be driven from outside. Everything else the pad does is
    // done by calling the game's own functions from devUpdate.

function setState(s) { state = s; stateTime = 0; }

function showMsg(t) { msgText = t; msgTimer = 99; }

function aimAtPin() { aimYaw = Math.atan2(hole.pin.x-ball.x, hole.pin.z-ball.z); }

// The default aim: the PIN when this club can plausibly reach it (its max
// from this lie plus 20yd of bounce-and-roll grace), otherwise a LAYUP down
// the fairway centreline, one clean carry ahead. Aiming dead at the pin
// points the opening shot on a bent hole straight into the woods.
// A putt needs no case of its own - the putter reaches PUTT_MAX and autoClub
// only ever hands it to you inside 19yd, so the first test always passes.
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
// What the lie costs this club, and the ONE place it is decided - targetMax
// and launchBall both read it, so the meter promises exactly what the ball
// delivers. Sand is the special case: a wedge has bounce and skids where an
// iron digs, and PW (8) and SW (9) are the wedges, so `clubI < 8` reads as
// "no bounce, in sand".
const lieMul = ()=> SURF_PHYS[ballGround().s][3] * (ballGround().s == SURF_BUNKER && clubI < 8 ? .3 : 1);

///////////////////////////////////////////////////////////////////////////////
// THE TARGET. The meter is scaled to it - the bar's top IS shotTarget yards -
// so a swing caught at the top delivers the target and nothing has to convert
// between "power" and "distance" anywhere else.

let shotTarget = 100;

// The longest this club can hit from this lie. The putter is a flat PUTT_MAX
// from anywhere: what a lie costs a putt depends on how far the ball travels
// through it before reaching the green, which a SCALE cannot know. The lie is
// not ignored, it has moved - the prediction rolls the putt over the real
// ground and the chip prints where it stops.
const targetMax = ()=> clubI == CLUB_PUTTER ? PUTT_MAX : CLUBS[clubI][1]*lieMul();
const setTarget = (d)=> shotTarget = clamp(d, 5, targetMax());

// Yards per click of the - / + chips and per notch of the wheel, for every
// club. 1 IS THE FLOOR WORTH USING: the chip prints whole yards, so a finer
// step buys clicks that leave the number where it was, which reads as a
// broken control rather than a precise one.
const TARGET_STEP = 1;

// THE DEFAULT TARGET, and the one fudge in the game. Wind is the player's to
// read - there is an arrow for it - but ELEVATION has no cue at all, so a
// full shot adds 1.95yd of carry per yard of climb. Fitted over 30 reachable
// tee shots, it cuts the calm-air error from 14.4yd rms to 2.3.
// A PUTT takes no climb term, and not because greens are flat: rollStep
// already rolls the slope, so adding the fudge on top double-counts it and
// leaves every putt short. It aims PUTT_OVER past the cup instead - see
// golfSim.js, where the knob and its reasoning live.
const resetTarget = ()=> setTarget(clubI == CLUB_PUTTER ? ballToPin()*PUTT_OVER
    : ballToPin() + (hole.greenH - ballGround().h)*1.95);

// meter fraction -> the power launchBall wants, so a full meter delivers
// exactly shotTarget
const shotPower = (mp)=> Math.min(1, mp*shotTarget/targetMax());

const parTotal = (n)=> courseRows.slice(0, n).reduce((t, row)=> t + row[0], 0);
const scoreTotal = ()=> scores.reduce((a, b)=> a+b, 0);
// score against par in golf's own shorthand: E for level, else signed
const relPar = (d)=> d ? (d>0?'+':'')+d : 'E';

const SCORE_NAMES = ['🦄 ALBATROSS!','🦄 EAGLE!','🌈 BIRDIE!','PAR','BOGEY','DOUBLE BOGEY'];
function scoreName(strokes, par)
{
    if (strokes == 1) return '🦄 HOLE IN ONE!';
    const d = strokes - par;
    return SCORE_NAMES[clamp(d+3, 0, 5)];
}

///////////////////////////////////////////////////////////////////////////////
// flow

// REMIX is the classic 18 RE-DEALT: genCourse shuffles the same hand-tuned
// rows under a fresh seed, which also re-rolls every hole's land. No row
// generator, so it costs almost nothing.
function startCourse(remix)
{
    remixMode = remix;
    courseSeed = remix ? randInt(1e6)+1e6 : CLASSIC_SEED;
    courseRows = genCourse(courseSeed, remix);
    holeIndex = 0;
    scores = [];
    debug && tlog('round', {mode: remix ? 'remix' : 'classic', seed: courseSeed});
    startHole();
    saveGame();
}

// w = the wind to restore when continuing a save. It MUST be applied before
// buildWorld: the foliage rustle amplitude is baked into the leaf alpha from
// hole.wind.s, so setting it after leaves the trees swaying to a wind the
// game is no longer playing.
function startHole(w)
{
    genHole(courseSeed, holeIndex, courseRows[holeIndex]);
    if (w) hole.wind = w;
    glContext && buildWorld();
    ball.x = ball.z = 0; // the tee is the origin
    ball.y = ballGround().h;
    ball.vx = ball.vy = ball.vz = 0;
    strokes = 0;
    trail = [];
    setState(ST_INTRO);
}

// Everything needed to resume. The trailing '' matters, or savedGame holds an
// ARRAY while localStorage holds a string and split() throws.
// NOT called from startHole - gameInit calls that for the title backdrop, and
// would overwrite the real save on every load.
// AI TEST MODE NEVER WRITES. Watching the bot play is a test, not a round, and
// the save is written from enterAim on EVERY shot - so without this, toggling
// T over a real game in progress would grind it away one stroke at a time.
// Costs the release nothing: `debug` is a const 0 there, so this folds out.
const saveGame = ()=> debug && autoPlay ? 0 :
    localStorage['sg_save'] = savedGame =
    [courseSeed, holeIndex, hole.wind.a, hole.wind.s,
     ball.x, ball.z, strokes, ...scores] + '';

// Play the shot the meter is promising. shotTarget is the INPUT - it scales
// the meter and so the power - but everything on screen is an OUTPUT of this
// one simulation, which is why spin and club move all of it together.
// Every club, putter included: predictLanding rolls a putt where it flies a
// full shot, so putting has no aim code of its own.
// EVERYTHING HERE IS EXACT, and easing any of it is a mistake already made:
// predLand feeds the ring, the shot line's end, the meter's cup marker and
// the printed yards, and the marker divides by predDist - so a lerp here came
// out MULTIPLIED and swept the bar on every club change (2026-09-01, see
// CHANGELOG v0.13-p252..254). Smooth at a consumer if ever needed, never here.
// THE .2 IS FRANK'S KNOB. Measured holding the turn at the game's own max
// rate (17deg/s), camera 12yd behind the point - worst frame-to-frame change,
// then the constant lag it costs:
//   raw .558yd -    k=.6 .303/.08   k=.4 .182/.17
//   k=.25 .100/.33  k=.2 .075/.43   k=.15 .052/.61
// The lag is CONSTANT while turning and gone the instant you stop, which is
// why the trade is so one-sided. Raise it toward 1 if the aim feels sticky.
// .2 is also the CHEAPEST value: +6 bytes against +10 for .4 and +14 for .25,
// because roadroller already carries .2 and a named const cost 4 more again.
function updatePredict()
{
    predLand = predictLanding(clubI, aimYaw, spinMode, lieMul(), shotPower(1));
    predDist = Math.hypot(predLand.x-ball.x, predLand.z-ball.z);
}

function enterAim()
{
    // the one cut worth removing: the ball has stopped and the eye is still
    // on it. Every other caller arrives from some other state, so the test
    // needs no flag of its own.
    if (state == ST_FLIGHT)
        camFrom = [camX, camY, camZ, camYaw, camPitch], camEase = 0;
    hideTrees();    // once per shot, so rotating the aim stays smooth
    // pull the pin from anywhere on the green, but ONLY from the green: a chip
    // out of sand or rough is exactly the shot that wants a flagstick to judge
    // the line against, and to rattle off
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

// every flight starts from the swing camera, so the chase eases out from
// behind the ball even when the swing was made from the preview view
function startFlight()
{
    placeView = 0;
    setSwingCam(aimYaw);
    eventWait = 0;
    // a putt is all roll, so its carry starts AT zero rather than waiting
    // for a touchdown that never comes
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
    // ONE sound, not two layered: the fanfare REPLACES the cup rattle under
    // par, so which one you hear is itself the result. (Also fires on a
    // max-strokes pickup, where nothing was holed at all.)
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
        const key = 'sg_best_' + (remixMode ? 'r' : 'c');
        const rel = scoreTotal() - parTotal(18);
        const best = localStorage[key];
        if (!best || rel < best)
            localStorage[key] = rel;
        // nothing left to continue. '' is falsy, so it reads exactly like an
        // absent key on the next load
        localStorage['sg_save'] = savedGame = '';
        // Straight to the title: there is no results state, because hole 18's
        // card IS the results card. Everything a results state would have
        // held is settled right here, before the switch.
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

// The title menu: three stacked buttons. CONTINUE greys out with no save.
const MENU = ['CONTINUE', 'CLASSIC', 'REMIX'];
// One ROW of three. The width is capped against BOTH axes: a third of the
// screen on a wide monitor, and .44 of the height so a phone in portrait
// still gets three buttons across rather than three slivers.
function menuRect(i)
{
    const W = mainCanvasSize.x, T = mainCanvasSize.y;
    const w = W*.3, h = T*.18;
    return {x: (W-w)/2 + (i-1)*w*1.1, y: T*.8, w, h};
}
// which button is under p, matching MENU: 1 CONTINUE, 2 CLASSIC,
// 3 REMIX, 0 none
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
    // put back after it. y is not stored - the terrain is the same terrain.
    ball.x = s[4];
    ball.z = s[5];
    ball.y = ballGround().h;
    strokes = s[6];
    // MID-HOLE skips the flyback: it ends at the tee, which is not where the
    // ball is. updateIntro's only exit is enterAim, so this is that same path
    // with the tour left out.
    strokes && enterAim();
}

// The round is over, and its card is still recoverable: nextHole leaves
// holeIndex past the end and starts nothing, so every score is still in
// memory and CONTINUE re-opens the scorecard instead of resuming.
// It also tells renderScorecard which mood to draw - reviewing rather than
// celebrating - and, being past 17, kills the grid highlight for free.
// Lasts as long as the tab and no longer: a reload reads holeIndex back from
// the save the round's end cleared, so CONTINUE greys out again.
const roundOver = ()=> holeIndex > 17;

function updateTitle()
{
    menuPick(mouseWasPressed(0) ? menuAt(mousePosScreen) : 0);
}

// b: 1 CONTINUE, 2 CLASSIC, 3 REMIX, 0 nothing. Split out of updateTitle so
// enhanced mode's gamepad can pick from the same one place - the remix lock
// and the abandon confirm live here and must not be duplicated. Closure
// inlines it back: the pad call site folds away in the release, leaving one.
function menuPick(b)
{
    // CONTINUE resumes a save, or - with the round already finished - puts
    // hole 18's card back up, stateTime past CARD_T so it appears at once
    // rather than replaying the banner.
    if (b == 1)
        savedGame ? continueGame()
            : roundOver() && (setState(ST_HOLEOUT), stateTime = CARD_T);
    // CLASSIC and REMIX. The browser's own confirm is the whole abandon
    // warning: a modal, a message and two buttons for the price of a string.
    // REMIX is locked until classic is beaten at PAR OR BETTER, and since
    // bests are stored OVER par, `<= 0` is the entire test - it needs no
    // existence check either, because undefined <= 0 is false.
    else if (b && (b < 3 || localStorage['sg_best_c'] <= 0)
        && (!savedGame || confirm('Abandon round?')))
        startCourse(b-2);
}

// Flyback length in fixed updates, and THE PULLBACK SPEED KNOB: the camera
// walks the whole path in this many frames, so speed is inversely
// proportional. 300 was a touch quick (Frank, 2026-09-02); 400 is 25% slower
// and, as it happens, a byte cheaper. 360 is free too if this reads sluggish.
// The camera eases in and out (smoothStep), so the speed being judged is the
// one in the MIDDLE of the move, not the average.
// A click skips it regardless, and the bot cuts it at 30 frames.
const INTRO_T = 400;
// the fastest the intro camera may DESCEND, yards per fixed update (.15 =
// 9yd/s). Rising is never limited - hills clamp it up instantly.
const INTRO_FALL = .15;

function updateIntro()
{
    // Solve the aim on frame 1 so the flyback ENDS where the aim will be -
    // otherwise it flies to the pin and enterAim snaps to the wind-corrected
    // heading. State is restored by hand: setState would zero stateTime and
    // re-trigger every frame. Safe despite enterAim writing a save, since
    // gameInit's title backdrop goes straight to ST_TITLE.
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
    // MUST return a number on every path: falling off the end here returned
    // undefined outside the band, `dir = turnBtnAt(..) - keyIsDown(..)` made
    // that NaN, and one meter click while the mouse sat below the arrows
    // poisoned aimYaw - the whole 3D view vanished to clear-colour blue and
    // sfxBounce threw on a NaN volume. `&&` yields false outside the band,
    // which is arithmetic 0 at the call site.
    return (p.y > T/2 - s*1.4 & p.y < T/2 + s*1.4)
        && (p.x > W - ax - s) - (p.x < ax + s);
}

function updateAim()
{
    // turn: hold the on-screen arrows (or arrow keys), accelerating
    const dir = (mouseIsDown(0) ? turnBtnAt(mousePosScreen) : 0)
        - keyIsDown('ArrowLeft') + keyIsDown('ArrowRight');
    turnHold = dir && ++turnHold;
    aimYaw += dir * (Math.min(turnHold/1e4, .005));
    // Keyboard: arrows/WASD turn and club, wheel = distance, right-click =
    // spin, chips for everything - the game assumes a mouse. The extra
    // keys (distance on < >, spin on Z) were CUT on 2026-08-31 (Frank:
    // redundant with the wheel and the chips; they return in the enhanced
    // post-jam build if ever). Club keeps up/down because that is what
    // classic PC golf uses (Links, Microsoft Golf, PGA Tour).
    const dc = keyWasPressed('ArrowDown') - keyWasPressed('ArrowUp');
    if (dc)
    {
        clubI = clamp(clubI + dc, 0, CLUBS.length-1);
        resetTarget();
        snd_adjust.play();
    }
    // the keyboard extras (< > distance, Z spin, V view, title-Space) were
    // restored as an experiment on 2026-08-31, MEASURED at +32 with the
    // arial cut, and removed again the same night - Frank: not needed,
    // mouse or touch is the interface. They live in 1d99426 if wanted.
    // The wheel works while PUTTING now: the putt meter is scaled to a
    // target like every other club, so there is a distance to dial.
    if (mouseWheel)
    {
        setTarget(shotTarget - mouseWheel*TARGET_STEP);
        snd_adjust.play();
    }

    updatePredict();

    if (autoPlay)
    {
        // A SECOND before it swings, not a third. The camera eases out of the
        // flight pose over SETTLE_T (45) frames when a shot settles, so the
        // old 20 had the bot hitting while the view was still swinging round
        // behind the ball - too fast to read, and it looked like a machine
        // rather than someone playing. 60 clears the ease with a beat to
        // spare. Watching it is the whole point of AI test mode.
        if (stateTime > 60) botSwing();
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
    // The pad's A has to be named HERE as well as in clickPressed: starting
    // the meter is the one click the game does not route through it, so A
    // drove every other phase of the swing and not the first.
    else if (keyWasPressed('Space') || (mouseWasPressed(0) && mouseOverMeter())
        || debug && padClick())
    {
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

// HUD layout shared by render and the hit tests: the turn arrows keep a
// minimum inset so they stay on screen at phone widths
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
        // logged before the launch, while the lie and the distance are still
        // the ones the shot was played from
        debug && tlog('shot', {
            club: CLUBS[clubI][0], lie: SURF_NAMES[ballGround().s],
            toPin: ballToPin()|0, target: shotTarget|0, power: +meterPower.toFixed(2),
            impact: +meterImpact.toFixed(3), spin: spinMode,
            wind: +hole.wind.s.toFixed(1), windDir: +(hole.wind.a - aimYaw).toFixed(2)});
        // ONE LAUNCH for every club, and so one set of feedback: a putt is
        // struck, judged and named exactly as a drive is. Only the sound
        // still knows the difference.
        const err = launchBall(clubI, shotPower(meterPower), meterImpact, spinMode, aimYaw, lieMul());
        isPutt ? snd_putt.play(.4 + meterPower*.6)
               : snd_tee.play(.5 + meterPower*.5, .8 + meterPower*.4);
        // THE VERDICT, and it rides entirely on the SECOND click. The three
        // names match the three bands launchBall produces: err snapped to 0,
        // under .06, and everything else. Power earns nothing on its own -
        // gating the top tier on it made PERFECT unreachable on any layup.
        // A PUTT IS JUDGED SILENTLY. It reads the second click exactly as a
        // full shot does and misses the hole for it, but hook and slice are
        // ball-FLIGHT words and a fanfare over a tap-in is the game shouting
        // about nothing. (niceShot is zeroed at the top of every swing, so
        // skipping it here is all it takes to keep the trail plain.)
        // Both `!err` tests lean on launchBall snapping a near-perfect strike
        // to exactly 0, which is why neither needs an absolute value.
        if (!isPutt)
        {
            if (!err)
            {
                niceShot = 1;
                snd_nice.play();
            }
            showMsg(!err ? 'PERFECT!' : Math.max(err, -err) < .06 ? 'GOOD'
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
        // measured out here, not inside ballUpdate: that has five early
        // returns, and a frame's worth of travel is straight enough
        const dx = ball.x-rx, dz = ball.z-rz, d = Math.hypot(dx, dz);
        d && (ballDir = Math.atan2(dx, dz));
        ballRoll += d*ROLL_K;
        // Latch the carry at the FIRST TOUCHDOWN, which is the bounce
        // counter ticking - NOT `!ballAir`, which stays set through every
        // bounce and only clears once the ball settles into a roll. That is
        // a different number and 19yd further out on a driver, and reading
        // it as carry made topspin look like it flew further when it was
        // only bouncing further. A putt never bounces, so it stays -1 and
        // reads 0, which is right for a shot that is all roll.
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
    // A HOLED ball has already had its beat: the 14-frame drop above IS
    // the pause that lets the player see the result. Waiting the full 50 on
    // top left 36 idle frames before endHole fired the fanfare - which is
    // why the sound felt late, and it was the only event with a delay
    // (water and OB play theirs at eventWait == 1, immediately).
    else if (++eventWait > (fastMode ? 8 : ballEvent == EV_HOLED ? 16 : 50))
    {
        // resolve the shot result after a beat
        const ev = ballEvent;
        ballEvent = 0;
        if (debug)
        {
            // Three numbers, because they answer different questions: CARRY
            // is where it first came down (what clears a hazard), TOTAL is
            // where it stopped (what the meter promised), and the ROLL
            // between them is what spin actually buys - backspin should show
            // almost none, topspin a lot, off the same carry.
            const dist = Math.hypot(ball.x-shotStart.x, ball.z-shotStart.z);
            // still -1 means it never touched down at all - it flew straight
            // into the cup, so the whole shot was carry. (A putt was set to 0
            // at launch, since a putt is all roll by definition.)
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
            ball.x = ballSafe.x + dx/dl*2;
            ball.z = ballSafe.z + dz/dl*2;
            ball.y = ballGround().h;
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

// hole-out: banner + confetti, then (CARD_T frames in) the scorecard, which
// waits for a click - no auto-advance, so the score can be read
const CARD_T = 80;
function updateHoleOut()
{
    // THE LAST CARD HOLDS A SECOND LONGER before it will take a click.
    // It is the round's result, there is no second screen behind it since
    // p237, and a click already in flight from the hole-out banner should
    // not be able to throw it away. p238's CONTINUE is the net; this is what
    // stops needing one. Only the DISMISS waits - the card still appears at
    // CARD_T like every other, since hud.js draws it on its own test.
    // The bot is untouched: it advances on its own 40-frame clock.
    if (stateTime > (holeIndex > 16 ? 140 : CARD_T) && clickPressed()
        || autoPlay && stateTime > 40)
        nextHole();
}

///////////////////////////////////////////////////////////////////////////////
// engine callbacks

function gameInit()
{
    // Scenery behind the title: the hole you are part way through. Seed,
    // mode and hole - a remix save must bring its own course or the rows
    // would not match. |0 rather than +, so a corrupt save cannot take the
    // game down at STARTUP.
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

    // debugGame.js: debug keys and the free cam. It returns 1 when it
    // has swallowed the frame (the map is open, or the free cam is flying).
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

// The chase cam's ONLY home. It smooths at .05 PER CALL, and gameRender runs
// once per RENDERED frame while this runs once per fixed update - smoothing
// in render made it frame-rate dependent (2.4x faster at 144Hz than the 60Hz
// it was tuned at). The debug guard folds away in release, and matters in
// dev: free cam holds still while a thrown ball flies.
function gameUpdatePost()
{
    // THE INTRO CAMERA. One continuous pull-back: hover short of the green
    // facing the pin, fly backwards along the hole path into the tee-shot
    // pose, blended in over the last 30%. The 20yd head start keeps the pin
    // ahead of the camera from frame 0.
    // It MUST run on the fixed step, like the chase cam below: the descent
    // cap is smoothing state, and per RENDERED frame it falls at full speed
    // through slow motion and 2.4x too fast on a 144Hz screen.
    if (state == ST_INTRO && !(debug && (freeCam || mapView)))
    {
        const e = smoothStep(clamp(stateTime/INTRO_T));
        const a = pathPointAt(hole.len*(1-e) - 20);
        const w = clamp((e-.7)/.3);
        // The descent cap chains from the previous UPDATE's height, so it
        // must be read BEFORE setSwingCam overwrites camY with the tee pose.
        // EXCEPT on entry: a new hole is a deliberate cut, so the camera
        // starts AT the hover height rather than floating down from wherever
        // the last hole left it - hole heights are unrelated spaces, and
        // chaining across them opens a hole with a visible dip.
        // -1e9 is how entry opts out: it must LOSE the Math.max below. The
        // sign matters - +1e9 puts the camera a billion yards up.
        const y0 = stateTime > 1 ? camY : -1e9;
        setSwingCam(aimYaw);
        camX = lerp(a.x, camX, w);
        camZ = lerp(a.z, camZ, w);
        // heightAt, NOT groundAt: groundAt carries the bunker's -.5
        // scoop, a SURFACE step - H2's path crossing its greenside sand
        // stepped the camera half a yard in one frame (MEASURED, p212)
        camY = lerp(heightAt(a.x, a.z) + 11 - e*5, camY, w);
        // FLOAT DOWN, CLAMP UP (p209): descent capped at INTRO_FALL per
        // fixed update, rising instant, and the ground under the CAMERA's
        // own position a hard floor - H18's end blend cut a dogleg corner
        // clean under a hill without it
        camY = Math.max(camY, y0 - INTRO_FALL, heightAt(camX, camZ) + 2);
        camYaw = lerp(Math.atan2(hole.pin.x-camX, hole.pin.z-camZ), camYaw, w);
        camPitch = lerp(.3 - e*.2, camPitch, w);
    }

    // The HOLD matters as much as the smoothing: at launch the camY target
    // (ball.y + 5) sits BELOW where setSwingCam left the camera, so chasing
    // at once dipped the view before climbing. Holding lets the ball get
    // above the camera first, so the first move is upward. A putt takes the
    // hold too since the cameras unified, and barely notices - the ball has
    // hardly left in nine frames at putting pace.
    if (state == ST_FLIGHT && stateTime > CAM_HOLD
        && !(debug && (freeCam || mapView)))
    {
        // A fixed offset BEHIND the ball, so break slides the camera sideways
        // and the ball holds its place on screen - which is why a putt needs
        // no yaw of its own. The 8yd barely matters in FAST flight, where the
        // .05 smoothing trails 20yd behind its own target whatever it is;
        // what it really frames is the ball slowing and stopping, which is
        // when it is actually being watched.
        // Same zoom as the aim pose, so the strike is not a cut.
        const k = camZoom(PUTT_ZOOM);
        camX = lerp(camX, ball.x - Math.sin(shotDir)*8*k, .05);
        camZ = lerp(camZ, ball.z - Math.cos(shotDir)*8*k, .05);
        camY = lerp(camY, Math.max(ball.y + 3*k, groundAt(camX, camZ).h + 2.4*k), .05);
        // ...and the AIM, which used to be computed in gameRender. It is a
        // pure function of the camera and the ball, so it gave the same
        // answer at render rate - both of those only move on this step - and
        // running it here costs nothing and keeps one rule for the file.
        const hd = Math.hypot(ball.x-camX, ball.z-camZ);
        // Yaw needs no ease despite resuming cold after the hold: the camera
        // has not moved and the ball has flown almost straight away from it,
        // so the angle barely changes - MEASURED at 0.18 degrees in an
        // 8-unit crosswind, the stress case.
        camYaw = Math.atan2(ball.x-camX, ball.z-camZ);
        // Pitch does need one: it starts 21 degrees below where setSwingCam
        // left it, which snaps on the first frame. The .1 must match
        // setSwingCam, and stateTime counts fixed updates so easing on it
        // needs no state of its own.
        camPitch = lerp(.1, Math.atan2(camY - ball.y - 1, Math.max(hd, 8)),
            smoothStep(clamp((stateTime - CAM_HOLD)/30)));
    }
    ++camEase; // fixed step, so the settle ease is frame-rate independent

    // The last two poses, BELOW the increment because the settle ease reads
    // camEase and used to run in gameRender - after this had already stepped.
    if (!(debug && (freeCam || mapView)))
    {
        if (state == ST_TITLE)
        {
            // A slow orbit of the pin at a FIXED height above the green. It
            // used to take its height from the ground under the CAMERA, so
            // every bunker scoop and slope it passed over stepped the view.
            // greenH is a constant for the hole, so there is nothing left to
            // sample and nothing to snap.
            // THE 12 IS A CLEARANCE, not a taste: a fixed height cannot dodge
            // terrain, and some greens sit in a bowl whose rim is above them.
            // MEASURED as the tightest gap over the whole orbit, across the
            // classic 18 and eight remix seeds - +8 goes 1.9yd UNDERGROUND,
            // +10 clears by .1, +12 by 2.1, +14 by 4.1. Under 10 the camera
            // spends part of the turn inside a hillside.
            camYaw = time*.1;
            camX = hole.pin.x - Math.sin(camYaw)*20;
            camZ = hole.pin.z - Math.cos(camYaw)*20;
            camY = hole.greenH + 12;
            // THE PITCH KNOB. From 20yd out and 12 up the pin sits 31 degrees
            // below the horizon and the half-FOV is 43.5, so it lands
            // (31 - pitch) degrees below screen centre - as a fraction where
            // 0 is centre and 1 the bottom edge:
            //   .54  dead centre        .30  a third down  <- here
            //   .06  two thirds down   -.10  almost off the bottom
            // Raise it to tip down and lift the green up the frame.
            camPitch = .1;
        }
        else if (state == ST_AIM || state == ST_SWING)
        {
            placeView ? setPlaceCam() : setSwingCam(aimYaw);
            // Blend FROM the stored pose rather than last frame's, so the
            // ease is exact, lands on the swing camera, and reads the same at
            // 60Hz and 144Hz. Yaw has to wrap - a settle can leave the camera
            // either side of the new heading.
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

// EVERY camera pose is set in gameUpdatePost now, on the fixed step, so this
// only draws. Nothing in here may move anything - that split is the whole
// defence against the frame-rate bugs this file has already had twice.
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
