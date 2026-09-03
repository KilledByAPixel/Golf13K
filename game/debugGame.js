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
// DEV FLAGS

// (menu skipping is not a flag here: it is SKIP() in the console, see devInit)
// 1 = locked title layout for grabbing the js13k thumbnail. It is read
// OUTSIDE a debug gate in hud.js, so leaving it at 1 changes the RELEASE:
// Closure folds the title on and deletes the menu, HUD and scorecard.
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
// Free to the release: every read is behind `debug &&`, and build.mjs's
// FEATURES.gamepad=false makes `gamepadsEnable` a constant false so Closure
// deletes the engine's whole gamepad subsystem. N toggles it; starts ON.
let enhanced = 1;

// The engine folds the D-PAD into stick 0 (gamepadDirectionEmulateStick) with
// its own dead zone, so ONE stick read covers analog and digital. Turning
// stays analog (see devUpdate).
const padOn = ()=> enhanced && isUsingGamepad;
const padTurn = ()=> padOn() ? gamepadStick(0).x : 0;
// club and distance STEP, not slide: D-pad = club, shoulders = distance
const padClub = ()=> padOn() ? gamepadWasPressed(13) - gamepadWasPressed(12) : 0;
const padDist = ()=> padOn() ? gamepadWasPressed(4) - gamepadWasPressed(5) : 0;
// A is the click - every phase of the swing, exactly like Space
const padClick = ()=> padOn() && gamepadWasPressed(0);
// B (landing preview) and X (spin, button 2) are handled in devUpdate

// pad menu row, 0 CONTINUE / 1 CLASSIC / 2 REMIX; only drawn once a pad is used
let padMenu = 1; // CLASSIC: the row a new player wants
let padHeld = 0; // stick already pushed sideways, so a hold steps once
let gridAid = 0;    // G: the slope-grid landing aid instead of the ring
let grabShot = 0;   // K arms it here, gameRenderPost takes it (see saveShot)
// distance at the FIRST TOUCHDOWN, latched once per shot; -1 = not down yet
// (a putt never flies, so it records ~0)
let carryDist = -1;

// One record per shot, tree strike, hole and round start. TELEMETRY()
// prints and returns it, TELEMETRY(1) downloads it as JSON. EVERY call
// site is `debug && tlog(...)`. Written straight through to localStorage so
// it survives a reload: only a NEW ROUND ('round', logged by startCourse)
// clears it, so a CONTINUE keeps the holes already played.
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

// K: save a PNG of glCanvas alone (the HUD is a separate overlayCanvas). The
// grab must happen INSIDE the frame that drew it: glCanvas has no
// preserveDrawingBuffer, so once the browser composites a read from an update,
// a setTimeout or a promise comes back blank - hence toDataURL, not toBlob.
function saveShot()
{
    grabShot = 0;
    const a = document.createElement('a');
    a.href = glCanvas.toDataURL();
    a.download = `golf-h${holeIndex+1}-${Date.now()%1e7}.png`;
    a.click();
}

// X: full power, dead centre, so a club or a spin can be read with no meter
// noise. A PUTT gets the exact distance to the cup on the current line.
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
        // shotPower(1) is the top of the bar: the carry is exactly shotTarget
        launchBall(clubI, shotPower(1), 0, spinMode, aimYaw, lieMul());
        niceShot = 1;
        showMsg('PERFECT!');
    }
    startFlight();
}

