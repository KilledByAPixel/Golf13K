'use strict';

/*  SUNSHINE GOLF CLASSIC - the dev-only layer
 *
 *  NOTHING IN THIS FILE SHIPS. Every entry point is called from a
 *  `debug && ...` site, and `debug` is a compile-time 0 in the release
 *  (engineRelease.js), so Closure deletes the lot as dead code. That is
 *  the point of the file: when hunting bytes, skip it entirely.
 *
 *  The four entry points, each called from one place:
 *    devInit()          - gameInit: console help, URL params, window hooks
 *    devUpdate()        - gameUpdate: debug keys + free cam. Returns 1 when
 *                         it has swallowed the frame (map open, or flying)
 *    devHud(midX, T)    - gameRenderPost: the mode banners. Returns 1 when
 *                         it owns the frame and the HUD must not draw
 *    pushCollGL()       - renderViewGL: collision volumes (C key)
 *  ...plus the bot (botSwing), the practice tools (perfectSwing, puttDrop),
 *  the screenshot (saveShot), and the telemetry log.
 *
 *  THE DEBUG KEYS ARE OFF BY DEFAULT. This build is PUBLIC as the "enhanced
 *  version" on GitHub Pages, so every key below is gated on CHEATS(), a
 *  console toggle held in localStorage['sg_cheats'] exactly like SKIP().
 *  N (enhanced mode) and the gamepad are not cheats and stay live.
 *
 *  LOAD ORDER: after game.js, before hud.js. Only hud.js runs anything at
 *  load time (engineInit at its bottom), so every const here is
 *  initialised before the game starts.
 */

///////////////////////////////////////////////////////////////////////////////
// DEV FLAGS - the knobs worth reaching for

// (skipping the menu is no longer a const - it is SKIP() in the console,
// stored in localStorage['sg_skip'], so it survives edits and reloads and
// can be flipped mid-session without touching the source)
// 1 = locked title layout for grabbing the js13k thumbnail.
// It is read OUTSIDE a debug gate in hud.js, so leaving it at 1 changes
// the RELEASE: Closure folded the title on and deleted the menu, HUD and
// scorecard as dead code (p217, a build that read 1,669 "under").
const DEV_THUMBNAIL = 0;
const THROW_V = 45; // yd/s the free cam's B key throws the ball at

///////////////////////////////////////////////////////////////////////////////
// dev state

let autoPlay = 0, fastMode = 0, freeCam = 0, mapView = 0; // bot, fast-forward, fly cam, hole map
let puttMode = 0;   // drop on the green and putt, over and over
let showColl = 0;   // C: draw the collision volumes
// CHEATS: the debug keys, off unless CHEATS() has been run in this browser.
// Read once at load; CHEATS() flips both the flag and the stored copy.
let cheatsOn = !!localStorage['sg_cheats'];

///////////////////////////////////////////////////////////////////////////////
// ENHANCED MODE - the home for things the 13k build has no room for.
// Debug only, and free to the release for the usual reason: every read below
// is behind `debug &&`, `debug` is a compile-time 0 there, and build.mjs's
// FEATURES.gamepad=false additionally turns `gamepadsEnable` into a constant
// false so Closure deletes the engine's whole gamepad subsystem. Nothing here
// can reach the zip. N toggles it; it starts ON, since debug is where it lives.
let enhanced = 1;

// The engine already folds the D-PAD into stick 0 (gamepadDirectionEmulateStick)
// and applies its own dead zone, so ONE stick read covers both, analog and
// digital. Turning is the one that wants to stay analog: `dir` feeds the same
// turnHold ramp the arrows use, so a light push gives a genuinely slow turn -
// the finest aim control the game has, better than the buttons it emulates.
const padOn = ()=> enhanced && isUsingGamepad;
const padTurn = ()=> padOn() ? gamepadStick(0).x : 0;
// club and distance step, so they read as presses rather than a slide:
// D-pad up/down = club (matching the arrow keys), shoulders = distance
const padClub = ()=> padOn() ? gamepadWasPressed(13) - gamepadWasPressed(12) : 0;
const padDist = ()=> padOn() ? gamepadWasPressed(4) - gamepadWasPressed(5) : 0;
// A is the click - every phase of the three-click swing, exactly like Space
const padClick = ()=> padOn() && gamepadWasPressed(0);
// B toggles the landing preview, which a mouse does with a click on the view
// X (button 2 in the standard mapping) cycles spin, the chip's job otherwise

