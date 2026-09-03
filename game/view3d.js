'use strict';

/*  SUNSHINE GOLF CLASSIC - view: cameras, project() for the 2D pin marker (the GL
    view-projection applied on the CPU, so it can never drift from the 3D
    view), and ground colours. The sky is entirely GL (glRender.js) -
    nothing 2D is drawn behind the scene. */

let camX=0, camY=5, camZ=-14, camYaw=0, camPitch=.13;
// screen focal length / canvas height. glPreRender's fl=2.1 lands here
// because Drive13K's projection form puts 2nf/range (~2) into clip w
const FOCAL = .525;

// world point -> screen pixels through the matrix glPreRender built this
// frame. z is clip w (~2x the view depth): <= 0 is behind the camera,
// where x comes out mirrored
function project(x, y, z)
{
    const p = glViewProj.transformPoint({x, y, z});
    return {x: (1 + p.x/p.w)*mainCanvasSize.x/2, y: (1 - p.y/p.w)*mainCanvasSize.y/2, z: p.w};
}

// THE PUTT ZOOM. camZoom(k) is k with the putter in hand and 1 otherwise, so
// a putt is simply the full-shot camera pulled in. It does NOT touch the
// field of view - that is fixed at 87 degrees vertical for every shot in the
// game - which is why a zoomed putt reads as the same shot seen from nearer
// rather than through a different lens.
// Each camera scales its DISTANCE BACK AND ITS HEIGHT TOGETHER, and that is
// the trick: the angle down to the subject never changes, so it stays put on
// screen and neither pitch needs a putt case. Ground clearance scales too,
// so the knobs keep responding instead of stalling against a fixed floor.
// Two numbers across three cameras - PUTT_ZOOM here for the two behind the
// ball (the aim pose and the chase, the same value in both so contact is not
// a cut), and setPlaceCam's own .5 for the preview.
const PUTT_ZOOM = .4;
// k = the multiplier to use when putting, 1 for every other club
const camZoom = (k)=> clubI == CLUB_PUTTER ? k : 1;

// behind the ball, along the aim. ONE POSE FOR EVERY CLUB bar the zoom -
// a separate putt pose was the last thing keeping putting a separate mode.
function setSwingCam(aimDir)
{
    const k = camZoom(PUTT_ZOOM);
    camYaw = aimDir;
    camX = ball.x - Math.sin(aimDir)*6*k;
    camZ = ball.z - Math.cos(aimDir)*6*k;
    // the ground clearance zooms too, same as setPlaceCam's, so the knob
    // keeps responding all the way down instead of hitting a fixed floor
    camY = Math.max(ballGround().h + 2.9*k, groundAt(camX, camZ).h + k);
    camPitch = .1;
}

// The preview click: hover behind the predicted stopping point looking down
// at it. A putt takes the same pose at HALF SIZE - 12yd back, 7yd up.
// A CONSTANT is enough, and scaling it to the putt is not worth it: the bar
// tops out at PUTT_MAX so predDist never exceeds about 41, and the cup sits
// at most 8yd short of predLand, so a fixed 12yd stand-off always keeps the
// cup in front of the camera - by 4yd in the very worst case.
// MEASURED, where the cup lands below screen centre (half-FOV 43.5deg):
//   2yd 22%   5yd 10%   12yd 20%   25yd 47%   33yd 70%
// Flattest around a 5yd putt, never off the bottom. The BALL does go behind
// the camera past 12yd, which is fine - the preview is about the hole.
// THIS CAMERA IS DELIBERATELY UNSMOOTHED - Frank's call, 2026-09-01, after
// playing both. It tracks predLand exactly and snaps with it.
// It does inherit a small stutter as the aim turns, and the cause is NOT
// fixable upstream: where a rolling ball comes to rest on sloped ground is a
// genuinely sensitive function of the aim. Measured three ways - force ONE
// uniform surface, so friction has no step in it anywhere, and the tread gets
// WORSE (.876yd) and does not move at all between DT=1/60 and DT/8. A
// trapezoid position update and an analytic final step each changed it by
// .000. Only the sand case has a real integration component (.168 -> .038 at
// DT/8) and even that leaves a residual. So no integrator, Newton or
// otherwise, removes it - see CHANGELOG v0.13-p255.
// A lerp on the CAMERA does hide it (.558yd worst frame-to-frame down to
// .074, for .233yd of lag), which is what p252/p253 built and Frank then
// declined on feel. The bugs that hunt exposed - the meter's cup marker
// sweeping the bar, the shot line missing the middle of its own ring - came
// from easing predLand itself and are fixed for good.
function setPlaceCam()
{
    const k = camZoom(.5);
    camYaw = aimYaw;
    camX = predLand.x - Math.sin(aimYaw)*24*k;
    camZ = predLand.z - Math.cos(aimYaw)*24*k;
    camY = Math.max(groundAt(predLand.x, predLand.z).h + 14*k,
        groundAt(camX, camZ).h + 3*k);
    camPitch = .5;
}

// debug map: straight down over the hole's path bounding box, tee at the
// bottom of the screen. Fit: the focal length is FOCAL*height, so the
// visible half-extent at distance d is d/(2*FOCAL) -> d = 1.1*FOCAL*extent
// fits it with a margin.
function setMapCam()
{
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const p of hole.path)
    {
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
        z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
    }
    const w = x1 - x0 + 180, l = z1 - z0 + 120;
    camYaw = 0;
    camPitch = Math.PI/2;
    camX = (x0 + x1)/2;
    camZ = (z0 + z1)/2;
    camY = hole.greenH + 1.1*FOCAL*Math.max(l, w*mainCanvasSize.y/mainCanvasSize.x);
}

// palette [h,s,l] (+ lightness/hue offsets) -> engine Color
const hslCol = (c, dl=0, dh=0)=> hsl((c[0]+dh)/360, c[1]/100, (c[2]+dl)/100);

// ground colour at a terrain vertex: surface colour + mow stripes
// g = the caller's own groundAt(x, z) record. Taking it rather than
// resampling is what keeps the terrain build to one groundAt per vertex; the
// caller must not have sampled anywhere else in between, since the mow-stripe
// and mottle terms below read the lastAlong/lastDist that call left behind.
function groundColor(x, z, g)
{
    const pal = hole.pal;
    let c, dl = 0;
    if (g.s == SURF_FAIRWAY || g.s == SURF_TEE)
    {
        c = pal.fair;
        dl = (lastAlong/9 & 1)*5; // distToPath was just called by groundAt
    }
    else if (g.s == SURF_GREEN)
    {
        c = pal.green;
        dl = (Math.hypot(x-hole.pin.x, z-hole.pin.z)/2.6 & 1)*5;
    }
    else if (g.s == SURF_BUNKER) c = pal.sand;
    else if (g.s == SURF_WATER)
    {
        c = pal.water;
        return hslCol(c).scale(1, .997); // 254/255 marks water for the shader wave
    }
    else // rough + OB darker; the fine mottle fades out toward the periphery
    {    // (its cells are far too coarse for it - it would streak)
        c = pal.rough;
        dl = (g.s == SURF_OB ? -8 : 0) + (noise2(x*.15, z*.15)-.5)*6*(1 - clamp((lastDist-100)/100));
    }
    return hslCol(c, dl);
}

// the frame. The haze (fog colour) is the sky's horizon tint: far terrain
// fogs into it and it is also the clear colour, so there is no horizon line
function renderView3d()
{
    glFogColor = hslCol(hole.pal.sky1, -8);
    renderViewGL(); // sky, world, sun/clouds, pin, ball, trail, aim aids
}
