'use strict';

/*  SUNSHINE GOLF CLASSIC - the HUD layer

    Everything drawn on overlayCanvas in 2D. gameRenderPost composes the
    frame; renderMeter / renderScorecard / renderConfetti / drawWind are its
    pieces; panel / fillRect / txt / tri / rainbowText are the primitives
    they all go through. Nothing here touches GL - the 3D scene is
    glRender.js and view3d.js.

    LOAD ORDER: LAST, after game.js. It owns the engineInit call at the
    bottom, and that call names gameRenderPost, so this file has to have
    defined it first. Loading last is also worth 9 bytes over loading first,
    purely from where it lands in the concatenated source. */

const GOLD = '#fd4';

function gameRenderPost()
{
    // FIRST, before a pixel of HUD: gameRender has just drawn the 3D and the
    // drawing buffer is still alive this frame. See saveShot in game.js.
    debug && grabShot && saveShot();

    const W = mainCanvasSize.x, T = mainCanvasSize.y;
    // crisp HUD on high-DPI screens: the overlay canvas gets device pixels
    // (the engine re-sizes it in CSS pixels every frame) and the context is
    // scaled back, so all the T-relative layout below stays in CSS pixels
    const dpr = devicePixelRatio;
    overlayCanvas.width = W*dpr;
    overlayCanvas.height = T*dpr;
    overlayCanvas.style.width = W + 'px';
    overlayCanvas.style.height = T + 'px';
    overlayContext.scale(dpr, dpr);
    // round joins AND caps for every stroke (text outlines look bad without
    // both) - set per frame because the re-size above resets the context
    overlayContext.lineJoin = overlayContext.lineCap = 'round';
    overlayContext.textBaseline = 'middle';
    const midX = W/2;

    // debugGame.js: the mode banners. Returns 1 when the map or the free
    // cam owns the frame and no game HUD should draw over it.
    if (debug && devHud(midX, T))
        return;

    if (state == ST_TITLE || DEV_THUMBNAIL)
    {
        if (DEV_THUMBNAIL)
        {
            rainbowText('SUNSHINE', midX, T*.13, T*.2);
            rainbowText('GOLF CLASSIC', midX, T*.3, T*.15, 1);
        }
        else
        {
            rainbowText('SUNSHINE', midX, T*.18, T*(.14+Math.sin(time)/99));
            rainbowText('GOLF CLASSIC', midX, T*.3, T*(.1-Math.sin(time)/99), 1);
        }
        if (!DEV_THUMBNAIL)
        for (let i=3; i--;)
        {
            const r = menuRect(i), cx = r.x + r.w/2;
            const best = i && localStorage['sg_best_' + (i > 1 ? 'r' : 'c')];
            // REMIX greys out until classic is beaten at par or better.
            // CONTINUE lights up for a save OR a finished round, since it
            // re-opens the final scorecard - the only way back to it.
            const col = (i ? i > 1 ? localStorage['sg_best_c'] <= 0 : 1 : savedGame || roundOver()) ? WHITE : '#444';
            // .24 is set by CONTINUE, the longest label, so all three match
            const fs = Math.min(r.h/2, r.w*.24);
            panel(r.x, r.y, r.w, r.h, r.h*.3);
            txt(MENU[i], cx, r.y + r.h*.36, fs, 'center', col);
            if (best) txt(relPar(+best), cx, r.y + r.h*.8, fs*.8, 'center', col);
        }
        return;
    };

    if (state == ST_HOLEOUT && stateTime > CARD_T)
        return renderScorecard(); // (it draws the confetti behind itself)

    if (state == ST_INTRO)
    {
        rainbowText(`HOLE ${holeIndex+1}`, midX, T*.1, T*.07);
        txt(`PAR ${hole.par} - ${hole.len|0} YARDS`, midX, T*.18, T*.04);
    }
    else
    {
        // in-round HUD
        const pad = T*.05; // breathing room off the screen top
        txt(`HOLE ${holeIndex+1}  PAR ${hole.par}`, 18, pad, T*.04, 'left');
        // the shot IN PLAY: strokes increments at impact, so aim and the
        // meter are one ahead of it and the flight is not
        txt(`${ballToPin()|0}yd TO PIN`, 18, pad+T*.05, T*.03, 'left');
        txt(`SHOT ${strokes + (state < ST_FLIGHT)}`, 18, pad+T*.095, T*.03, 'left');
        txt(`SCORE ${relPar(scoreTotal() - parTotal(holeIndex))}`, W-18, pad, T*.04, 'right');
        // 2.86 IS THE REAL CONVERSION, not a chosen feel number: a wind unit
        // is WIND_V = 1.4 yd/s of air, and a yard per second is 2.0455mph, so
        // 1.4 x 2.0455 = 2.8636. The 3 it shipped with read 4.8% high - the
        // top of the range showed 30mph where the air is doing 28.6.
        // 2.86 and the exact 2.864 print the SAME integer at every wind after
        // the |0, so the extra digit buys nothing and costs a byte.
        txt(`WIND ${hole.wind.s*2.86|0}mph`, W-18, pad+T*.05, T*.03, 'right');
        drawWind(W-18-T*.04, pad+T*.12, T*.03);
    }

    if (state == ST_AIM || state == ST_SWING)
    {
        // floating pin marker, hidden inside 30yd where the flag reads on
        // its own. Behind the camera (z <= 0) it parks on the nearer side.
        const dPin = ballToPin();
        if (dPin > 30)
        {
            const pp = project(hole.pin.x, heightAt(hole.pin.x, hole.pin.z) + 4, hole.pin.z);
            const front = pp.z > .3;
            const mx = front ? clamp(pp.x, W*.05, W*.95) : pp.x < midX ? W*.95 : W*.05;
            const my = front ? clamp(pp.y, T*.3, T*.7) : T*.3;
            // glyph hovers a little above the flag top so the (distance-
            // scaled) real flag stays visible right under it
            const s = T*.05, bob = Math.sin(time*3)*T*.006;
            txt('⚑', mx, my - s*.85 + bob, s, 'center', '#f35');
            txt(`${dPin|0}`, mx, my - s*1.7 + bob, T*.03);
        }

        // lie label (no control instructions: the chips explain themselves)
        txt(SURF_NAMES[ballGround().s], midX, T*.96, T*.06);

        if (state == ST_AIM)
        {
            // the clickable turn arrows, at the screen sides.
            // KNOB: T*.045 is their size; tri fixes the outline weight.
            const pulse = .8 + Math.sin(time*4)*.2, ax = arrowX();
            tri(ax, T*.5, T*.045, -PI/2, rgb(1,1,1,pulse));
            tri(W-ax, T*.5, T*.045, PI/2, rgb(1,1,1,pulse));
        }
        renderMeter();
    }

    if (state == ST_HOLEOUT)
        renderConfetti();

    if (msgTimer > 0)
    {
        const fade = Math.min(1, msgTimer/25);
        const c = new Color(1,1,1,fade);
        txt(msgText, midX, T*.3, T*.1, 'center', c, T*.01, new Color(0,0,0,fade));
    }
}

