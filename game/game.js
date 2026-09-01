'use strict';

/*  RAINBOW GOLF TOUR - game flow, HUD, input
    States: TITLE, INTRO (3d flyback: green -> tee), AIM (tee or landing
    preview cam), SWING (meter), FLIGHT (chase cam), HOLEOUT, RESULTS.
    Everything renders in the one 3d view. */

const ST_TITLE=0, ST_INTRO=1, ST_AIM=2, ST_SWING=3, ST_FLIGHT=4,
      ST_HOLEOUT=5, ST_RESULTS=6;

const CLASSIC_SEED = 1113;

let state = ST_TITLE, stateTime = 0;
let courseRows, courseSeed = CLASSIC_SEED, remixMode = 0;
let holeIndex = 0, strokes = 0, scores = [];
let aimYaw = 0, clubI = 0, eventWait = 0;
let msgText = '', msgTimer = 0, niceShot = 0;
let spinMode = 0;  // right-click spin cycle
let predLand = {x:0, z:0}; // predicted touchdown, feeds ring + placement view
let placeView = 0, turnHold = 0; // landing-preview cam, turn-accel counter
let autoPlay = 0, fastMode = 0, freeCam = 0, mapView = 0; // debug: bot, fast-forward, fly cam, hole map
let puttMode = 0; // debug: drop on the green and putt, over and over
// debug screenshot: K arms it here, gameRenderPost takes it. The grab has to
// happen INSIDE the frame that drew the picture - glCanvas is created without
// preserveDrawingBuffer, so the drawing buffer is gone the moment the browser
// composites, and a read from an update (or a setTimeout, or a promise) comes
// back blank. Same reason it is toDataURL and not toBlob: toDataURL encodes
// synchronously, toBlob only promises to snapshot before it hands the encode
// off. Nothing here reaches the release build - debug folds it all out.
let grabShot = 0;
// debug: distance at the FIRST TOUCHDOWN, latched once per shot. -1 = the
// ball has not come down yet. A putt never flies, so it records ~0 on the
// first frame, which is the honest answer for a shot that is all roll.
let carryDist = -1;
function saveShot()
{
    grabShot = 0;
    const a = document.createElement('a');
    // glCanvas ONLY. The HUD is a separate overlayCanvas, so it is not in
    // this image at all - no hiding, no flag, nothing to remember to undo.
    a.href = glCanvas.toDataURL();
    a.download = `golf-h${holeIndex+1}-${Date.now()%1e7}.png`;
    a.click();
}
const THROW_V = 45; // yd/s the free cam's B key throws the ball at
// Frames the camera holds still after a swing before it starts chasing.
// Frank's knob - raise for a longer locked-off shot, 0 to chase at once.
const CAM_HOLD = 9;
// ...and how long the aim camera takes to EASE OUT of the flight camera once
// a shot settles, in fixed updates, so a hole plays with no cut in it. Only
// a settled shot eases: every other way into the aim - the intro, skipping
// it, the preview toggle, a new hole, a resume - still cuts, which is what
// a deliberate view change should do.
const SETTLE_T = 45;
let camFrom = [], camEase = SETTLE_T; // pose at the last settle, frames since
// Debug telemetry: one record per shot, tree strike, hole and round start.
// TELEMETRY() prints and returns it, TELEMETRY(1) downloads it as JSON.
// EVERY call site is `debug && tlog(...)`, so Closure folds it all away.
// dev: 1 = a reload drops straight into the game, 0 = stop at the title.
const DEV_SKIP_MENU = 0;
const DEV_THUMBNAIL = 0;
// dev: 1 = draw the predicted flight arc while aiming. Off by default -
// it is a large aiming aid, not just a visual. golfSim and glRender read it
// at CALL time, so declaring it after them is fine.
const PRED_ARC = 0;
let telem = [];
const tlog = (e, d)=> telem.push({e, hole: holeIndex+1, stroke: strokes, ...d});
// event names for the debug console/telemetry only - Closure drops this
// with the debug sites; the game itself speaks EV_ integers
const EV_NAMES = [,'holed','stopped',,,'water','ob'];
// The game in progress, as the string localStorage holds, or undefined.
// Written from enterAim, so the save point is EVERY SHOT, not every hole -
// quitting mid-hole used to hand back the tee and a blank card for it.
let savedGame = localStorage['rg_save'];

///////////////////////////////////////////////////////////////////////////////
// helpers

const clickPressed = ()=> mouseWasPressed(0) || keyWasPressed('Space');

function setState(s) { state = s; stateTime = 0; }

function showMsg(t) { msgText = t; msgTimer = 99; }

function aimAtPin() { aimYaw = Math.atan2(H.pin.x-ball.x, H.pin.z-ball.z); }

// The DEFAULT aim for every shot (Frank, 2026-08-31): the pin when this
// club can plausibly reach it (its real max from this lie plus 20yd of
// bounce-and-roll grace), otherwise a LAYUP - the fairway centerline one
// clean carry ahead. Aiming dead at the pin pointed the opening shot on
// bent holes into the woods; the bot has aimed exactly this way since
// v0.1, so the player's default is now the bot's. Putts take the pin.
function aimDefault()
{
    const reach = targetMax();
    if (clubI == CLUB_PUTTER || ballToPin() < reach + 20)
        return aimAtPin();
    distToPath(ball.x, ball.z); // sets lastAlong
    const t = pathPointAt(Math.min(lastAlong + reach*.95, H.len));
    aimYaw = Math.atan2(t.x-ball.x, t.z-ball.z);
}

