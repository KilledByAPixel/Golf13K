/*
    SUNSHINE GOLF CLASSIC - gamepad control

    GAMEPAD = 1 compiles the pad in: the dev build, and the Wavedash build,
    where build.mjs also turns the engine's gamepad input on. The js13k
    build rewrites it to 0 and Closure folds every read out. Every entry
    point opens with an early return on the flag, so no argument survives.

    Driven from padUpdate by calling the game's own functions, never by
    adding pad terms into game.js expressions: `x + (0 && pad())` keeps the
    addition. Only clickPressed and the meter start read padClick directly,
    because the meter reads clickPressed.

    Layout: left stick turns (analog, no turnHold ramp) and sets distance,
    D-pad = club, and the menu row at the title; A = every click of the
    swing and the menu pick, B = landing preview, X = spin, shoulders =
    distance, back = title.

    LOAD ORDER: before game.js; nothing here runs at load time.
*/

'use strict';

const GAMEPAD = 1;
let padEnabled = 1;   // the dev build's N key toggles it
const padOn = ()=> GAMEPAD && padEnabled && isUsingGamepad;
const padTurn = ()=> padOn() ? gamepadStick(0).x : 0;
// club and distance STEP, not slide: D-pad = club, shoulders = distance
const padClub = ()=> padOn() ? gamepadWasPressed(13) - gamepadWasPressed(12) : 0;
const padDist = ()=> padOn() ? gamepadWasPressed(4) - gamepadWasPressed(5) : 0;
// A is the click - every phase of the swing, exactly like Space
const padClick = ()=> padOn() && gamepadWasPressed(0);

// pad menu row, 0 CONTINUE / 1 CLASSIC / 2 REMIX; only drawn once a pad is used
let padMenu = 1; // CLASSIC: the row a new player wants
let padHeld = 0; // stick already pushed sideways, so a hold steps once

// gameInit
function padInit()
{
    if (!GAMEPAD) return;
    // the D-pad is read as BUTTONS (club, menu row); folded into stick 0 it
    // would also turn the aim on every club change
    setGamepadDirectionEmulateStick(0);
}

// gameUpdate, after the debug layer (the map freezes the game's input there
// too). Returns 1 when the frame is swallowed.
function padUpdate()
{
    if (!padOn()) return;
    // B = the landing preview, exactly what a click on the view does. The
    // mouse path in updateAim is the reference, tick sound included.
    if (gamepadWasPressed(1) && state == ST_AIM)
    {
        placeView = !placeView, camEase = SETTLE_T;
        snd_tick.play();
    }
    if (gamepadWasPressed(8))
        setState(ST_TITLE); // back
    // THE TITLE MENU: A picks through menuPick, the mouse's own function, so
    // the remix lock and the abandon confirm cannot drift.
    if (state == ST_TITLE)
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
        // SWALLOW THE FRAME after a pick: this runs BEFORE gameUpdate
        // dispatches on `state`, so the new state's update would run in this
        // same frame, see the same A "was pressed" and skip the flyback.
        if (gamepadWasPressed(0))
        {
            menuPick(padMenu + 1);
            return 1;
        }
    }
    if (state == ST_AIM)
    {
        // stick up/down = analog distance; no sound, a tick a frame is a buzz
        const sy = gamepadStick(0).y;
        if (sy)
            setTarget(shotTarget + sy*.25);
        // X = spin, which the mouse only offers on the chip
        if (gamepadWasPressed(2))
            clubI == CLUB_PUTTER || cycleSpin(); // still no spin on a putt
        // ANALOG TURN, no turnHold ramp: a stick already gives magnitude
        aimYaw += padTurn()*.002;
        const dc = padClub();
        if (dc)
        {
            clubI = mod(clubI + dc, CLUBS.length);
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
}

// gameRenderPost, BEFORE the title menu draws: the button is filled #000a,
// so a bright rounded rect UNDER it is a solid outline where it overhangs
// and a tint where the button covers it.
function padHud()
{
    if (!padOn() || state != ST_TITLE || DEV_THUMBNAIL) return;
    const r = menuRect(padMenu), p = r.h*.08, c = overlayContext;
    c.fillStyle = GOLD;
    c.beginPath();
    // quoted: Closure's externs predate roundRect and would rename it
    c['roundRect'](r.x-p, r.y-p, r.w+p*2, r.h+p*2, r.h*.38);
    c.fill();
}