// Which menu row the pad is on, 0 CONTINUE / 1 CLASSIC / 2 REMIX. Only ever
// shown once a pad has actually been used, so a mouse player never sees it.
let padMenu = 1; // CLASSIC: the row a new player wants
let padHeld = 0; // stick already pushed sideways, so a hold steps once
let gridAid = 0;    // G: the slope-grid landing aid instead of the ring
let grabShot = 0;   // K arms it here, gameRenderPost takes it (see saveShot)
// distance at the FIRST TOUCHDOWN, latched once per shot. -1 = the ball has
// not come down yet. A putt never flies, so it records ~0 on the first
// frame, which is the honest answer for a shot that is all roll.
let carryDist = -1;

// One record per shot, tree strike, hole and round start. TELEMETRY()
// prints and returns it, TELEMETRY(1) downloads it as JSON. EVERY call
// site is `debug && tlog(...)`.
// IT SURVIVES A RELOAD, which is the whole point: the log used to live only
// in memory, so resuming a round through CONTINUE started a fresh one and
// threw the holes already played away - Frank lost the front nine of a round
// that way. Each record is written straight through to localStorage, and a
// NEW ROUND ('round' is logged by startCourse) is what clears it, so a
// continue keeps the round it is continuing.
let telem = [];
const tlog = (e, d)=>
{
    e == 'round' && (telem = []);
    telem.push({e, hole: holeIndex+1, stroke: strokes, ...d});
    localStorage['sg_telem'] = JSON.stringify(telem);
};
// event names for the console and telemetry; the game speaks EV_ integers
const EV_NAMES = [,'holed','stopped',,,'water','ob'];

///////////////////////////////////////////////////////////////////////////////
// tools

// K: save a PNG of glCanvas alone. The grab has to happen INSIDE the frame
// that drew the picture - glCanvas has no preserveDrawingBuffer, so the
// buffer is gone the moment the browser composites and a read from an
// update (or a setTimeout, or a promise) comes back blank. Same reason it
// is toDataURL and not toBlob: toDataURL encodes synchronously.
// glCanvas ONLY - the HUD is a separate overlayCanvas, so it is not in the
// image at all: no hiding, no flag, nothing to remember to undo.
function saveShot()
{
    grabShot = 0;
    const a = document.createElement('a');
    a.href = glCanvas.toDataURL();
    a.download = `golf-h${holeIndex+1}-${Date.now()%1e7}.png`;
    a.click();
}