const SPIN_NAMES = ['BACKSPIN', 'NO SPIN', 'TOPSPIN']; // indexed by spin+1
// How far the lie lets this club carry, and the ONE choke point for it:
// targetMax and launchBall both read it, so a
// penalty here is honest - the meter promises less and the ball delivers it.
// Sand wants a wedge, which has bounce and skids instead of digging; PW (8)
// and SW (9) are the wedges, so clubI < 8 is "no bounce, in sand" - the 13
// iron at 7 is an iron and digs like one. Below .332 (= SW/1W carry) a
// wedge is the longest club out of a bunker.
const lieMul = ()=> SURF_PHYS[ballGround().s][3] * (ballGround().s == SURF_BUNKER && clubI < 8 ? .3 : 1);

// the meter is scaled: its top = shotTarget yards (wheel / chips adjust it,
// defaults to the pin), so a swing caught at the top lands on the target
let shotTarget = 100;
// The longest shot a club can hit from this lie. The putter is a FIXED
// 40yd from anywhere: what a lie costs a putt depends on how far the ball
// travels through it before reaching the green, which the meter cannot
// know, so the SCALE stays put - full power is full power everywhere, and
// a putt out of rough is never crippled by its own meter.
// The DISPLAY does account for the lie: renderMeter scales this by the
// friction ratio into an estimate of real roll (40 green, 20 fairway, 9
// rough, 4 sand) and marks the cup in those same yards.
const targetMax = ()=> clubI == CLUB_PUTTER ? 40 : CLUBS[clubI][1]*lieMul();
const setTarget = (d)=> shotTarget = clamp(d, 5, targetMax());
// WIND is the player's to read - there is an arrow for it. ELEVATION is not:
// nothing on screen says the green is 15yd up, so aiming at the pin distance
// landed a MEASURED 12yd short uphill and 17yd long downhill, with no cue.
// One multiply fixes it: 1.95 yards of carry per yard of climb, fitted over
// 30 reachable tee shots, cuts the calm-air error from 14.4yd rms (worst 34)
// to 2.3yd (worst 6.4). Not a prediction - no integration, no solve.
const resetTarget = ()=> setTarget(clubI == CLUB_PUTTER ? targetMax()
    : ballToPin() + (H.greenH - ballGround().h)*1.95);
// meter fraction -> launch power: a full meter carries exactly shotTarget
// (putts go through launchPutt, which takes yards directly)
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

// REMIX SHIPS: updateTitle calls startCourse(b-2), so the b=3 button
// reaches it. Since p201 remix is just the classic rows re-dealt under
// the fresh seed - genCourse's shuffle - so it is nearly free by design.
function startCourse(remix)
{
    remixMode = remix;
    courseSeed = remix ? randInt(1e6)+1 : CLASSIC_SEED;
    courseRows = genCourse(courseSeed, remix);
    holeIndex = 0;
    scores = [];
    debug && tlog('round', {mode: remix ? 'remix' : 'classic', seed: courseSeed});
    startHole();
    saveGame();
}

// w = the wind to restore when continuing a saved game. It has to be applied
// BEFORE buildWorld, because the foliage rustle amplitude is baked into the
// leaf alpha from H.wind.s - set it after and the trees sway to a wind the
// game is no longer playing.
function startHole(w)
{
    genHole(courseSeed, holeIndex, courseRows[holeIndex]);
    if (w) H.wind = w;
    glContext && buildWorld();
    ball.x = ball.z = 0; // the tee is the origin
    ball.y = ballGround().h;
    ball.vx = ball.vy = ball.vz = 0;
    strokes = 0;
    trail = [];
    setState(ST_INTRO);
}

// Everything needed to resume. The trailing '' matters, or savedGame holds
// the ARRAY while localStorage holds a string and split() throws.
// NOT called from startHole: gameInit calls that for the title backdrop,
// which would overwrite the real save on every load.
const saveGame = ()=> localStorage['rg_save'] = savedGame =
    [courseSeed, remixMode, holeIndex, H.wind.a, H.wind.s,
     ball.x, ball.z, strokes, ...scores] + '';

// refresh the predicted landing point
function updatePredict()
{
    // putts have no landing ring - the aim arrow and the slope arrows on
    // the green do that job
    if (clubI != CLUB_PUTTER)
        predLand = {x: ball.x + Math.sin(aimYaw)*shotTarget,
                    z: ball.z + Math.cos(aimYaw)*shotTarget};
    // the real flight, for the debug arc only - it is the one thing that
    // still shows where the wind will actually take the ball
    debug && PRED_ARC && predictLanding(clubI, aimYaw, spinMode, lieMul(), shotTarget/targetMax());
}

function enterAim()
{
    // The one place a camera cut is worth removing: the ball has stopped and
    // the eye is still on it. Every other caller is in some other state, so
    // this needs no flag of its own.
    if (state == ST_FLIGHT)
        camFrom = [camX, camY, camZ, camYaw, camPitch], camEase = 0;
    hideTrees();    // once per shot, so rotating the aim stays smooth
    // pull the pin from anywhere on the green, not just alongside the cup -
    // but ONLY from the green: a chip from sand or rough is exactly the shot
    // that wants a flagstick to judge the line against, and to rattle off
    pinOut = ballToPin() < 15 && ballGround().s == SURF_GREEN;
    meterPhase = 0; // Escape mid-sweep otherwise leaves a stale power mark
    spinMode = 0;   // spin is per shot, not a setting to be left switched on
    clubI = autoClub();
    aimDefault();
    resetTarget();
    updatePredict();
    // the save point is every aim, not every hole: quitting mid-hole used to
    // hand back the tee and a blank card for it
    saveGame();
    placeView = 0;
    setState(ST_AIM);
}