///////////////////////////////////////////////////////////////////////////////
// HUD pieces

// THE ONE ARROW: a triangle pointing UP in a y-up unit square - tip at
// (0,1), base 2w wide at -1 - turned by a and scaled to s. Every arrow in
// the HUD is this shape: the wind vane, the two turn arrows, the club
// chevrons. DRAWN rather than typed on purpose - U+25C0 and U+25B6 carry
// emoji presentation variants, and phone fonts render them as colour blobs.
//
// w is the only knob: the HALF-WIDTH, so the triangle is 2 long and 2w
// across. 1 is the chunky UI arrow and the default, since four of the five
// calls want it; .4 is the wind vane, which stays a pointy dart because it
// shows a direction rather than offering a button. (Exactly equilateral is
// 1.155 - wider than it is long, and it starts to read as a diamond.)
//
// THE OUTLINE IS FIXED at .4 so it matches the text beside it, and it needs
// no knob because it is in LOCAL units, inside the scale(s,-s): one constant
// therefore lands the same weight at every size. txt outlines at size*.15,
// the chevrons draw at s = fs*.36, and .15/.36 = .42. Passing a SCREEN-space
// width here is the trap - it arrives divided by s.
function tri(x, y, s, a, fill, w = 1, lw=.2)
{
    const c = overlayContext;
    c.save();
    c.translate(x, y);
    c.rotate(a);
    c.scale(s, -s);
    c.fillStyle = fill;
    c.beginPath();
    c.lineTo(0, 1);
    c.lineTo(w, -1);
    c.lineTo(-w, -1);
    c.closePath();
    c.lineWidth = lw;
    c.strokeStyle = BLACK;
    c.stroke();
    c.fill();
    c.restore();
}

