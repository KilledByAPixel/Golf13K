/*
    SUNSHINE GOLF CLASSIC - Wavedash hooks

    The Wavedash platform injects window.Wavedash into the page before the
    game runs; nothing is bundled. WAVEDASH = 1 compiles these hooks in (the
    --wavedash build); the js13k build rewrites it to 0 and Closure folds
    every hook and call site out, so the zip does not change.

    wd() reads the global AT CALL TIME, not at load: a dev mock installed
    later still counts, and every hook is a no-op wherever the global is
    absent (dev build, GitHub Pages, a stray release).

    Only game.js calls these. course.js and golfSim.js run under node in
    the unit and sim harnesses, where there is no window.
*/

'use strict';

const WAVEDASH = 1;
const wd = ()=> WAVEDASH && window.Wavedash;

// Every entry point from game.js starts with `if (!wd()) return`: under
// WAVEDASH = 0 that makes the whole body dead before any argument is
// evaluated, so nothing survives - a call folded to nothing still keeps an
// argument that is itself a call (scores.reduce), which is 18 bytes of zip.

// init drops the platform's loading screen; nothing may precede it. Then
// the stats: the SDK keeps a local copy once requestStats resolves, and a
// write before that would clobber the totals with this session's alone.
let wdStats = 0; // 1 once the local copy is loaded
function wdInit()
{
    if (!wd()) return;
    wd().init();
    // the platform page can scroll, and the wheel sets the distance: keep
    // it on the game. Non-passive, next to the engine's own window.onwheel
    // (a passive handler by browser rule, whose preventDefault is ignored).
    addEventListener('wheel', e => e.preventDefault(), {passive: false});
    wd().requestStats().then(r => wdStats = r.success);
    wdLoad();
}

// CLOUD SAVE: the two BESTS as one JSON file per player, never the round in
// progress - that stays on the device, so a bad hole cannot be replayed by
// clearing local storage and pulling the round back down. Each best is
// merged as the LOWER of local and cloud (stored over par), so a device
// only ever gains; uploaded at the 18th card, where bests change.
const WD_KEYS = ['sg_best_c', 'sg_best_r'];
const WD_FILE = 'save.json';
function wdLoad()
{
    if (!wd()) return;
    // download lands in the SDK's local store and answers with its path;
    // success is false when the player has no file yet
    wd().downloadRemoteFile(WD_FILE)
        .then(r => r.success && wd().readLocalFile(r.data))
        .then(b =>
        {
            if (!b) return;
            const o = JSON.parse(new TextDecoder().decode(b));
            // a missing local best compares NaN, so the cloud one is taken;
            // the title menu reads the bests live, so REMIX lights up
            for (const k of WD_KEYS)
                if (o[k] != null && !(+localStorage[k] <= +o[k]))
                    localStorage[k] = o[k];
        })
        .catch(()=> 0);
}
function wdSave()
{
    if (!wd()) return;
    const o = {};
    for (const k of WD_KEYS)
        if (localStorage[k] != null) o[k] = localStorage[k];
    wd().writeLocalFile(WD_FILE, new TextEncoder().encode(JSON.stringify(o)))
        .then(ok => ok && wd().uploadRemoteFile(WD_FILE))
        .catch(()=> 0);
}

// running totals, integers; storeStats sends them (once per hole and at
// the 18th card, not per shot)
function wdStat(id, add)
{
    if (!wd() || !wdStats) return;
    wd().setStat(id, (wd().getStat(id) || 0) + add);
}
function wdFlush() { wd() && wdStats && wd().storeStats(); }

function wdAchieve(id) { wd() && wd().setAchievement(id, true); }

// sort 0 = lower wins, display 0 = plain number; keepBest keeps the low score
function wdScore(board, strokes)
{
    wd() && wd().getOrCreateLeaderboard(board, 0, 0).then(r =>
        r.success && wd().uploadLeaderboardScore(r.data.id, strokes, true));
}

// mirrors scoreName: 1 stroke is its own result, then -3/-2/-1 to par.
// SHOTS counts the card (penalty strokes included), HOLES the hole.
function wdHole(strokes, par)
{
    if (!wd()) return;
    const id = strokes == 1 ? 'HOLE_IN_ONE'
        : ['ALBATROSS', 'EAGLE', 'BIRDIE'][Math.max(0, strokes - par + 3)];
    id && wdAchieve(id);
    wdStat('SHOTS', strokes);
    wdStat('HOLES', 1);
    wdFlush();
}

// once per shot, when the ball has settled: pinHit is latched in shotBegin,
// DISTANCE is the ground distance from where it was played, in yards
function wdShot()
{
    if (!wd()) return;
    pinHit && wdAchieve('PIN_HIT');
    wdStat('DISTANCE', Math.hypot(ball.x - shotStart.x, ball.z - shotStart.z) | 0);
}

// the 18th card: board + DONE always, PAR at par or better (rel <= 0).
// Total strokes rather than rel: par is 73 in both modes so totals compare,
// and the board never has to show a negative number.
function wdRound(remix, rel)
{
    if (!wd()) return;
    const m = remix ? 'REMIX' : 'CLASSIC';
    wdScore(m.toLowerCase(), scores.reduce((a, b)=> a + b));
    wdAchieve(m + '_DONE');
    rel <= 0 && wdAchieve(m + '_PAR');
    wdStat('ROUNDS', 1);
    wdFlush();
    wdSave(); // after the best is written
}