// every flight starts from the swing camera, so the chase cam eases out
// from behind the ball even when the swing was made from the landing preview
function startFlight()
{
    placeView = 0;
    setSwingCam(aimYaw, clubI == CLUB_PUTTER);
    eventWait = 0;
    // a putt is all roll by definition, so it starts AT zero rather than
    // waiting for a touchdown that never comes
    carryDist = clubI == CLUB_PUTTER ? 0 : -1;
    setState(ST_FLIGHT);
}

function endHole()
{
    scores[holeIndex] = strokes;
    debug && tlog('hole', {par: H.par, len: H.len|0, score: strokes - H.par,
        name: scoreName(strokes, H.par)});
    debug && autoPlay && console.log(`RESULT hole ${holeIndex+1} par ${H.par} strokes ${strokes}`);
    showMsg(scoreName(strokes, H.par));
    // ONE sound for the result, not two layered: the fanfare replaces the
    // cup rattle under par rather than piling on top of it, so which one you
    // hear IS the result. (Note this also fires on a max-strokes pickup,
    // where nothing was actually holed - endHole handles that path too.)
    (strokes < H.par ? snd_fanfare : snd_hole).play();
    setState(ST_HOLEOUT);
}

function nextHole()
{
    if (++holeIndex >= 18)
    {
        debug && autoPlay && console.log(`RESULT total ${scoreTotal()} par ${parTotal(18)}`);
        // Stored OVER OR UNDER PAR, not as a stroke total: a remix course
        // need not share the classic 18's par, so totals are not comparable.
        const key = 'rg_best_' + (remixMode ? 'r' : 'c');
        const rel = scoreTotal() - parTotal(18);
        const best = localStorage[key];
        if (!best || rel < best)
            localStorage[key] = rel;
        // the round is over, so there is nothing left to continue. '' is
        // falsy, so it reads exactly like an absent key on the next load
        localStorage['rg_save'] = savedGame = '';
        setState(ST_RESULTS);
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
// which button is under p: 1 classic, 2 remix, 3 continue, 0 none
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
    remixMode = s[1];
    holeIndex = s[2];
    scores = s.slice(8);
    courseRows = genCourse(courseSeed, remixMode);
    startHole({a: s[3], s: s[4]});
    // startHole tees the ball and zeroes the card, so the shot in progress is
    // put back after it. y is not stored - the terrain is the same terrain.
    ball.x = s[5];
    ball.z = s[6];
    ball.y = ballGround().h;
    strokes = s[7];
    // mid-hole: you have already been flown down this hole, and the flyback
    // ends at the TEE, which is not where the ball is. updateIntro's only
    // exit is enterAim, so this is the same path with the tour skipped.
    strokes && enterAim();
}

function updateTitle()
{
    // SPACE just plays: it presses CONTINUE if there is a save and CLASSIC
    // if there is not, so the whole game is reachable without a mouse. It
    // feeds the SAME button number the menu produces rather than calling
    // startCourse itself, so it inherits the abandon guard and the remix
    // lock for free. Nothing on screen says so - the buttons are right
    // there, and this is for people whose hands are already on the keys.
    const b = mouseWasPressed(0) ? menuAt(mousePosScreen) : 0;
    if (b == 1)
        savedGame && continueGame();
    // the browser's own confirm is the whole warning: a modal, a message and
    // two buttons for the price of the string
    // b == 3 is REMIX, locked until a classic round has been completed
    else if (b && (b < 3 || localStorage['rg_best_c'])
        && (!savedGame || confirm('Abandon round?')))
        startCourse(b-2);
}

const INTRO_T = 300; // flyback length in frames
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
    aimYaw += dir * (.002 + Math.min(turnHold/1e4, .005));
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
    const putting = clubI == CLUB_PUTTER;
    // the keyboard extras (< > distance, Z spin, V view, title-Space) were
    // restored as an experiment on 2026-08-31, MEASURED at +32 with the
    // arial cut, and removed again the same night - Frank: not needed,
    // mouse or touch is the interface. They live in 1d99426 if wanted.
    if (mouseWheel && !putting)
    {
        setTarget(shotTarget - mouseWheel*5);
        snd_adjust.play();
    }

    updatePredict();

    if (autoPlay)
    {
        if (stateTime > 20) botSwing();
        return;
    }
    // the chips above the meter (club / spin / distance), then the meter
    // (or Space) to swing; any other click toggles the landing preview
    const btn = mouseWasPressed(0) ? meterBtnAt(mousePosScreen) : 0;
    if (btn == 3)
        putting || cycleSpin();
    else if (btn)
    {
        if (btn < 3)
        {
            clubI = mod(clubI + btn*2-3, CLUBS.length);
            resetTarget();
        }
        else if (!putting)
            setTarget(shotTarget + (btn*2-9)*5);
        snd_adjust.play();
    }
    else if (keyWasPressed('Space') || (mouseWasPressed(0) && mouseOverMeter()))
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
    const ev = meterUpdate(clickPressed(), isPutt);
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
            impact: isPutt ? 0 : +meterImpact.toFixed(3), spin: spinMode,
            wind: +H.wind.s.toFixed(1), windDir: +(H.wind.a - aimYaw).toFixed(2)});
        if (isPutt)
        {
            launchPutt(meterPower*shotTarget, aimYaw);
            snd_putt.play(.4 + meterPower*.6);
        }
        else
        {
            const err = launchBall(clubI, shotPower(meterPower), meterImpact, spinMode, aimYaw, lieMul());
            snd_tee.play(.5 + meterPower*.5, .8 + meterPower*.4);
            const a = Math.abs(err);
            if (!a && meterPower > .93)
            {
                niceShot = 1;
                showMsg('PERFECT!');
                snd_nice.play();
            }
            else if (!a)         showMsg('NICE!');
            else if (a < .06)    showMsg('GOOD');
            else if (err > 0)    showMsg('SLICE!');
            else                 showMsg('HOOK!');
        }
        startFlight();
    }
}