// the wind vane: the one arrow that points somewhere real, turned into the
// camera's frame so it reads against the hole rather than the compass - and
// the one that keeps the narrow dart shape
const drawWind = (x, y, s)=> tri(x, y, s, hole.wind.a - camYaw,
    hsl(.3 - hole.wind.s/25, 1, Math.max(.5, 1-hole.wind.s/20)), .4);

function renderMeter()
{
    const ctx = overlayContext;
    const W = mainCanvasSize.x, T = mainCanvasSize.y;
    const {bx, by, bw, bh} = meterRect();
    // meter t (-METER_OVER..1) -> x: the overshoot zone sits left of t=0
    const xs = bw/(1 + METER_OVER), x0 = bx + METER_OVER*xs;
    const t2x = (t)=> x0 + t*xs;
    const isPutt = clubI == CLUB_PUTTER;
    const armed = state == ST_AIM; // visible before the swing starts

    // backing panel
    panel(bx-bh*.3, by-bh*.3, bw+bh*.6, bh*1.6, bh*.5);

    // power track: green -> yellow -> red toward the full-power target
    // (raw context: engine has no gradient fills)
    const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    // the gradient spans the whole bar, so a stop fraction is NOT a meter t:
    // the impact line sits at METER_OVER/(1+METER_OVER) = .115.
    // The accuracy zone is drawn for EVERY club now - a putt has a second
    // click like everything else, so it has a sweet spot to show.
    grad.addColorStop(0, '#f21');
    grad.addColorStop(.06, '#f4f');
    grad.addColorStop(.11, WHITE);
    grad.addColorStop(.12, WHITE);
    grad.addColorStop(.16, '#fd2');
    grad.addColorStop(.3, '#f21');
    grad.addColorStop(.5, '#f4f');
    grad.addColorStop(.7, '#2af');
    grad.addColorStop(.9, '#2f5');
    grad.addColorStop(1, WHITE);
    ctx.fillStyle = grad;
    ctx.fillRect(bx, by, bw, bh);

    // WHAT THE BAR'S FULL POWER ACTUALLY DELIVERS, every club alike: the
    // distance to where the simulation says the ball comes to a stop. So the
    // number moves with the spin, the club and the ground, not only with the
    // wheel. shotTarget is still what the meter is SCALED to - it is the
    // power - but what it DELIVERS is what gets printed, and predLand is
    // where the ring sits, so the number and the mark are the same claim.
    // This replaced a friction-ratio ESTIMATE for putts (shotTarget*3/P[2]),
    // which could only guess at the lie and knew nothing of the slope. The
    // prediction rolls the real ground instead, so it needs no estimate.

    // the top of the meter = the target distance.
    // needs to show WHERE the top is.
    //fillRect(t2x(1)-3, by-bh/2, 6, bh*2, WHITE);

    // WHERE THE CUP FALLS on the bar
    if (ballToPin() < predDist)
    {
        fillRect(t2x(ballToPin()/predDist)-3, by-bh*.5, 6, bh*2, '#6df');
        // draw the flag
        //txt('⚑', t2x(ballToPin()/predDist), by-bh*.8, bh*.8, 'center', '#f35');
    }
    // the sweet spot, now on EVERY club: launchBall snaps err to zero inside
    // |impact| < .02. The .06 that prints GOOD is not drawn - nothing happens there.
    fillRect(t2x(-.02), by-bh*.3, .04*xs, bh*1.6, '#fffa');

    // phase caption
    const cap = 'CLICK TO SWING!';
    // (above the bar, clear of the cursor's pointer triangle)
    const pulse = .04 + Math.sin(time*5)*.003;
    armed && txt(cap, W/2, by+bh/2, T*pulse);

    // power mark once chosen
    if (meterPhase == 2)
        fillRect(t2x(meterPower)-3, by-bh/2, 6, bh*2, GOLD);

    // cursor: tall marker with a pointer triangle (rests at the line pre-swing)
    const cx = t2x(armed ? 0 : meterPos());
    fillRect(cx-3, by-bh*.5, 6, bh*2, WHITE);
    ctx.beginPath();
    ctx.lineTo(cx, by-bh*.5);
    ctx.lineTo(cx-bh*.4, by-bh);
    ctx.lineTo(cx+bh*.4, by-bh);
    ctx.fill();

    // the chips: club / spin / target distance (aim state only - they hide
    // while the meter runs so the timing task stays clean)
    if (armed)
    {
        const {y, h, w, xs} = meterBtns();
        // font capped by chip width too - phone-portrait chips are narrow
        const c = CLUBS[clubI], fs = Math.min(h*.7, w*.25), cy = y + h/2;
        for (const x of xs)
            panel(x, y, w, h, h*.3);
        // KNOB: fs*.36 sizes the chevrons against the chip's text - and it
        // is the ratio tri's fixed .4 outline was matched to, so moving it
        // far changes how heavy their outline reads next to the word
        tri(xs[0]+w*.1, cy, fs/3, -PI/2, WHITE, 1, .4);
        tri(xs[0]+w*.9, cy, fs/3, PI/2, WHITE, 1, .4);
        txt(c[0], xs[0]+w/2, cy, fs);
        txt(isPutt ? '-' : SPIN_NAMES[spinMode+1], xs[1]+w/2, cy, fs, 'center', !isPutt && spinMode ? GOLD : WHITE);
        // the - and + show on a PUTT now: the distance chip drives the putt
        // bar exactly as it drives every other club's, so hiding its controls
        // was the last thing still saying putting worked differently
        txt('-', xs[2]+w*.1, cy, fs);
        txt('+', xs[2]+w*.9, cy, fs);
        // the ONE place the yardage is printed now
        txt(`${predDist|0}yd`, xs[2]+w/2, cy, fs);
    }
}