// X: full power, dead centre, so a club or a spin can be read with no
// meter noise. A PUTT gets the exact distance to the cup on the current
// line, so it should drop every time on a flat green and show the break on
// a sloped one.
function perfectSwing()
{
    ++strokes;
    const isPutt = clubI == CLUB_PUTTER;
    tlog('shot', {club: CLUBS[clubI][0], lie: SURF_NAMES[ballGround().s],
        toPin: ballToPin()|0, target: shotTarget|0, power: 1,
        impact: 0, spin: spinMode, perfect: 1,
        wind: +hole.wind.s.toFixed(1), windDir: +(hole.wind.a - aimYaw).toFixed(2)});
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

// P: drop the ball somewhere on the green and putt. Holing out re-drops it
// instead of ending the hole, so putting can be worked on without playing
// a hole to reach a green each time.
function puttDrop()
{
    // out near the green's edge and roughly opposite the pin, so every drop
    // is a real putt with some break in it rather than a tap-in
    const pa = Math.atan2(hole.pin.x-hole.green.x, hole.pin.z-hole.green.z);
    const a = pa + Math.PI + rand(1.6, -1.6), d = hole.gr*rand(1, .6);
    ball.x = hole.green.x + Math.sin(a)*d;
    ball.z = hole.green.z + Math.cos(a)*d;
    ball.y = ballGround().h;
    ball.vx = ball.vy = ball.vz = 0;
    strokes = 0;
    enterAim();
}

///////////////////////////////////////////////////////////////////////////////
// auto-play bot: plays reasonable shots so full rounds can run headless

// Leaving the free cam by ANY route (F, or M opening the map) forgets the
// saved pose, so a reload does not drop you back into a camera you walked
// away from. Only writes when it was actually on.
const exitFreeCam = ()=> { if (freeCam) { freeCam = 0; delete localStorage['sg_cam']; } }

// where the bot's last swing was taken from: its stuck detector
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
        wind: +hole.wind.s.toFixed(1), windDir: +(hole.wind.a - aimYaw).toFixed(2), bot: 1});
    if (clubI == CLUB_PUTTER)
    {
        aimAtPin();
        // PUTT_OVER is what the GAME'S OWN default target uses - the bot was
        // asking for 1.06, barely past the cup, so any putt with a rise or a
        // slow lie in it died short. Frank, watching a round: "completely
        // didn't hit it hard enough, didn't go close enough to get in."
        launchPutt(d*PUTT_OVER, aimYaw + rand(.012,-.012));
        // the tap the meter plays for a person, at the bot's own power (the
        // bot never goes through the meter, so T mode swung in silence)
        snd_putt.play(.4 + Math.min(1, d*PUTT_OVER/PUTT_MAX)*.6);
    }
    else
    {
        // long shots target the fairway landing zone, wind compensated
        // over the time of flight (2*vy/g)
        const carry = CLUBS[clubI][1]*lie;
        distToPath(ball.x, ball.z);
        const atPin = d <= carry+20;
        const tgt = atPin ? hole.pin : pathPointAt(Math.min(lastAlong + carry*.95, hole.len));
        // the bot's own drift estimate has to carry the airspeed term too,
        // or it corrects for a wind 50x the one the ball will actually feel
        const lv = launchVel({}, clubI, 0, lie);
        const tf = 2*lv.vy/GRAV;
        const drift = hole.wind.s*DRAG_K*WIND_V*Math.hypot(lv.vx, lv.vz)*tf*tf/2;
        const tx = tgt.x - Math.sin(hole.wind.a)*drift, tz = tgt.z - Math.cos(hole.wind.a)*drift;
        aimYaw = Math.atan2(tx-ball.x, tz-ball.z);
        let td = Math.hypot(tgt.x-ball.x, tgt.z-ball.z);
        // THE HEAD/TAIL HALF OF THE WIND, which nothing handled: the drift
        // above only ever moved the aim SIDEWAYS. Naive on purpose (Frank:
        // "just in a naive way... we don't want perfect shots every time") -
        // measured at wind 11 the carry moves -11%..+13% across the whole
        // bag, so a flat 1% per yard/second of the along-aim component is the
        // entire model.
        td *= 1 - Math.cos(hole.wind.a - aimYaw)*hole.wind.s*.01;
        // ...and LAND IT SHORT of a flag. power sets the CARRY, so aiming the
        // carry at the pin lands ON it and then releases 8-13yd past
        // (measured green roll, 7i/PW/SW) - which is Frank's "it would hit
        // past the pole a lot of times". Only when going at the flag; a layup
        // wants its full number.
        if (atPin) td *= .92;
        const pw = clamp(td/carry, .12, 1);
        launchBall(clubI, pw, rand(.04,-.04), 0, aimYaw + rand(.015,-.015), lie);
        // the strike the meter plays for a person, same volume/pitch curve
        snd_tee.play(.5 + pw*.5, .8 + pw*.4);
    }
    startFlight();
}

///////////////////////////////////////////////////////////////////////////////
// C: the collision volumes flyStep tests - canopy sphere (red) and trunk
// cylinder (yellow), plus the pin post (cyan), translucent and drawn
// through the geometry.

function pushCollGL()
{
    for (const t of hole.near)
    {
        // t.y IS the canopy centre (course.js bakes trunkH into it), so the
        // sphere sits AT t.y and the trunk column runs from the ground UP
        // to it. Drawing either relative to the ground double-counted the
        // trunk and floated both volumes.
        const s = t.s, r = s*TRUNK_R, th = trunkH(t);
        pushLathe(vec3(t.x, t.y, t.z), [[0,-s],[s*.7,-s*.7],[s,0],[s*.7,s*.7],[0,s]], 8, new Color(1,0,0,.35));
        // flyStep's trunk test is `dy < 0` - unbounded downward - so the
        // column is drawn over the part that can actually be reached
        pushLathe(vec3(t.x, t.y - th, t.z), [[r,0],[r,th]], 8, new Color(1,1,0,.4));
    }
    // the pin post's strike volume: POST_R wide, cup up to POLE_H, exactly
    // the window ballUpdate tests
    const g = heightAt(hole.pin.x, hole.pin.z);
    pushLathe(vec3(hole.pin.x, g, hole.pin.z), [[POST_R, 0], [POST_R, POLE_H]], 8, new Color(0,1,1,.4));
}