// debug (X): the swing you would hit if the meter were not there - caught
// dead on the target mark, struck dead centre. It mirrors updateSwing's
// 'swing' branch rather than driving the meter, because the meter is
// exactly what this exists to remove: hit the same club fifty times and
// every number in the log is the club and the spin, with no input noise.
// A PUTT gets the exact distance to the cup on the current line, so it
// should drop every time on a flat green and show you the break on a
// sloped one.
function perfectSwing()
{
    ++strokes;
    const isPutt = clubI == CLUB_PUTTER;
    tlog('shot', {club: CLUBS[clubI][0], lie: SURF_NAMES[ballGround().s],
        toPin: ballToPin()|0, target: shotTarget|0, power: 1,
        impact: 0, spin: spinMode, perfect: 1,
        wind: +H.wind.s.toFixed(1), windDir: +(H.wind.a - aimYaw).toFixed(2)});
    if (isPutt)
        launchPutt(ballToPin(), aimYaw);
    else
    {
        // shotPower(1) is the top of the bar, so the carry is exactly
        // shotTarget - the same thing a perfect real swing would deliver
        launchBall(clubI, shotPower(1), 0, spinMode, aimYaw, lieMul());
        niceShot = 1;
        showMsg('PERFECT!');
    }
    startFlight();
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
        ball.x += (H.pin.x-ball.x)*.3;
        ball.z += (H.pin.z-ball.z)*.3;
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
        if (strokes >= H.par+5)
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
    if (stateTime > CARD_T && clickPressed() || autoPlay && stateTime > 40)
        nextHole();
}

function updateResults()
{
    if ((clickPressed() || autoPlay) && stateTime > 30)
        setState(ST_TITLE);
}

// debug (P): drop the ball somewhere on the green and putt. Holing out
// re-drops it instead of ending the hole, so putting can be worked on
// without playing a hole to reach a green each time.
function puttDrop()
{
    // out near the green's edge and roughly opposite the pin, so every drop
    // is a real putt with some break in it rather than a tap-in
    const pa = Math.atan2(H.pin.x-H.green.x, H.pin.z-H.green.z);
    const a = pa + Math.PI + rand(1.6, -1.6), d = H.gr*rand(1, .6);
    ball.x = H.green.x + Math.sin(a)*d;
    ball.z = H.green.z + Math.cos(a)*d;
    ball.y = ballGround().h;
    ball.vx = ball.vy = ball.vz = 0;
    strokes = 0;
    enterAim();
}

///////////////////////////////////////////////////////////////////////////////
// debug auto-play bot: plays reasonable shots so full rounds can run headless

// where the bot's last swing was taken from: its stuck detector. Dev-only,
// like botSwing itself - Closure folds both out of the release with autoPlay.
let botLastX = 9e9, botLastZ = 9e9;