// Rounded backing panel for the meter, chips and scorecard.
// QUOTE roundRect: Closure's externs predate it and would rename it, which
// is a release-only crash.
// The rect FALLBACK is insurance for browsers older than roundRect (it is
// the NEWEST api this game uses - Safari 16 / Firefox 112, both later than
// the WebGL2 the renderer needs). Worth its bytes because the failure is
// not cosmetic: panel() runs inside gameRenderPost, which sits BEFORE
// requestAnimationFrame with no catch, so a missing method freezes the
// game on the title's first frame. rect ignores the extra radius, so an
// old browser gets square corners and plays on.
const panel = (x, y, w, h, r)=>
{
    const c = overlayContext;
    c.fillStyle = '#000a';
    c.beginPath();
    (c['roundRect'] || c.rect).call(c, x, y, w, h, r);
    c.fill();
}

const fillRect = (x, y, w, h, col, a)=>
{
    const c = overlayContext;
    c.fillStyle = col;
    c.save();
    c.translate(x+w/2, y+h/2);
    c.rotate(a);
    c.fillRect(-w/2, -h/2, w, h);
    c.restore();
}

// HUD text straight on the overlay context - the engine's drawTextScreen
// does far more than this needs and costs 772 source bytes.
const txt = (t, x, y, size, align='center', color=WHITE, w=size*.15, wc=BLACK)=>
{
    const c = overlayContext;
    // maxWidth on BOTH passes or the outline draws at the unsqueezed width.
    // Only the showMsg banner ever comes near it.
    const m = mainCanvasSize.x*.95;
    c.fillStyle = color;
    c.textAlign = align;
    c.font = size + 'px impact';
    if (w)
    {
        c.strokeStyle = wc;
        c.lineWidth = w;
        c.strokeText(t, x, y, m);
    }
    c.fillText(t, x, y, m);
}

