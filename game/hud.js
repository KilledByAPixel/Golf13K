'use strict';

/*  RAINBOW GOLF TOUR - the HUD layer
 *
 *  Everything drawn on overlayCanvas in 2D: gameRenderPost composes the
 *  frame, renderMeter / renderScorecard / renderConfetti / drawWind are its
 *  pieces, and panel / fillRect / txt / rainbowText are the
 *  primitives they all go through. The 3D scene is glRender.js + view3d.js;
 *  nothing here touches GL.
 *
 *  LOAD ORDER: LAST, after game.js, and it owns the engineInit call at the
 *  bottom - that call names gameRenderPost, so it must run once this file has
 *  defined it. Loading last also keeps the concatenated release byte-order
 *  identical to the single file this was split out of; putting it first cost
 *  9 bytes for nothing but the reshuffle.
 */

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

    if (debug)
    {
        if (mapView)
        {
            txt(`MAP - HOLE ${holeIndex+1} · PAR ${H.par} · ${H.len|0}yd · [ ] = PREV/NEXT HOLE · M = EXIT`,
                midX, T-T*.04, T*.024);
            return;
        }
        if (freeCam && !DEV_THUMBNAIL)
        {
            txt('FREE CAM - WASD move · Q/E height · CLICK = MOUSE LOOK · T/G pitch · SPACE drop ball · F exit',
                midX, T-T*.04, T*.024);
            return;
        }
        if (puttMode)
            txt('PUTT MODE - HOLING OUT RE-DROPS · P EXITS', midX, T-T*.04, T*.024);
    }
    
    if (state == ST_TITLE || DEV_THUMBNAIL)
    {
        if (DEV_THUMBNAIL)
        {
            rainbowText('SUNSHINE', midX, T*.23, T*.2);
            rainbowText('GOLF CLASSIC', midX, T*.4, T*.15, 1);
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
            const best = i && localStorage['rg_best_' + (i > 1 ? 'r' : 'c')];
            // rg_best_c exists only once a classic round has been finished
            const col = (i ? i > 1 ? localStorage['rg_best_c'] : 1 : savedGame) ? WHITE : '#444';
            // .24 is set by CONTINUE, the longest label, so all three match
            const fs = Math.min(r.h/2, r.w*.24);
            panel(r.x, r.y, r.w, r.h, r.h*.3);
            txt(MENU[i], cx, r.y + r.h*.36, fs, 'center', col);
            if (best) txt(relPar(+best), cx, r.y + r.h*.8, fs*.8, 'center', col);
        }
        return;
    };

    if (state == ST_RESULTS || state == ST_HOLEOUT && stateTime > CARD_T)
    {
        state == ST_HOLEOUT && renderConfetti();
        renderScorecard(state == ST_RESULTS);
        return;
    }

    if (state == ST_INTRO)
    {
        rainbowText(`HOLE ${holeIndex+1}`, midX, T*.1, T*.07);
        txt(`PAR ${H.par} - ${H.len|0} YARDS`, midX, T*.18, T*.04);
    }
    else
    {
        // in-round HUD
        const pad = T*.05; // breathing room off the screen top
        txt(`HOLE ${holeIndex+1}  PAR ${H.par}`, 18, pad, T*.04, 'left');
        // the shot IN PLAY: strokes increments at impact, so aim and the
        // meter are one ahead of it and the flight is not
        txt(`${ballToPin()|0}yd TO PIN`, 18, pad+T*.05, T*.03, 'left');
        txt(`SHOT ${strokes + (state < ST_FLIGHT)}`, 18, pad+T*.095, T*.03, 'left');
        txt(`SCORE ${relPar(scoreTotal() - parTotal(holeIndex))}`, W-18, pad, T*.04, 'right');
        txt(`WIND ${H.wind.s|0}`, W-18, pad+T*.05, T*.03, 'right');
        drawWind(W-18-T*.04, pad+T*.11, T*.03);
    }

    if (state == ST_AIM || state == ST_SWING)
    {
        // floating pin marker, hidden inside 30yd where the flag reads on
        // its own. Behind the camera (z <= 0) it parks on the nearer side.
        const dPin = ballToPin();
        if (dPin > 30)
        {
            const pp = project(H.pin.x, heightAt(H.pin.x, H.pin.z) + 4, H.pin.z);
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
        txt(SURF_NAMES[ballGround().s], midX, T*.96, T*.05);

        // aim arrowws
        if (state == ST_AIM)
        {
            // clickable turn arrows at the screen sides
            const pulse = .8 + Math.sin(time*4)*.2, ax = arrowX();
            txt('◀', ax, T*.5, T*.1, 'center', rgb(1,1,1,pulse),T*.015, rgb(0,0,0,pulse));
            txt('▶', W-ax, T*.5, T*.1, 'center', rgb(1,1,1,pulse),T*.015, rgb(0,0,0,pulse));
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

function drawWind(x, y, s)
{
    // arrow relative to the camera view, in a local y-up unit square
    const c = overlayContext;
    c.save();
    c.translate(x, y);
    c.rotate(H.wind.a - camYaw);
    c.scale(s, -s);
    c.fillStyle = hsl(.3 - H.wind.s/35,1,Math.max(.5,1-H.wind.s/20)); // colored wind indicator
    //c.fillStyle = WHITE;
    c.beginPath();
    c.lineTo(0, 1);
    c.lineTo(.4, -1);
    c.lineTo(-.4, -1);
    c.lineTo(0, 1);
    c.lineWidth = s*.01;
    c.strokeStyle = BLACK;
    c.stroke();
    c.fill();
    c.restore();
}

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
    // the impact line sits at METER_OVER/(1+METER_OVER) = .115
    
    if (!isPutt)
    {
        grad.addColorStop(0, '#f21');
        grad.addColorStop(.06, '#f4f');
        grad.addColorStop(.11, WHITE);
        grad.addColorStop(.12, WHITE);
        grad.addColorStop(.16, '#fd2');
    }
    else
        grad.addColorStop(0, '#fd2')

    grad.addColorStop(.3, '#f21');
    grad.addColorStop(.5, '#f4f');
    grad.addColorStop(.7, '#2af');
    grad.addColorStop(.9, '#2f5');
    grad.addColorStop(1, WHITE);
    ctx.fillStyle = grad;
    ctx.fillRect(bx, by, bw, bh);

    // What the bar's full power will ACTUALLY roll from here. puttVel always
    // works speed out against the GREEN's friction, so the scale itself is
    // "yards of green roll" wherever the ball sits - true on the green, a
    // promise the ground cannot keep anywhere else. Scaling by the friction
    // ratio turns it back into real yards: 40 on the green, 20 off fairway,
    // 9 out of rough, 4 from sand.
    // It is deliberately an ESTIMATE, and a pessimistic one: it assumes the
    // whole roll happens in this lie, when a ball a foot off the fringe
    // reaches smooth grass almost at once and will out-run the number. Off
    // the green, expect to need a little less than the bar says.
    const est = isPutt ? shotTarget*3/SURF_PHYS[ballGround().s][2] : shotTarget;

    if (isPutt)
    {
        // where the cup falls on the bar, so full power can be read against
        // it (the bar's top is the putter's reach, not the pin). Measured in
        // the same estimated yards as the label, or the two would disagree
        const cup = ballToPin()/est;
        if (cup < 1)
            fillRect(t2x(cup)-2, by-bh*.5, 4, bh*2, '#7df');
    }
    else
    {
        // the sweet spot: launchBall snaps err to zero inside |impact| < .02.
        // The .06 that prints GOOD is not drawn - nothing happens there.
        //fillRect(t2x(-.02), by, .04*xs, bh, '#fffa');
        //fillRect(t2x(-.02), by+20, .04*xs, bh, '#000a'); // test
        fillRect(t2x(-.02), by-bh*.3, .04*xs, bh*1.6, '#fffa');
        //armed || fillRect(t2x(0)-2, by-bh/2, 4, bh*2, WHITE);
    }

    // the top of the meter = the target distance
    fillRect(t2x(1)-2, by-bh/2, 4, bh*2, WHITE);
    txt(`${est|0}yd`, t2x(1)-bh*.3, by+bh*.5, bh*.6, 'right');

    // phase caption
    const cap = 'CLICK TO SWING!';
    // (above the bar, clear of the cursor's pointer triangle)
    const pulse = .03 + Math.sin(time*5)*.003;
    armed && txt(cap, W/2, by+bh/2, T*pulse);

    // power mark once chosen
    if (meterPhase == 2)
        fillRect(t2x(meterPower)-2, by-bh/2, 4, bh*2, GOLD);

    // cursor: tall marker with a pointer triangle (rests at the line pre-swing)
    const cx = t2x(armed ? 0 : meterPos());
    fillRect(cx-2.5, by-bh*.5, 5, bh*2, WHITE);
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
        const c = CLUBS[clubI], fs = Math.min(h*.6, w*.17), cy = y + h/2;
        for (const x of xs)
            panel(x, y, w, h, h*.3);
        txt('◀', xs[0]+w*.1, cy, fs);
        txt(c[1] ? `${c[0]} ${c[1]}yd` : c[0], xs[0]+w/2, cy, fs);
        txt('▶', xs[0]+w*.9, cy, fs);
        txt(isPutt ? '-' : SPIN_NAMES[spinMode+1], xs[1]+w/2, cy, fs, 'center', !isPutt && spinMode ? GOLD : WHITE);
        if (!isPutt)
        {
            txt('-', xs[2]+w*.1, cy, fs);
            txt('+', xs[2]+w*.9, cy, fs);
        }
        txt(`${shotTarget|0}yd`, xs[2]+w/2, cy, fs);
    }
}

// Rounded backing panel for the meter, chips and scorecard.
// QUOTE roundRect: Closure's externs predate it and would rename it, which
// is a release-only crash.
const panel = (x, y, w, h, r)=>
{
    const c = overlayContext;
    c.fillStyle = '#000a';
    c.beginPath();
    c['roundRect'](x, y, w, h, r);
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

// scorecard: after every hole (current hole named + highlighted, running
// total so far) and as the final results card
function renderScorecard(final)
{
    const W = mainCanvasSize.x, T = mainCanvasSize.y;
    // dim panel so the card reads over any scenery
    panel(W*.03, T*.05, W*.94, T*.9, T*.04);
    // two lines: the hole, then what you got on it. One line could not fit
    // "HOLE 3 — 🦄 HOLE IN ONE!" across a phone in portrait, and the long
    // names are exactly the ones you most want to read.
    txt(final ? 'SCORECARD' : `HOLE ${holeIndex+1}`, W/2, T*.1, T*.06);
    final || txt(scoreName(strokes, H.par), W/2, T*.18, T*.05);
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
            txt(h+1, x, y, T*.03, 'center', !final && h == holeIndex ? GOLD : WHITE);
            txt('PAR '+p, x, y+T*.035, T*.017, 'center', '#ccc');
            txt(s ?? '-', x, y+T*.1, T*.04, 'center', s < p ? GOLD : WHITE);
        }
    }
    const n = final ? 18 : holeIndex+1;
    const total = scoreTotal();
    // no click prompt: any click continues and the card is a dead end
    txt(`${final ? 'TOTAL' : 'THRU '+n}   ${relPar(total - parTotal(n))}`, W/2, T*.9, T*.05);
    if (final && debug && remixMode)
        txt(`REMIX SEED ${courseSeed}`, W/2, T*.8, T*.03);
}

function renderConfetti()
{
    const W = mainCanvasSize.x, T = mainCanvasSize.y;
    if (strokes <= H.par) // only if par or under
    for (let i=70; i--;)
    {
        const rx = i**3.1%W, rs = i**3.3%2+3;
        const y = ((stateTime*rs + i**3)%(T+40)) - 20;
        fillRect(rx + Math.sin((stateTime+i*9)*.05)*22, y, 6, 9,
            hsl(i**3.7, 1, .6), stateTime*.03 + i);
    }
}

///////////////////////////////////////////////////////////////////////////////
engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost);