///////////////////////////////////////////////////////////////////////////////
// the HUD's mode banners. Returns 1 when this owns the frame.

function devHud(midX, T)
{
    if (mapView)
    {
        txt(`MAP - HOLE ${holeIndex+1} · PAR ${hole.par} · ${hole.len|0}yd · [ ] = PREV/NEXT HOLE · M = EXIT`,
            midX, T-T*.04, T*.024);
        return 1;
    }
    if (freeCam && !DEV_THUMBNAIL)
    {
        txt('FREE CAM - WASD move · Q/E height · CLICK = MOUSE LOOK · T/G pitch · SPACE drop ball · F exit',
            midX, T-T*.04, T*.024);
        return 1;
    }
    if (puttMode)
        txt('PUTT MODE - HOLING OUT RE-DROPS · P EXITS', midX, T-T*.04, T*.024);
    // THE PAD'S MENU HIGHLIGHT. devHud paints BEFORE the title menu, which
    // turns out to be exactly right: `panel` fills #000a, only two thirds
    // opaque, so a bright rounded rect drawn UNDER it gives both halves of
    // what Frank asked for at once - the oversized edge survives as a solid
    // outline, and the part the panel covers tints through as a brighter
    // background. No hook in hud.js, so the release pays nothing.
    // Only once a pad has actually been used, so a mouse player never sees it.
    if (padOn() && state == ST_TITLE && !DEV_THUMBNAIL)
    {
        const r = menuRect(padMenu), p = r.h*.08, c = overlayContext;
        c.fillStyle = GOLD;
        c.beginPath();
        // QUOTE roundRect, and keep the rect fallback, for the same reason
        // hud.js's panel does - see the note there.
        (c['roundRect'] || c.rect).call(c, r.x-p, r.y-p, r.w+p*2, r.h+p*2, r.h*.38);
        c.fill();
    }
    // Top CENTRE, between the HOLE/PAR and SCORE readouts, which are the two
    // corners hud.js already owns. It deliberately does NOT return 1: the
    // whole point is to watch the bot play through the normal HUD.
    if (autoPlay)
        txt('AI TEST MODE', midX, T*.2, T*.03);
}

///////////////////////////////////////////////////////////////////////////////
// debug keys and the free cam. Returns 1 when the frame is swallowed.