function botSwing()
{
    const d = ballToPin(), lie = lieMul();
    ++strokes;
    // STUCK ESCAPE: a swing that gained under 15yd is pinned against a
    // hill face or a trunk its club's arc cannot clear. Since p196 made
    // hill smacks scrub (no more accidental bank-over-the-crest escapes),
    // the bot ground full drivers up steep faces 5yd at a time to the
    // mercy cap - MEASURED, 47 hill smacks in one round, eight straight
    // 1W grinds on H15. A player clubs up and pops over; so does the bot:
    // the SW is the highest loft in the bag. 15yd stays under any real
    // swing (the weakest full club from sand carries ~20) so it cannot
    // misfire on a working shot, only on a wall.
    if (clubI != CLUB_PUTTER && Math.hypot(ball.x-botLastX, ball.z-botLastZ) < 15)
        clubI = CLUB_PUTTER-1;
    botLastX = ball.x; botLastZ = ball.z;
    // the bot bypasses the meter entirely, so it logs its own shot record -
    // otherwise a bot round would have land events with nothing to pair them
    // to. power/impact are the bot's, not the meter's.
    tlog(`shot`, {club: CLUBS[clubI][0], lie: SURF_NAMES[ballGround().s],
        toPin: d|0, target: shotTarget|0, power: -1, impact: 0, spin: 0,
        wind: +H.wind.s.toFixed(1), windDir: +(H.wind.a - aimYaw).toFixed(2), bot: 1});
    if (clubI == CLUB_PUTTER)
    {
        aimAtPin();
        launchPutt(d*1.06, aimYaw + rand(.012,-.012)); // a touch past the cup
    }
    else
    {
        // long shots target the fairway landing zone, wind compensated
        // over the time of flight (2*vy/g)
        const carry = CLUBS[clubI][1]*lie;
        distToPath(ball.x, ball.z);
        const tgt = d > carry+20 ? pathPointAt(Math.min(lastAlong + carry*.95, H.len)) : H.pin;
        // the bot's own drift estimate has to carry the airspeed term too,
        // or it corrects for a wind 50x the one the ball will actually feel
        const lv = launchVel({}, clubI, 0, lie);
        const tf = 2*lv.vy/GRAV;
        const drift = H.wind.s*DRAG_K*WIND_V*Math.hypot(lv.vx, lv.vz)*tf*tf/2; // (was WIND_K)
        const tx = tgt.x - Math.sin(H.wind.a)*drift, tz = tgt.z - Math.cos(H.wind.a)*drift;
        aimYaw = Math.atan2(tx-ball.x, tz-ball.z);
        const td = Math.hypot(tgt.x-ball.x, tgt.z-ball.z);
        launchBall(clubI, clamp(td/carry, .12, 1), rand(.04,-.04), 0, aimYaw + rand(.015,-.015), lie);
    }
    startFlight();
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
        remixMode = v[1]|0;
        holeIndex = v[2]|0;
    }
    courseRows = genCourse(courseSeed, remixMode);
    startHole();
    setState(ST_TITLE);

    if (debug)
    {
        // dev only: silence until the window is actually clicked. A live
        // reload otherwise fires a note (and a tick) at an unfocused
        // window every time. Release never runs this - `debug` folds away.
        setSoundEnable(0);
        setDebugKey('Backquote'); // Esc is the game's back-to-title key
        // Everything the dev build can do, printed where it will be seen.
        // Inside if(debug), so Closure folds the whole string out of release.
        console.log(`RAINBOW GOLF TOUR - dev build

  R      REPLAY this hole, straight to the tee, strokes back to zero.
         CLASSIC changes nothing at all - same land, same pin, same wind -
         so the same shot can be hit twice and compared. REMIX rerolls the
         seed and the whole row: par, length, dogleg, terrain, scenery.
  X      PERFECT SWING: full power, dead centre. Reads a club or a spin
         without the meter in the way. A putt gets the exact distance to
         the cup. Each shot logs carry / roll / total to the console.
  [  ]   previous / next hole
  M      top-down map of the whole hole
  C      show the collision volumes (red canopy, yellow trunk, cyan pin post)
  K      save a PNG of the 3D view alone - no HUD, no meter, no text.
         Downloads at the window size, capped 1920x1080, so maximise
         for a big one. Works in free cam and the map too.
  P      putt mode: holing out re-drops on the green instead of ending
  F      free cam on/off
  Esc    back to the title           \`  engine debug overlay

  IN FREE CAM
  W/S    fly along the view direction      A/D  strafe
  Q/E    down / up                         T/G  pitch      shift  x4 speed
  click  pointer-lock mouse look (Esc releases it, camera stays put)
  B      THROW the ball from the camera along the view direction, and
         watch it fly from where you are standing - aim at the pin, a
         tree or a slope and press B to test a collision directly
  SPACE  drop the ball under the camera and play from there
         (the pose + hole are saved: a reload comes back to them, F forgets)

  START  straight into the game (the save, else classic hole 1). Any of
         free cam, ?hole=, ?auto= or ?putt= takes over instead; set
         DEV_SKIP_MENU = 0 in game.js for the title screen.

  URL    ?hole=N &seed=S &auto=1 &fast=1 &putt=1 &trees=K &remix=1
  HOOKS  DBG() JUMP(h) SWING() PREVIEW(v) NICE() HOLEOUT()
         WIND(speed, degrees) - degrees is the way the wind PUSHES the
         ball: 0 downrange, 90 right, 180 into your face. ~3.4yd of
         drift per unit on a driver. WIND() reports without changing.
  RANGE()       turns this hole into a flat practice range: long and wide,
                no hills, trees, hazards or wind, so a club can be read
                with nothing acting on it. Terrain alone swings a real
                carry -27%..+14%, which is why an on-course number cannot
                calibrate a club. Hit it with X. R replays the range,
                [ ] walks off it.
  TELEMETRY()   every shot, tree strike and hole of this session, as JSON.
                TELEMETRY(1) saves it to a file to hand over.`);
        // free cam mouse look: click locks the pointer, movement turns the
        // camera (addEventListener - the engine owns window.onmousemove)
        addEventListener('mousemove', (e)=>
        {
            if (freeCam && document.pointerLockElement)
            {
                camYaw += e.movementX*.003;
                camPitch = clamp(camPitch + e.movementY*.003, -1.5, 1.5);
            }
        });
        // harness hooks - dev build only, stripped from release
        const q = new URLSearchParams(location.search);
        autoPlay = +q.get('auto') || 0;
        fastMode = +q.get('fast') || 0;
        if (q.get('trees') != null) forestMul = +q.get('trees'); // forest density knob
        const jumpHole = q.get('hole');
        const puttTest = +q.get('putt');
        const seed = q.get('seed');
        if (seed) { courseSeed = +seed; }
        if (jumpHole !== null && jumpHole !== undefined && jumpHole !== '')
        {
            remixMode = seed ? 1 : 0;
            courseRows = genCourse(courseSeed, remixMode);
            holeIndex = clamp(+jumpHole-1|0, 0, 17);
            scores = [];
            startHole();
        }
        else if (autoPlay)
            startCourse(+q.get('remix') || 0);
        if (puttTest && H)
        {
            // drop the ball on the green for putt-view testing
            ball.x = H.green.x + Math.min(H.gr-3, 7);
            ball.z = H.green.z;
            ball.y = groundAt(ball.x, ball.z).h;
            enterAim();
        }
        // free cam: come back to the saved hole and pose (press F to stop)
        const savedCam = localStorage['rg_cam'];
        if (savedCam)
        {
            const [h, x, y, z, yaw, pitch] = savedCam.split(',').map(Number);
            holeIndex = h;
            startHole();
            freeCam = 1;
            camX = x; camY = y; camZ = z; camYaw = yaw; camPitch = pitch;
        }
        // With nothing else asked for, skip the menu and carry on from the
        // save. Anything that names a starting point beats it: the free cam
        // pose, then ?hole=, ?auto= and ?putt=.
        else if (DEV_SKIP_MENU && !jumpHole && !autoPlay && !puttTest)
            savedGame ? continueGame() : startCourse(0);
        // TELEMETRY() prints and returns the log; TELEMETRY(1) also saves it
        // as a file, which is the easy way to hand a round over.
        window['TELEMETRY'] = (save)=>
        {
            const j = JSON.stringify(telem, 0, 1);
            if (save)
            {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([j]));
                a.download = 'telemetry.json';
                a.click();
            }
            console.log(j);
            console.log(`${telem.length} records - TELEMETRY(1) saves a file`);
            return telem;
        };
        window['DBG'] = ()=> ({state, stateTime, holeIndex, strokes, scores, placeView, clubI, spinMode, shotTarget, trail: trail.length,
            verts: glStaticCount, fps: averageFPS|0, trees: H && H.trees.length,
            par: H && H.par, ball: {x:ball.x, y:ball.y, z:ball.z},
            cam: {x:camX, y:camY, z:camZ, yaw:camYaw, pitch:camPitch},
            surf: H && SURF_NAMES[groundAt(ball.x, ball.z).s]});
        window['PREVIEW'] = (v)=> placeView = v; // harness: landing-preview cam on/off
        window['NICE'] = ()=> niceShot = 1; // harness: rainbow trail screenshot
        window['JUMP'] = (h)=> { holeIndex = clamp(h-1, 0, 17); startHole(); }
        window['SWING'] = ()=> state == ST_AIM && botSwing(); // harness: deterministic shot
        window['HOLEOUT'] = ()=> { strokes = strokes || 3; endHole(); } // harness: scorecard flow
        // WIND(speed, degrees) - DEGREES, and the direction the wind PUSHES
        // THE BALL: 0 downrange, 90 right, 180 into your face. Omit either to
        // keep it. Each unit is ~3.4yd of drift on a driver.
        window['WIND'] = (s, deg)=>
        {
            if (s != null) H.wind.s = s;
            if (deg != null) H.wind.a = deg*Math.PI/180;
            state == ST_AIM ? enterAim() : updatePredict();
            return {speed: +H.wind.s.toFixed(2), degrees: +(H.wind.a*180/Math.PI).toFixed(1)};
        }
        // RANGE() - replace this hole with a flat practice range: a long
        // wide corridor, no hills, no trees, no hazards and no wind, so a
        // club's carry can be read with nothing else acting on it. Terrain
        // alone swings a real carry -27%..+14% depending on where it comes
        // down, which is why an on-course number cannot calibrate a club.
        // Pairs with X (perfect swing) and the per-shot console line.
        // It overwrites this hole's row, so R replays the range and [ ]
        // walks off it. The save is protected the way R protects it.
        window['RANGE'] = ()=>
        {
            const keep = savedGame;
            courseRows[holeIndex] = [5, 1.2, 80, 0, 0, 0, 0, 0];
            startHole({a: 0, s: 0});
            enterAim();
            savedGame = keep;
            keep ? localStorage['rg_save'] = keep : delete localStorage['rg_save'];
            return 'flat range: ' + (H.len|0) + 'yd, no wind';
        }
    }
}