// P: drop the ball on the green and putt. Holing out re-drops it instead of
// ending the hole.
function puttDrop()
{
    // near the green's edge, opposite the pin, so every drop has some break
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
// saved pose, so a reload does not return to it. Only writes when it was on.
const exitFreeCam = ()=> { if (freeCam) { freeCam = 0; delete localStorage['sg_cam']; } }

// where the bot's last swing was taken from: its stuck detector
let botLastX = 9e9, botLastZ = 9e9;

function botSwing()
{
    const d = ballToPin(), lie = lieMul();
    ++strokes;
    // STUCK ESCAPE: under 15yd gained means pinned against a hill face or a
    // trunk the club's arc cannot clear, so club up to the SW (highest loft)
    // and pop over. 15yd is under any real swing (the weakest full club from
    // sand carries ~20), so it only fires on a wall.
    if (clubI != CLUB_PUTTER && Math.hypot(ball.x-botLastX, ball.z-botLastZ) < 15)
        clubI = CLUB_PUTTER-1;
    botLastX = ball.x; botLastZ = ball.z;
    // the bot bypasses the meter, so it logs its own shot record (power -1)
    tlog(`shot`, {club: CLUBS[clubI][0], lie: SURF_NAMES[ballGround().s],
        toPin: d|0, target: shotTarget|0, power: -1, impact: 0, spin: 0,
        wind: +hole.wind.s.toFixed(1), windDir: +(hole.wind.a - aimYaw).toFixed(2), bot: 1});
    if (clubI == CLUB_PUTTER)
    {
        aimAtPin();
        // PUTT_OVER is the game's own default putt target; less dies short
        // ...plus the CLIMB to the hole. PUTT_OVER alone is tuned flat, so
        // an uphill putt died short: MEASURED, travelled/needed was 0.96 on
        // an 8% rise where a flat putt runs 1.24 past. 3.5yd of putt per yard
        // of climb flattens it to 1.18-1.24 across -6%..+8%, and it helps
        // downhill too (1.59 -> 1.31) because the term goes negative.
        launchPutt(d*PUTT_OVER + (heightAt(hole.pin.x, hole.pin.z) - ball.y)*3.5,
            aimYaw + rand(.012,-.012));
        // the tap the meter plays for a person, at the bot's own power
        snd_putt.play(.4 + Math.min(1, d*PUTT_OVER/PUTT_MAX)*.6);
    }
    else
    {
        // long shots target the fairway landing zone, wind compensated
        // over the time of flight (2*vy/g)
        const carry = CLUBS[clubI][1]*lie;
        distToPath(ball.x, ball.z);
        const atPin = d <= carry+20;
        let tgt = atPin ? hole.pin : pathPointAt(Math.min(lastAlong + carry*.95, hole.len));
        // a lay-up never aims INTO a lake: walk the target back along the
        // path until it is on land (an island par 5's lake sits exactly where
        // a full second shot lands). surfaceAt overwrites lastAlong, so the
        // start point is captured first.
        for (let a = lastAlong + carry*.95; !atPin && surfaceAt(tgt.x, tgt.z) == SURF_WATER; a -= 10)
            tgt = pathPointAt(a);
        // the bot's own drift estimate has to carry the airspeed term too,
        // or it corrects for a wind 50x the one the ball will actually feel
        const lv = launchVel({}, clubI, 0, lie);
        const tf = 2*lv.vy/GRAV;
        const drift = hole.wind.s*DRAG_K*WIND_V*Math.hypot(lv.vx, lv.vz)*tf*tf/2;
        const tx = tgt.x - Math.sin(hole.wind.a)*drift, tz = tgt.z - Math.cos(hole.wind.a)*drift;
        aimYaw = Math.atan2(tx-ball.x, tz-ball.z);
        let td = Math.hypot(tgt.x-ball.x, tgt.z-ball.z);
        // HEAD/TAIL WIND FROM THE SAME DRIFT: a headwind costs about what a
        // crosswind of the same speed pushes sideways, so no second model is
        // needed. The flat 1% this replaces left the bot 7-15% short into a
        // strong wind, which is why it could not carry the island. Tailwind
        // is weighted .65: the gain downwind is smaller than the loss into
        // it, because a slowed ball hangs longer. MEASURED carry/asked over
        // the bag at wind 5 and 8 both ways - rms 6.7% worst 15% before,
        // rms 2.4% worst 7% after.
        const along = Math.cos(hole.wind.a - aimYaw);
        td -= along*drift*(along < 0 ? 1 : .65);
        // land it SHORT of a flag: power sets the CARRY, and a carry aimed at
        // the pin releases 8-13yd past it. A layup wants its full number.
        // ...unless the ground that far short of the flag is WATER: an
        // island approach aims at the flag itself (mirrors sim.mjs)
        if (atPin && surfaceAt(tgt.x - Math.sin(aimYaw)*td*.1, tgt.z - Math.cos(aimYaw)*td*.1) != SURF_WATER)
            td *= .92;
        const pw = clamp(td/carry, .12, 1);
        // SWING ERROR stays at +-.04 of meter impact. It costs at most 1.4%
        // of power, but it also sets ballCurve at err*22, which on a driver
        // is about 12yd of hook or slice - already visible, and the most the
        // shot can stand. MEASURED at +-.08 the curve doubles to ~25yd, a
        // full slice, and a round went +0 to +18 with water balls 3 -> 9.
        // The short shots that look like a shank are not swing error at all:
        // they are the ball flying into a hill or a tree.
        launchBall(clubI, pw, rand(.04,-.04), 0, aimYaw + rand(.015,-.015), lie);
        // the strike the meter plays for a person, same volume/pitch curve
        snd_tee.play(.5 + pw*.5, .8 + pw*.4);
    }
    startFlight();
}

///////////////////////////////////////////////////////////////////////////////
// C: the collision volumes flyStep tests - canopy sphere (red), trunk cylinder
// (yellow) and the pin post (cyan), translucent, drawn through the geometry.

function pushCollGL()
{
    for (const t of hole.near)
    {
        // t.y IS the canopy centre (course.js bakes trunkH into it): the
        // sphere sits AT t.y and the trunk column runs from the ground up to it
        const s = t.s, r = s*TRUNK_R, th = trunkH(t);
        pushLathe(vec3(t.x, t.y, t.z), [[0,-s],[s*.7,-s*.7],[s,0],[s*.7,s*.7],[0,s]], 8, new Color(1,0,0,.35));
        // flyStep's trunk test is `dy < 0` - unbounded downward - so the
        // column is drawn over the part that can actually be reached
        pushLathe(vec3(t.x, t.y - th, t.z), [[r,0],[r,th]], 8, new Color(1,1,0,.4));
    }
    // the pin post's strike volume ballUpdate tests: POST_R wide, cup to POLE_H
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
    // THE PAD'S MENU HIGHLIGHT, drawn BEFORE the title menu: `panel` fills
    // #000a, so a bright rounded rect UNDER it is a solid outline where it
    // overhangs and a tint where the panel covers it. No hook in hud.js.
    if (padOn() && state == ST_TITLE && !DEV_THUMBNAIL)
    {
        const r = menuRect(padMenu), p = r.h*.08, c = overlayContext;
        c.fillStyle = GOLD;
        c.beginPath();
        // QUOTE roundRect and keep the rect fallback - see panel in hud.js
        (c['roundRect'] || c.rect).call(c, r.x-p, r.y-p, r.w+p*2, r.h+p*2, r.h*.38);
        c.fill();
    }
    // top centre, between the corner readouts hud.js owns. Deliberately does
    // NOT return 1: the point is to watch the bot through the normal HUD.
    if (autoPlay)
        txt('AI TEST MODE', midX, T*.2, T*.03);
}

///////////////////////////////////////////////////////////////////////////////
// debug keys and the free cam. Returns 1 when the frame is swallowed.

function devUpdate()
{
    if (!soundEnable && mouseWasPressed(0))
        setSoundEnable(1); // the first click turns the sound on
    // THE MAP AND THE FREE CAM ARE EXCLUSIVE: M exits the free cam and F
    // exits the map, so leaving either lands in the game.
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
    // B on the pad = the landing preview, exactly what a click on the view
    // does. The mouse path in updateAim is the reference, tick sound included.
    if (padOn() && gamepadWasPressed(1) && state == ST_AIM)
    {
        placeView = !placeView, camEase = SETTLE_T;
        snd_tick.play();
    }
    // T: AI TEST MODE - the bot plays through the normal game so a round can
    // be WATCHED (same machinery as `?auto=1`: updateAim hands over to
    // botSwing). NOT while the free cam is up, where T is the pitch control.
    if (cheatsOn && keyWasPressed('KeyT') && !freeCam)
    {
        autoPlay = !autoPlay;
        // at the title, deal a round to watch. Safe over a real game: saveGame
        // is a no-op while autoPlay is on, so the save is untouched.
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
        // R: REMIX re-rolls this hole under a new seed; CLASSIC replays it
        // exactly, strokes zeroed and the WIND kept (genHole draws a fresh
        // one per play), so the same shot can be hit twice and compared.
        // Straight to the tee, no flyback - the skip continueGame uses.
        // enterAim DOES write a save, so the real one is put back afterwards.
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
    // ENHANCED MODE, the rest of the pad. Driven from HERE, not game.js:
    // hooking pad input in as `+ (debug && pad...())` terms costs release
    // bytes (Closure folds each to `+ 0` and keeps the addition, since `x + 0`
    // is not `x` for a string), while calling the game's own functions from
    // here is free. Only clickPressed, which the meter reads, is hooked.
    // devUpdate runs before updateAim, so this frame's updatePredict sees it.
    // THE TITLE MENU on a pad: A picks through menuPick, the mouse's own
    // function, so the remix lock and the abandon confirm cannot drift.
    if (padOn() && state == ST_TITLE)
    {
        // LEFT/RIGHT (the buttons sit side by side), wrapping. The stick
        // counts too, latched so a held stick steps once.
        const sx = gamepadStick(0).x, push = Math.abs(sx) > .5;
        const dm = gamepadWasPressed(15) - gamepadWasPressed(14)
            || (push && !padHeld ? Math.sign(sx) : 0);
        padHeld = push;
        if (dm)
        {
            padMenu = mod(padMenu + dm, 3);
            snd_tick.play();
        }
        // SWALLOW THE FRAME after a pick: devUpdate runs BEFORE gameUpdate
        // dispatches on `state`, so the new state's update would run in this
        // same frame, see the same A "was pressed" and skip the flyback.
        if (gamepadWasPressed(0))
        {
            menuPick(padMenu + 1);
            return 1;
        }
    }
    if (padOn() && state == ST_AIM)
    {
        // stick up/down = analog distance; no sound, a tick a frame is a buzz
        const sy = gamepadStick(0).y;
        if (sy)
            setTarget(shotTarget + sy*.5);
        // X = spin, which the release only offers on the chip
        if (gamepadWasPressed(2))
            clubI == CLUB_PUTTER || cycleSpin(); // still no spin on a putt
        // ANALOG TURN, no turnHold ramp: a stick already gives magnitude
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
    // shift = fast, click = mouse look, F to exit. SPACE drops the ball here.
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
    // B THROWS the ball along the view direction, stepped here so the camera
    // stays put: aim at the pin, a tree or a slope to test a collision directly
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
        // same every-other-frame trail cadence as a real shot
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
    // remember hole + pose for a reload, twice a second (localStorage blocks)
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
    // pick the telemetry log back up (see tlog). Here, not at the declaration,
    // so it stays behind `debug`: Closure cannot fold a file-scope side effect
    try { telem = JSON.parse(localStorage['sg_telem']) || []; } catch {}
    // silence until the window is clicked (a live reload otherwise fires a note)
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
         ball: 0 downrange, 90 right, 180 into your face. ~4yd of
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
    // FIREFOX EATS PRINTABLE KEYS. With "search for text when you start
    // typing" on, the first letter pressed opens the quick-find bar and every
    // key after it goes there instead of to the game - so F, T, R, P and the
    // free cam's WASD do nothing. Swallowing single-character keys stops it.
    // Named keys (F5, F12, Escape, the arrows) are longer than one character
    // and anything with a modifier is excluded, so reload, devtools and every
    // browser shortcut still work.
    addEventListener('keydown', (e)=>
        e.key.length == 1 && !e.ctrlKey && !e.altKey && !e.metaKey && e.preventDefault());

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
    // SKIP() carries on from the save, but anything that names a starting
    // point beats it: the free cam pose, then ?hole=, ?auto= and ?putt=.
    else if (localStorage['sg_skip'] && !jumpHole && !autoPlay && !puttTest)
    {
        savedGame ? continueGame() : startCourse(0);
        // straight to the shot: continueGame already lands in aim mid-hole;
        // this covers the start of a hole, where startHole leaves ST_INTRO
        state == ST_AIM || enterAim();
    }
    // TELEMETRY() prints and returns the log; TELEMETRY(1) also saves a file
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
    // SKIP(): toggle jumping straight into the game on reload. Held in
    // localStorage so it outlives edits and rebuilds; SKIP(1)/SKIP(0) set it.
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
    // WIND(speed, degrees): degrees is the way the wind PUSHES THE BALL -
    // 0 downrange, 90 right, 180 into your face. Omit either to keep it.
    window['WIND'] = (s, deg)=>
    {
        if (s != null) hole.wind.s = s;
        if (deg != null) hole.wind.a = deg*Math.PI/180;
        state == ST_AIM ? enterAim() : updatePredict();
        return {speed: +hole.wind.s.toFixed(2), degrees: +(hole.wind.a*180/Math.PI).toFixed(1)};
    }
    // RANGE(): replace this hole with a flat practice range (no hills, trees,
    // hazards or wind) so a club's carry reads clean - terrain alone swings it
    // -27%..+14%. Overwrites this hole's row (R replays it, [ ] walks off);
    // the save is put back the way R does.
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