function devUpdate()
{
    if (!soundEnable && mouseWasPressed(0))
        setSoundEnable(1); // the first click turns the sound on
    // THE MAP AND THE FREE CAM ARE EXCLUSIVE. They used to stack: M over a
    // free cam opened the map but left freeCam set, so closing the map
    // dropped you back into a camera you thought you had left. Now M exits
    // the free cam and F exits the map, so leaving either lands in the game.
    if (cheatsOn && keyWasPressed('KeyM'))
    {
        mapView = !mapView;
        exitFreeCam();
        stateTime = 0; // the intro replays when the map closes
    }
    const skip = cheatsOn ? (keyWasPressed('BracketRight')?1:0) - (keyWasPressed('BracketLeft')?1:0) : 0;
    if (skip)
    {
        holeIndex = (holeIndex + 18 + skip)%18;
        startHole();
        puttMode && puttDrop(); // stay on the greens while hopping holes
    }
    if (cheatsOn && keyWasPressed('KeyF'))
    {
        mapView = 0; // F from the map flies instead of stacking
        freeCam ? exitFreeCam() : freeCam = 1;
    }
    if (cheatsOn && keyWasPressed('KeyC'))
        showColl = !showColl;
    if (cheatsOn && keyWasPressed('KeyG') && !freeCam) // (G is the free cam's pitch-down)
        gridAid = !gridAid; // swap the landing ring for the slope grid
    if (keyWasPressed('KeyN'))
        enhanced = !enhanced; // ENHANCED MODE (gamepad, and whatever follows)
    // B on the pad does what a click on the view does: the landing preview.
    // Here rather than in game.js because it is a whole extra input path, not
    // a term added to one the game already reads.
    // ...INCLUDING the click sound. Copying the two lines of state and
    // forgetting the third is exactly the drift that comes of duplicating a
    // handler instead of sharing one; the mouse path in updateAim is the
    // reference, and it ends `snd_tick.play()`.
    if (padOn() && gamepadWasPressed(1) && state == ST_AIM)
    {
        placeView = !placeView, camEase = SETTLE_T;
        snd_tick.play();
    }
    // T: AI TEST MODE. The bot plays the game the way a person does - aims,
    // swings, walks on to the next hole - so a round can be WATCHED instead
    // of read off the sim's totals. Everything it needs already existed for
    // `?auto=1`: updateAim hands over to botSwing, and the intro and the
    // hole-out card advance on their own clocks while autoPlay is set. All
    // this adds is a toggle mid-round, and the save guard in saveGame.
    // NOT while the free cam is up, where T is the pitch control.
    if (cheatsOn && keyWasPressed('KeyT') && !freeCam)
    {
        autoPlay = !autoPlay;
        // pressed at the title there is no round to watch, so deal one. Safe
        // over a real game: saveGame is a no-op for as long as this is on, so
        // the round in localStorage is untouched and CONTINUE still finds it.
        if (autoPlay && state == ST_TITLE)
            startCourse(0);
    }
    if (cheatsOn && keyWasPressed('KeyK'))
        grabShot = 1; // screenshot, taken at the top of gameRenderPost
    // X = perfect swing, from the aim or from under a running meter
    if (cheatsOn && keyWasPressed('KeyX') && (state == ST_AIM || state == ST_SWING))
        perfectSwing();
    if (cheatsOn && keyWasPressed('KeyR'))
    {
        // REMIX: re-roll this hole with a new seed. CLASSIC: replay the
        // hole exactly as it is, strokes back to zero - the classic 18
        // is the authored course, so re-rolling it is the one thing you
        // never want while practising a specific hole.
        // CLASSIC also keeps the WIND. genHole draws a fresh one per
        // play, so a replay would otherwise be the same land under new
        // weather - and the point of R in classic is to change nothing
        // at all, so the same shot can be hit twice and compared.
        // Straight to the tee, no flyback: the intro is a tour of a hole
        // you have just chosen to replay, and R is pressed to get back to
        // hitting. Same skip continueGame uses mid-hole.
        // A debug re-roll must not overwrite a real round, and enterAim
        // DOES write a save - so the save is put back afterwards.
        const keep = savedGame, wind = hole.wind;
        if (remixMode)
        {
            courseSeed = randInt(1e6)+1;
            courseRows = genCourse(courseSeed, remixMode);
        }
        startHole(remixMode ? 0 : wind);
        puttMode ? puttDrop() : enterAim();
        savedGame = keep;
        keep ? localStorage['sg_save'] = keep : delete localStorage['sg_save'];
    }
    if (cheatsOn && keyWasPressed('KeyP') && (puttMode = !puttMode))
        puttDrop();
    if (mapView)
        return 1; // game input frozen under the map
    // ENHANCED MODE, the rest of the pad. Driven from HERE rather than from
    // game.js on purpose: wiring turn/club/distance in as `+ (debug &&
    // pad...())` terms measured **+4 bytes**, because Closure folds each to
    // `+ 0` and then keeps the addition (it cannot prove the operand is a
    // number, and `x + 0` is not `x` for a string). Calling the game's own
    // functions from the dev file costs the release nothing at all, and the
    // one hook that CANNOT work this way - clickPressed, which the meter
    // reads - is free on its own.
    // devUpdate runs before updateAim in the same frame, so everything set
    // here is picked up by that frame's updatePredict.
    // THE TITLE MENU on a pad. Up/down moves the row, A picks it - through
    // menuPick, the same function the mouse goes through, so the remix lock
    // and the abandon confirm cannot drift out of step here.
    if (padOn() && state == ST_TITLE)
    {
        // LEFT/RIGHT, because the three buttons sit SIDE BY SIDE (menuRect
        // lays them out on x), and it WRAPS - `mod`, not `clamp`, so holding
        // right walks CONTINUE, CLASSIC, REMIX and back round.
        // The stick counts too, latched so a held stick steps once rather
        // than sprinting through the row every frame.
        const sx = gamepadStick(0).x, push = Math.abs(sx) > .5;
        const dm = gamepadWasPressed(15) - gamepadWasPressed(14)
            || (push && !padHeld ? Math.sign(sx) : 0);
        padHeld = push;
        if (dm)
        {
            padMenu = mod(padMenu + dm, 3);
            snd_tick.play();
        }
        // SWALLOW THE FRAME after a pick. devUpdate runs BEFORE gameUpdate
        // dispatches on `state`, so a pick that starts a round leaves the new
        // state's update to run in this same frame - and it sees the same A
        // still "was pressed", so the flyback intro was skipped the instant
        // it began. Returning 1 is devUpdate's existing contract for exactly
        // this: the frame is spent.
        if (gamepadWasPressed(0))
        {
            menuPick(padMenu + 1);
            return 1;
        }
    }
    if (padOn() && state == ST_AIM)
    {
        // STICK UP/DOWN is distance as well, and analog where the bumpers
        // step: the bumpers nudge a yard, the stick sweeps a club's worth.
        // No sound on this one - a tick every frame is a buzz, and the
        // bumpers already give the audible click.
        const sy = gamepadStick(0).y;
        if (sy)
            setTarget(shotTarget + sy*.5);
        // X = spin, which the release only offers on the chip
        if (gamepadWasPressed(2))
            clubI == CLUB_PUTTER || cycleSpin(); // still no spin on a putt
        // ANALOG TURN, and deliberately no turnHold ramp: the arrows need
        // one because a key is all-or-nothing, but a stick already gives
        // magnitude, so a light push is a slow turn by itself. This is the
        // finest aim control in the game.
        aimYaw += padTurn()*.005;
        const dc = padClub();
        if (dc)
        {
            clubI = clamp(clubI + dc, 0, CLUBS.length-1);
            resetTarget();
            snd_adjust.play();
        }
        const dd = padDist();
        if (dd)
        {
            setTarget(shotTarget - dd*TARGET_STEP);
            snd_adjust.play();
        }
    }
    if (!freeCam)
        return;

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
        delete localStorage['sg_cam']; // playing again: forget the view
        enterAim();
        return 1;
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
        // same every-other-frame cadence as a real shot. Without the gate
        // the B-throw laid down a trail at DOUBLE the density of the one
        // the game draws, which is misleading when the throw is the tool
        // being used to judge how the trail looks.
        if (!(frame%2)) trailPush(time);
        if (treeHit) { showMsg('TREE!'); treeHit = 0; }
    }
    const sp = keyIsDown('ShiftLeft') ? 4 : 1;
    const fwd = (keyIsDown('KeyW')?1:0) - (keyIsDown('KeyS')?1:0);
    const str = (keyIsDown('KeyD')?1:0) - (keyIsDown('KeyA')?1:0);
    camX += (Math.sin(camYaw)*cpv*fwd + Math.cos(camYaw)*str)*sp;
    camZ += (Math.cos(camYaw)*cpv*fwd - Math.sin(camYaw)*str)*sp;
    camY += -Math.sin(camPitch)*fwd*sp + ((keyIsDown('KeyE')?1:0) - (keyIsDown('KeyQ')?1:0))*sp*.6;
    camPitch += ((keyIsDown('KeyT')?1:0) - (keyIsDown('KeyG')?1:0))*.02;
    // Remember hole + pose so a reload comes back to this exact view:
    // tweak a constant, reload, and judge the change from the same spot
    // instead of flying back to it. Twice a second, not every frame -
    // localStorage writes block.
    if (!(frame % 30))
        localStorage['sg_cam'] = [holeIndex, camX, camY, camZ, camYaw, camPitch];
    if (mouseWasPressed(0) && !document.pointerLockElement)
        try { glCanvas.requestPointerLock()?.catch?.(()=>0); } catch (e) {}
    camY = Math.max(camY, groundAt(camX, camZ).h + 1);
    return 1; // game input frozen while flying
}