function gameUpdate()
{
    ++stateTime;
    if (msgTimer > 0) --msgTimer;
    trailPrune(time);

    if (debug)
    {
        if (!soundEnable && mouseWasPressed(0))
            setSoundEnable(1); // the first click turns the sound on
        // debug: M = top-down hole map, [ ] = previous/next hole, F = fly cam
        if (keyWasPressed('KeyM'))
        {
            mapView = !mapView;
            stateTime = 0; // the intro replays when the map closes
        }
        const skip = (keyWasPressed('BracketRight')?1:0) - (keyWasPressed('BracketLeft')?1:0);
        if (skip)
        {
            holeIndex = (holeIndex + 18 + skip)%18;
            startHole();
            puttMode && puttDrop(); // stay on the greens while hopping holes
        }
        if (keyWasPressed('KeyF') && !(freeCam = !freeCam))
            delete localStorage['rg_cam']; // leaving free cam forgets the spot
        if (keyWasPressed('KeyC'))
            showColl = !showColl; // tree collision volumes
        if (keyWasPressed('KeyK'))
            grabShot = 1; // screenshot, taken at the top of gameRenderPost
        // X = perfect swing, from the aim or from under a running meter
        if (keyWasPressed('KeyX') && (state == ST_AIM || state == ST_SWING))
            perfectSwing();
        if (keyWasPressed('KeyR'))
        {
            // REMIX: re-roll this hole with a new seed. CLASSIC: replay the
            // hole exactly as it is, strokes back to zero - the classic 18
            // is the authored course, so re-rolling it is the one thing you
            // never want while practising a specific hole.
            // CLASSIC also keeps the WIND. genHole draws a fresh one per
            // play, so a replay would otherwise be the same land under new
            // weather - and the point of R in classic is to change nothing
            // at all, so the same shot can be hit twice and compared.
            // Remix re-rolls it, since remix is asking for a new hole.
            // Straight to the tee, no flyback: the intro is a tour of a hole
            // you have just chosen to replay, and R is pressed to get back to
            // hitting. Same skip continueGame uses mid-hole.
            // A debug re-roll must not overwrite a real round, and enterAim
            // DOES write a save - so the save is put back afterwards. (This
            // leaked before via puttMode's puttDrop, which also ends in
            // enterAim; the comment claimed R never saved, and it did.)
            const keep = savedGame, wind = H.wind;
            if (remixMode)
            {
                courseSeed = randInt(1e6)+1;
                courseRows = genCourse(courseSeed, remixMode);
            }
            startHole(remixMode ? 0 : wind);
            puttMode ? puttDrop() : enterAim();
            savedGame = keep;
            keep ? localStorage['rg_save'] = keep : delete localStorage['rg_save'];
        }
        if (keyWasPressed('KeyP') && (puttMode = !puttMode))
            puttDrop();
        if (mapView)
            return; // game input frozen under the map
    }
    if (debug && freeCam)
    {
        // fly cam: W/S along the view, A/D strafe, Q/E down/up, T/G pitch,
        // shift = fast, click = mouse look, F to exit. SPACE drops the ball
        // under the camera so any lie can be tested directly.
        if (keyWasPressed('Space'))
        {
            ball.x = camX; ball.z = camZ;
            ball.y = ballGround().h;
            ball.vx = ball.vy = ball.vz = 0;
            strokes = 0;   // so the par+5 mercy rule does not fire mid-test
            freeCam = 0;
            delete localStorage['rg_cam']; // playing again: forget the view
            enterAim();
            return;
        }
        // B THROWS the ball from the camera along the view direction, and
        // the flight is stepped right here so the camera stays put and you
        // can watch it from wherever you were standing. Aim at the pin, at a
        // tree, at a slope, and press B - it is the fastest way to test a
        // collision without playing a shot into it.
        const cpv = Math.cos(camPitch);
        if (keyWasPressed('KeyB'))
        {
            ball.x = camX; ball.y = camY; ball.z = camZ;
            shotBegin(1);   // airborne: also clears bounces and ballEvent
            ball.vx = Math.sin(camYaw)*cpv*THROW_V;
            ball.vy = -Math.sin(camPitch)*THROW_V;
            ball.vz = Math.cos(camYaw)*cpv*THROW_V;
            shotDir = camYaw;   // the trail ribbon and any curve follow it
            trail = [];
        }
        // keep a thrown ball flying while the free cam sits still
        if (ballAir || ballRolling)
        {
            ballUpdate();
            // same every-other-frame cadence as a real shot (game.js:462).
            // Without the gate the B-throw laid down a trail at DOUBLE the
            // density of the one the game draws, which is misleading when
            // the throw is the tool being used to judge how the trail looks.
            if (!(frame%2)) trailPush(time);
            if (treeHit) { showMsg('TREE!'); treeHit = 0; }
        }
        const sp = keyIsDown('ShiftLeft') ? 4 : 1, cp = cpv;
        const fwd = (keyIsDown('KeyW')?1:0) - (keyIsDown('KeyS')?1:0);
        const str = (keyIsDown('KeyD')?1:0) - (keyIsDown('KeyA')?1:0);
        camX += (Math.sin(camYaw)*cp*fwd + Math.cos(camYaw)*str)*sp;
        camZ += (Math.cos(camYaw)*cp*fwd - Math.sin(camYaw)*str)*sp;
        camY += -Math.sin(camPitch)*fwd*sp + ((keyIsDown('KeyE')?1:0) - (keyIsDown('KeyQ')?1:0))*sp*.6;
        camPitch += ((keyIsDown('KeyT')?1:0) - (keyIsDown('KeyG')?1:0))*.02;
        // Remember hole + pose so a reload comes back to this exact view:
        // tweak a constant, reload, and judge the change from the same spot
        // instead of flying back to it. Array -> string is comma-joined.
        // Twice a second, not every frame - localStorage writes block.
        if (!(frame % 30))
            localStorage['rg_cam'] = [holeIndex, camX, camY, camZ, camYaw, camPitch];
        if (mouseWasPressed(0) && !document.pointerLockElement)
            try { glCanvas.requestPointerLock()?.catch?.(()=>0); } catch (e) {}
        camY = Math.max(camY, groundAt(camX, camZ).h + 1);
        return; // game input frozen while flying
    }

    // music in the quiet states only - never under a swing
    if (MUSIC && (state < ST_AIM || state > ST_FLIGHT))
        updateMusic();
    [updateTitle, updateIntro, updateAim, updateSwing,
     updateFlight, updateHoleOut, updateResults][state]();
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
    // THE INTRO CAMERA, on the fixed step like the chase cam below. It
    // lived in gameRender until 2026-08-31, and its float-down cap is
    // SMOOTHING STATE: stepping per RENDERED frame it fell at full speed
    // through slow motion (Frank caught it with the - key) and 2.4x too
    // fast on a 144Hz screen. The 08-29 chase-cam lesson, relearned.
    // One continuous pull-back: hover short of the green facing the pin,
    // fly backwards along the hole path into the tee-shot camera
    // (setSwingCam's pose, blended in over the last 30%). The 20yd head
    // start keeps the pin ahead of the camera from frame 0.
    if (state == ST_INTRO && !(debug && (freeCam || mapView)))
    {
        const e = smoothStep(clamp(stateTime/INTRO_T));
        const a = pathPointAt(H.len*(1-e) - 20);
        const w = clamp((e-.7)/.3);
        // The descent cap chains from the previous UPDATE's height - read
        // BEFORE setSwingCam overwrites camY with the tee pose (p211) -
        // EXCEPT on entry: a new hole is a deliberate CUT, so the camera
        // STARTS at the hover height instead of floating down from
        // wherever the last hole's camera happened to be. Hole heights
        // are unrelated coordinate spaces; chaining across them was the
        // start-high dip Frank saw opening H2.
        // -1e9: on entry the cap must LOSE the max below (y0 - INTRO_FALL
        // very low), so the camera takes the hover height directly. +1e9
        // here shipped for one commit and put the camera a billion yards
        // up - sky and clouds only, world gone, float jitter as shaking.
        const y0 = stateTime > 1 ? camY : -1e9;
        setSwingCam(aimYaw, 0);
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
        camYaw = lerp(Math.atan2(H.pin.x-camX, H.pin.z-camZ), camYaw, w);
        camPitch = lerp(.3 - e*.2, camPitch, w);
    }

    // The HOLD matters as much as the smoothing: at launch the camY target
    // (ball.y + 5) sits BELOW where setSwingCam left the camera, so chasing
    // at once dipped the view before climbing. Holding lets the ball get
    // above the camera first, so the first move is upward. A putt needs no
    // hold: setSwingCam's putt pose IS 5 back and 3 up, so the camera starts
    // already on target and just rolls with the ball.
    const putt = clubI == CLUB_PUTTER;
    if (state == ST_FLIGHT && (putt || stateTime > CAM_HOLD)
        && !(debug && (freeCam || mapView)))
    {
        // The target is a fixed offset BEHIND the ball, so break slides the
        // camera sideways and the ball holds its place on screen. That is
        // why the putt still needs no yaw of its own in gameRender.
        // 8 BACK, not 16: the ball is a third the size it used to be, and at
        // 8yd it reads 8.3px on a 900px screen against the old ball's 7.7px
        // at 16. Note this distance barely matters in FAST flight - at 60yd/s
        // the .05 smoothing settles about 20yd behind its own target whatever
        // it is - so what it really sets is the framing as the ball slows and
        // stops, which is when it is actually being looked at.
        // A PUTT is watched from much closer and much lower - 3yd back and
        // barely over the ball - so the roll reads at ball height, which is
        // the whole point of a putt cam. The pitch floors its distance at 8
        // (Math.max(hd, 8) below), so coming in this close tilts the view
        // only a few degrees instead of nosing down into the grass.
        const back = putt ? 3 : 8, up = putt ? 1.5 : 3;
        camX = lerp(camX, ball.x - Math.sin(shotDir)*back, .05);
        camZ = lerp(camZ, ball.z - Math.cos(shotDir)*back, .05);
        camY = lerp(camY, Math.max(ball.y + up, groundAt(camX, camZ).h + up*.8), .05);
    }
    ++camEase; // fixed step, so the settle ease is frame-rate independent
}

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
    if (debug && freeCam)
    {
        renderView3d();
        return;
    }
    if (state == ST_TITLE)
    {
        // slow orbit around the first green
        camYaw = time*.1;
        camX = H.green.x - Math.sin(camYaw)*20;
        camZ = H.green.z - Math.cos(camYaw)*20;
        camY = groundAt(camX, camZ).h + 8;
        camPitch = -.1;
        renderView3d();
    }
    else
    {
        const putt = clubI == CLUB_PUTTER;
        // (the INTRO camera is set in gameUpdatePost, on the FIXED step:
        // its float-down cap is smoothing state, and smoothing at render
        // rate is the 08-29 chase-cam lesson all over again - Frank caught
        // it falling at full speed through slow motion)
        // ...and NOTHING until the hold expires. state is ST_FLIGHT so the
        // ST_AIM branch below cannot fire either, which leaves the camera
        // exactly as setSwingCam left it - frozen pose, frozen aim. It used
        // to keep pitching toward the ball through the hold, so the camera
        // was standing still while tilting, which still read as movement.
        if (state == ST_FLIGHT && !putt && stateTime > CAM_HOLD)
        {
            // just the aim: the position it looks FROM is smoothed on the
            // fixed step in gameUpdatePost. These two are pure functions of
            // the camera and the ball, so they are free to run per rendered
            // frame and should - they keep the view pointed at the ball.
            const hd = Math.hypot(ball.x-camX, ball.z-camZ);
            // Yaw needs no ease even though it resumes cold after the
            // hold: the camera has not moved and the ball has flown almost
            // straight away from it, so the angle barely changes. MEASURED
            // in an 8-unit crosswind - the stress case - the resume step is
            // 0.18 degrees and the worst single frame anywhere is the same.
            camYaw = Math.atan2(ball.x-camX, ball.z-camZ);
            // Pitch does: setSwingCam leaves it flat at .1 and this starts
            // at .46, so setting it directly snapped 21 degrees down on the
            // first frame. stateTime counts FIXED updates, so easing on it
            // needs no smoothing state. The .1 must match setSwingCam.
            camPitch = lerp(.1, Math.atan2(camY - ball.y - 1, Math.max(hd, 8)),
                smoothStep(clamp((stateTime - CAM_HOLD)/30)));
        }
        else if (state == ST_AIM || state == ST_SWING)
        {
            placeView ? setPlaceCam(putt) : setSwingCam(aimYaw, putt);
            // Blend FROM the stored pose rather than from last frame's, so
            // the ease is exact and lands on the swing camera, and reads the
            // same at 60Hz and 144Hz. Yaw wraps - a settle can leave the
            // camera either side of the new heading.
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
        // HOLEOUT / RESULTS / putt flight keep the last camera
        renderView3d();
    }
}

///////////////////////////////////////////////////////////////////////////////
// (engineInit lives at the end of hud.js: it names gameRenderPost, so it has
// to run after hud.js has defined it, and hud.js loads last.)