// big rainbow-gradient display text with outline
function rainbowText(t, x, y, size, style=0)
{
    const W = mainCanvasSize.x;
    const ctx = overlayContext;
    const g = ctx.createLinearGradient(x-size*3, 0, x+size*3, 0);
    for(let i=9; i--;)
        g.addColorStop(i/9, hsl(style/2+i/10+time/5, 1, .7+Math.sin(i-time*2)*.2));
    ctx.font = size + 'px impact';
    ctx.lineWidth = size/9;
    ctx.textAlign = 'center';
    ctx.strokeStyle = BLACK;
    ctx.fillStyle = g;
    ctx.strokeText(t, x, y, W*.95);
    ctx.fillText(t, x, y, W*.95);
}

// THE scorecard, in its two moods, told apart by roundOver() alone.
// JUST HOLED OUT (the round still running, or hole 18 a moment ago): the
// hole named, its score called, that hole lit gold in the grid, running
// total. This is the celebration.
// REVIEWING (p238's CONTINUE, holeIndex past the end): plain SCORECARD,
// no score called, nothing lit, TOTAL - and hud.js holds the confetti back
// too. Frank: "it is not really... it is just viewing the scorecard."
// p237 deleted a "final" PARAMETER that drew exactly this second mood, and
// it is back because the review needs it - but keyed off roundOver(), which
// already existed, so it costs a test rather than an argument. The grid
// highlight needs no test at all: holeIndex is past 17 while reviewing, so
// the h == holeIndex it already does simply never matches.
function renderScorecard()
{
    const W = mainCanvasSize.x, T = mainCanvasSize.y, over = roundOver();
    // confetti FIRST so the panel sits over it, and never while reviewing -
    // the celebration belongs to the moment, not to looking the card up
    over || renderConfetti();
    // dim panel so the card reads over any scenery
    panel(W*.03, T*.05, W*.94, T*.9, T*.04);
    // two lines: the hole, then what you got on it. One line could not fit
    // "HOLE 3 — 🦄 HOLE IN ONE!" across a phone in portrait, and the long
    // names are exactly the ones you most want to read.
    txt(over ? 'SCORECARD' : `HOLE ${holeIndex+1}`, W/2, T*.1, T*.06);
    over || txt(scoreName(strokes, hole.par), W/2, T*.18, T*.05);
    const cw = W*.095; // W*.85/9
    const x0 = W*.08 + cw/2;
    for (let half=0; half<2; ++half)
    {
        // .34 centres the two rows in the panel
        const y = T*(.34 + half*.25);
        for (let i=9; i--;)
        {
            const h = half*9 + i, x = x0+i*cw;
            const s = scores[h], p = courseRows[h][0];
            txt(h+1, x, y, T*.03, 'center', h == holeIndex ? GOLD : WHITE);
            txt('PAR '+p, x, y+T*.035, T*.017, 'center', '#ccc');
            txt(s ?? '-', x, y+T*.1, T*.04, 'center', s < p ? GOLD : WHITE);
        }
    }
    const n = over ? 18 : holeIndex+1;
    // no click prompt: any click continues, and on 18 it ends the round
    txt(`${over ? 'TOTAL' : 'THRU '+n}   ${relPar(scoreTotal() - parTotal(n))}`, W/2, T*.9, T*.05);
    if (debug && remixMode)
        txt(`REMIX SEED ${courseSeed}`, W/2, T*.8, T*.03);
}

function renderConfetti()
{
    const R = new RandomGenerator();
    const W = mainCanvasSize.x, T = mainCanvasSize.y;
    if (strokes <= hole.par) // only if par or under
    for (let i=70; i--;)
    {
        const rx = R.float(W), rs = R.float(3,5);
        const y = ((stateTime*rs + i**3)%(T+40)) - 20;
        fillRect(rx + Math.sin(stateTime*.05+i)*20, y, 6, 9,
            hsl(R.float(), 1, .6), stateTime*.03*R.sign() + i);
    }
}

///////////////////////////////////////////////////////////////////////////////
engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost);