///////////////////////////////////////////////////////////////////////////////
// startup: console help, URL params, window hooks

function devInit()
{
    // pick the telemetry log back up (see tlog). In here rather than at the
    // declaration so it stays behind `debug` - a side-effecting initialiser
    // at file scope is the kind of thing Closure cannot prove away, and this
    // file's whole promise is that it costs the release nothing.
    try { telem = JSON.parse(localStorage['sg_telem']) || []; } catch {}
    // silence until the window is actually clicked. A live reload otherwise
    // fires a note (and a tick) at an unfocused window every time.
    setSoundEnable(0);
    setDebugKey('Backquote'); // Esc is the game's back-to-title key
    console.log(`SUNSHINE GOLF CLASSIC - dev build

  CHEATS ARE ${cheatsOn ? 'ON' : 'OFF - the keys below do nothing until CHEATS() is run here'}
  CHEATS()      toggle the debug keys. Kept in localStorage like SKIP(), so
                it survives reloads; CHEATS(1)/CHEATS(0) set it outright.
                Off by default: this build is public as the enhanced version.

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

  M and F are exclusive: the map exits the free cam, F from the map flies.

  SKIP()        toggle jumping straight into the game on reload - no title,
                no flyback, right back to the shot. Kept in localStorage, so
                it survives edits and rebuilds. Free cam, ?hole=, ?auto= and
                ?putt= all take over instead when present.
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
    // harness hooks
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
    if (puttTest && hole)
    {
        // drop the ball on the green for putt-view testing
        ball.x = hole.green.x + Math.min(hole.gr-3, 7);
        ball.z = hole.green.z;
        ball.y = groundAt(ball.x, ball.z).h;
        enterAim();
    }
    // free cam: come back to the saved hole and pose (press F to stop)
    const savedCam = cheatsOn && localStorage['sg_cam'];
    if (savedCam)
    {
        const [h, x, y, z, yaw, pitch] = savedCam.split(',').map(Number);
        holeIndex = h;
        startHole();
        freeCam = 1;
        camX = x; camY = y; camZ = z; camYaw = yaw; camPitch = pitch;
    }
    // With nothing else asked for, SKIP() carries on from the save.
    // Anything that names a starting point beats it: the free cam pose,
    // then ?hole=, ?auto= and ?putt=.
    else if (localStorage['sg_skip'] && !jumpHole && !autoPlay && !puttTest)
    {
        savedGame ? continueGame() : startCourse(0);
        // ...and straight to the shot: no title, no flyback. continueGame
        // already lands in aim MID-hole (the flyback ends at the tee and
        // the ball is not there); this covers the start of a hole, where
        // startHole leaves ST_INTRO.
        state == ST_AIM || enterAim();
    }
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
        verts: glStaticCount, fps: averageFPS|0, trees: hole && hole.trees.length,
        par: hole && hole.par, ball: {x:ball.x, y:ball.y, z:ball.z},
        cam: {x:camX, y:camY, z:camZ, yaw:camYaw, pitch:camPitch},
        surf: hole && SURF_NAMES[groundAt(ball.x, ball.z).s]});
    // SKIP() - toggle "jump straight into the game on reload": no title, no
    // flyback, straight to the shot you were about to play. Held in
    // localStorage, not a source const, so it outlives edits and rebuilds.
    // SKIP(1)/SKIP(0) set it outright.
    window['SKIP'] = (v = !localStorage['sg_skip'])=>
    {
        v ? localStorage['sg_skip'] = 1 : delete localStorage['sg_skip'];
        return v ? 'reload jumps into the game' : 'reload stops at the title';
    };
    window['CHEATS'] = (v = !cheatsOn)=>
    {
        cheatsOn = v;
        v ? localStorage['sg_cheats'] = 1 : delete localStorage['sg_cheats'];
        return v ? 'cheats on: debug keys live' : 'cheats off: debug keys ignored';
    };
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
        if (s != null) hole.wind.s = s;
        if (deg != null) hole.wind.a = deg*Math.PI/180;
        state == ST_AIM ? enterAim() : updatePredict();
        return {speed: +hole.wind.s.toFixed(2), degrees: +(hole.wind.a*180/Math.PI).toFixed(1)};
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
        keep ? localStorage['sg_save'] = keep : delete localStorage['sg_save'];
        return 'flat range: ' + (hole.len|0) + 'yd, no wind';
    }
}
