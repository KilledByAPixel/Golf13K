'use strict';

/*  SUNSHINE GOLF CLASSIC - the HUD layer

    Everything drawn on overlayCanvas in 2D. gameRenderPost composes the
    frame; renderMeter / renderScorecard / renderConfetti / drawWind are its
    pieces; panel / fillRect / txt / tri / rainbowText are the primitives.
    Nothing here touches GL - the 3D scene is glRender.js and view3d.js.

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
            rainbowText('SUNSHINE', midX, T*.18, T*.14);
            rainbowText('GOLF CLASSIC', midX, T*.3, T*.1, 1);
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
        const pad = T*.05; // breathing room off the screen top
        txt(`HOLE ${holeIndex+1}  PAR ${hole.par}`, 18, pad, T*.04, 'left');
        // the shot IN PLAY: strokes increments at impact, so aim and the
        // meter are one ahead of it and the flight is not
        txt(`${ballToPin()|0}yd TO PIN`, 18, pad+T*.05, T*.03, 'left');
        txt(`SHOT ${strokes + (state < ST_FLIGHT)}`, 18, pad+T*.095, T*.03, 'left');
        txt(`SCORE ${relPar(scoreTotal() - parTotal(holeIndex))}`, W-18, pad, T*.04, 'right');
        // 2.86 mph per wind unit is the real conversion: a unit is WIND_V =
        // 1.4 yd/s of air and a yard per second is 2.0455mph. The exact 2.864
        // prints the same integer at every wind after the |0.
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
            // hovers above the flag top so the real flag stays visible under it
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
// the HUD is this shape: the wind vane, the turn arrows, the club chevrons.
// DRAWN rather than typed on purpose - U+25C0 and U+25B6 carry emoji
// presentation variants, and phone fonts render them as colour blobs.
// w is the HALF-WIDTH: 1 is the chunky UI arrow (the default), .4 the wind
// vane's pointy dart. (Equilateral would be 1.155 and reads as a diamond.)
// lw is the outline in LOCAL units, inside the scale(s,-s), so one constant
// lands the same weight at every size; the chevrons pass .4 to match txt's
// size*.15 outline at their s = fs/3. Passing a SCREEN-space width is the
// trap - it arrives divided by s.
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
// camera's frame so it reads against the hole rather than the compass
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

    panel(bx-bh*.3, by-bh*.3, bw+bh*.6, bh*1.6, bh*.5);

    // power track: green -> yellow -> red toward the full-power target
    // (raw context: the engine has no gradient fills)
    const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    // the gradient spans the whole bar, so a stop fraction is NOT a meter t:
    // the impact line sits at METER_OVER/(1+METER_OVER) = .115.
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

    // The printed yardage (predDist) is what full power DELIVERS: where the
    // simulation says the ball stops, so it moves with the spin, the club and
    // the ground, not only the wheel. shotTarget is what the meter is SCALED
    // to; predLand is where the ring sits, so the number and the mark are the
    // same claim.

    // WHERE THE CUP FALLS on the bar
    if (ballToPin() < predDist)
    {
        fillRect(t2x(ballToPin()/predDist)-3, by-bh*.5, 6, bh*2, '#8df');
    }
    // the sweet spot, on every club: launchBall snaps err to zero inside
    // |impact| < .02. The .06 that prints GOOD is not drawn - nothing happens there.
    fillRect(t2x(-.02), by-bh*.3, .04*xs, bh*1.6, '#fffa');

    // caption above the bar, clear of the cursor's pointer triangle
    const cap = 'CLICK TO SWING!';
    armed && txt(cap, W/2, by+bh/2, T*.04);

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
        // KNOB: fs/3 sizes the chevrons against the chip's text; their .4
        // outline is matched to that ratio (see tri)
        tri(xs[0]+w*.1, cy, fs/3, -PI/2, WHITE, 1, .4);
        tri(xs[0]+w*.9, cy, fs/3, PI/2, WHITE, 1, .4);
        txt(c[0], xs[0]+w/2, cy, fs);
        txt(isPutt ? '-' : SPIN_NAMES[spinMode+1], xs[1]+w/2, cy, fs, 'center', !isPutt && spinMode ? GOLD : WHITE);
        // the - and + show on a putt too: the distance chip drives the putt
        // bar exactly as it drives every other club's
        txt('-', xs[2]+w*.1, cy, fs);
        txt('+', xs[2]+w*.9, cy, fs);
        // the one place the yardage is printed
        txt(`${predDist|0}yd`, xs[2]+w/2, cy, fs);
    }
}

// Rounded backing panel for the meter, chips and scorecard.
// QUOTE roundRect: Closure's externs predate it and would rename it, a
// release-only crash. The rect FALLBACK covers browsers older than roundRect
// (the NEWEST api this game uses - Safari 16 / Firefox 112, both later than
// the WebGL2 the renderer needs): panel() runs inside gameRenderPost, before
// requestAnimationFrame with no catch, so a missing method would freeze the
// game on the title's first frame. rect ignores the extra radius, so an old
// browser gets square corners and plays on.
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
    // ONE GLYPH AT A TIME, each in a SOLID colour - never a gradient. A
    // gradient paint costs about 6.5x a solid one in Firefox and stroking
    // over it multiplies that again: fill+stroke in gradients measured
    // 1.63ms a frame at this size against 0.35 for this loop, and the title
    // draws two lines of it. Per-letter hues look the same and let the
    // outline stay a REAL stroke, since a solid stroke is nearly free.
    // TWO PASSES over the letters: the first totals their widths plus the
    // gap so the word can be centred, the second draws them at that spacing.
    // KNOBS, all in the loop below:
    //   size/5  letter spacing, as a share of the font size
    //   FILL    hue runs along the word by i/9 and cycles with time/5;
    //           lightness is flat, so every letter is equally vivid
    //   STROKE  greyscale, and a TRAVELLING HIGHLIGHT rather than a plain
    //           outline: the **8 turns the sine into a narrow spike, so the
    //           outline is black on most letters and flares on one at a
    //           time. i/3 sets how wide that flare is along the word,
    //           time*2 how fast it sweeps, /2 how bright it gets.
    const ctx = overlayContext;
    // the title is sized off the canvas HEIGHT, so on a portrait phone the
    // word would run off the sides: cap it by the width it will need, which
    // is a cap of about half the font size plus the gap above. MEASURED at
    // 1.4: the title clears both edges at 1280x800, 414x896 and 320x900, by
    // about 4px at the narrowest - so this is tight, and a wider gap or a
    // longer word needs the number lowered again.
    size = Math.min(size, mainCanvasSize.x*1.4/t.length);
    ctx.font = size + 'px impact';
    ctx.lineWidth = size/9;
    // textAlign is deliberately NOT set: re-sizing the overlay canvas at the
    // top of gameRenderPost resets the context every frame, so it is back to
    // its 'start' default here, which is what placing glyphs by hand wants.
    // The same reset is why lineJoin and textBaseline are set up there. This
    // only holds because the title is the FIRST thing drawn in a frame - put
    // any txt() call before it and it will set 'center' and shift every
    // letter, so set it here again if that ever changes.
    let w = 0, px = x;
    for (let p = 2; p--;)
    for (let i = 0; i < t.length; ++i)
    {
        const c = t[i], cw = ctx.measureText(c).width + size/5;
        if (p)
        {
            w += cw; // pass one: total only
            continue;
        }
        ctx.strokeStyle = hsl(0, 0, Math.sin(i/3+style-time*2)**8/2);
        ctx.fillStyle = hsl(style/2+i/9+time/5, 1, .6);
        ctx.strokeText(c, px-w/2, y);
        ctx.fillText(c, px-w/2, y);
        px += cw;
    }
}

// THE scorecard, in its two moods, told apart by roundOver() alone.
// JUST HOLED OUT: the hole named, its score called, that hole lit gold in
// the grid, running total - the celebration.
// REVIEWING (CONTINUE after the round, holeIndex past the end): plain
// SCORECARD, no score called, nothing lit, TOTAL, no confetti. The grid
// highlight needs no test: holeIndex is past 17 while reviewing, so the
// h == holeIndex below simply never matches.
function renderScorecard()
{
    const W = mainCanvasSize.x, T = mainCanvasSize.y, over = roundOver();
    // confetti FIRST so the panel sits over it, and never while reviewing
    over || renderConfetti();
    panel(W*.03, T*.05, W*.94, T*.9, T*.04);
    // two lines: "HOLE 3 — 🦄 HOLE IN ONE!" does not fit one line on a phone
    // in portrait, and the long names are the ones you most want to read
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
    if (strokes <= hole.par)
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
