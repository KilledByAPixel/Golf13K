'use strict';

/*  RAINBOW GOLF TOUR - view: cameras, project() for the 2D pin marker (the GL
    view-projection applied on the CPU, so it can never drift from the 3D
    view), ground colours, and the 2D sky gradient behind the GL scene
    (the sun and clouds are GL geometry). */

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

// position camera behind the ball along the aim direction
function setSwingCam(aimDir, putt)
{
    const back = putt ? 3 : 6, up = putt ? 1.8 : 2.9;
    camYaw = aimDir;
    camX = ball.x - Math.sin(aimDir)*back;
    camZ = ball.z - Math.cos(aimDir)*back;
    camY = Math.max(ballGround().h + up, groundAt(camX, camZ).h + 1);
    camPitch = putt ? .2 : .1;
}

// The preview click. On a full shot: hover behind the predicted touchdown
// looking down at it. Putting: straight down over the ball and the cup
// instead, turned so the aim runs up the screen - a landing ring 40yd off
// the green would tell you nothing about the line.
function setPlaceCam(putt)
{
    camYaw = aimYaw;
    if (putt)
    {
        camX = (ball.x + H.pin.x)/2;
        camZ = (ball.z + H.pin.z)/2;
        camY = groundAt(camX, camZ).h + 12 + ballToPin();
        camPitch = Math.PI/2;
        return;
    }
    camX = predLand.x - Math.sin(aimYaw)*24;
    camZ = predLand.z - Math.cos(aimYaw)*24;
    camY = Math.max(groundAt(predLand.x, predLand.z).h + 14,
        groundAt(camX, camZ).h + 3);
    camPitch = .5;
}

// debug map: straight down over the hole's path bounding box, tee at the
// bottom of the screen. Fit: the focal length is FOCAL*height, so the
// visible half-extent at distance d is d/(2*FOCAL) -> d = 1.1*FOCAL*extent
// fits it with a margin.
function setMapCam()
{
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const p of H.path)
    {
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
        z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
    }
    const w = x1 - x0 + 180, l = z1 - z0 + 120;
    camYaw = 0;
    camPitch = Math.PI/2;
    camX = (x0 + x1)/2;
    camZ = (z0 + z1)/2;
    camY = H.greenH + 1.1*FOCAL*Math.max(l, w*mainCanvasSize.y/mainCanvasSize.x);
}

// palette [h,s,l] (+ lightness/hue offsets) -> engine Color
const hslCol = (c, dl=0, dh=0)=> hsl((c[0]+dh)/360, c[1]/100, (c[2]+dl)/100);

// ground colour at a terrain vertex: surface colour + mow stripes
function groundColor(x, z)
{
    const g = groundAt(x, z);
    const pal = H.pal;
    let c, dl = 0;
    if (g.s == SURF_FAIRWAY || g.s == SURF_TEE)
    {
        c = pal.fair;
        dl = (lastAlong/9 & 1)*5; // distToPath was just called by groundAt
    }
    else if (g.s == SURF_GREEN)
    {
        c = pal.green;
        dl = (Math.hypot(x-H.pin.x, z-H.pin.z)/2.6 & 1)*5;
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
    glFogColor = hslCol(H.pal.sky1, -8);
    renderViewGL(); // sky, world, sun/clouds, pin, ball, trail, aim aids
}
