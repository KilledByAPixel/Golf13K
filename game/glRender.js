'use strict';

/*  RAINBOW GOLF TOUR - WebGL renderer
    Ported from Frank's Dr1v3n Wild (Drive13K) rendering engine: batched
    triangle strips, vertex colors, fog, z-buffer. Terrain is a heightfield
    mesh (smooth gouraud), props are flat-shaded lathes (octahedra, boxes).
    Lighting is BAKED at push time - the sun never moves - so a vertex is
    20 bytes (xyz, fog-exempt flag, lit RGBA8) and the shader only fogs.
    Layering: glCanvas (3D, the whole picture) < overlayCanvas (HUD). */

///////////////////////////////////////////////////////////////////////////////
// minimal Vector3 (subset of Drive13K utilities)

const vec3 = (x, y, z)=> new Vector3(x, y, z);
class Vector3
{
    constructor(x=0, y=0, z=0) { this.x=x; this.y=y; this.z=z; }
    add(v) { return vec3(this.x+v.x, this.y+v.y, this.z+v.z); }
    subtract(v) { return vec3(this.x-v.x, this.y-v.y, this.z-v.z); }
    scale(s) { return vec3(this.x*s, this.y*s, this.z*s); }
    normalize(l=1) { const d = Math.hypot(this.x, this.y, this.z); return d ? this.scale(l/d) : vec3(l); }
    cross(v) { return vec3(this.y*v.z-this.z*v.y, this.z*v.x-this.x*v.z, this.x*v.y-this.y*v.x); }
}

///////////////////////////////////////////////////////////////////////////////
// webgl core (Drive13K webgl.js, adapted: alpha canvas, yard-scale fog,
// projection matched to the game's software project())

let glCanvas, glContext, glShader, glVertexData, glVertexU32;
let glBatchCount;
let glEnableFog=1, glFogScale=1, glFogColor = WHITE;
// ONE vertex stream: [static world | dynamic batch]. The world is built at 0
// once per hole into its own GPU buffer (one draw call); the per-frame batch
// starts at glBase = its end, so the push helpers never need redirecting
let glBase = 0, glStaticCount = 0, glStaticBuffer, glDynamicBuffer;
// Set per hole in buildWorld, which always runs before anything is pushed.
// glLightDir is left undefined here; the headless unit harness supplies its
// own, since it never builds a world.
let SUN_E = .5, SUN_A = -.5, glLightDir;
///////////////////////////////////////////////////////////////////////////////
// THE WATER: a vertex-shader snippet spliced into the terrain shader.
// Lakes are marked by an alpha of 254/255, a band no other geometry uses.
// Two plane waves, a slow SWELL and a faster CHOP crossing it. Each must mix
// x AND z - a sine of x plus a sine of z is separable, which is a lattice of
// bumps pulsing in place. Numbers per line: time speed, then the x and z
// direction terms (bigger = shorter waves). Keep a wave several times longer
// than the 2yd mesh cell or it aliases.
const PRISM = 1;    // 1 = rainbow foam instead of white (+18 bytes)
const SPARKLE = 0;  // twinkling glints on the water (Closure folds the 0 out)
const SPEC = 1;     // sun specular on the water - the only camera-aware light

// A second species of wildflower: this fraction take a big hue offset from
// the hole's pal.flower instead of the small jitter. SECOND_MIX = 0 removes
// it; 150 degrees is near-complementary, 30-60 a shade of the same family.
const SECOND_MIX = .1, SECOND_HUE = 90;
const WATER_GLSL =
// Two things stop this reading as a sine wave, neither needing noise:
// PHASE WARP (+B*.9) puts B inside A's phase, so crests bunch and stretch
// instead of spacing evenly; and an AMPLITUDE FIELD - a very long still
// sine - gives the lake calm and choppy stretches.
// THE WAVES TRAVEL WITH THE WIND (Frank, 2026-08-31, reshaped same day):
// positions project into the wind frame - U runs along u.xy (the wind
// direction), V across it. ONE MAIN WAVE rides the wind axis and marches
// toward +U, the way the arrow points; wave B is the SMALL one, laid on
// the CROSS axis, and it warps the main wave's phase so crests bunch and
// stretch. u.z is the water CLOCK: time pre-scaled by wind strength on
// the CPU, so a windy hole chops faster and a calm one idles, never to
// zero (the scale is in glPreRender).
// KNOBS: .33 main wavelength, .28 cross wavelength, B's .6 in w = the
// cross wave's height share, .9 = the warp.
     'float U=v.x*u.x+v.z*u.y,'          // yards along the wind
    +'V=v.x*u.y-v.z*u.x,'                // yards across it
    +'b=u.z*.3+V*.28,B=sin(b),'          // the small CROSS wave, slow
    +'a=u.z-U*.33+B*.9,'                 // the MAIN wave, warped by B
    +'w=(sin(a)+B*.6)'               // surface height: main-dominant
    +'*(.6+.4*sin(v.x*.04+v.z*.03));'    // calm/choppy patches (still, world-anchored)
    +'v.y+=w*.4;'                      // WAVE HEIGHT, yards
    // THE SURFACE GRADIENT as a real (x,z) vector: the main wave tilts
    // along the wind (P), the cross wave across it (Q), with the same
    // .33/.28 as a and b above, scaled by cos (the derivative of its sin)
    // and by its amplitude.
    +'vec2 P=vec2(u.x,u.y),Q=vec2(u.y,-u.x),'
    +'G=P*-.33*cos(a)*1.2+Q*.28*cos(b)*.6;'
    // Shading MUST project the gradient onto the LIGHT, or the same face of
    // every wave brightens whatever SUN_A is. Vertex lighting is baked at
    // push time, so displacing the surface cannot otherwise re-light it.
    +'d.rgb*=1.-dot(G,l.xz)*.6;'
    // Specular: the one term that depends on where the camera stands. Broad
    // exponent on purpose - per-VERTEX on a 2yd mesh, so a tight highlight
    // would pop between vertices instead of sliding.
    // KNOBS: 12. (higher = tighter), .5 (brightness). SPEC = 0 removes it.
    +(SPEC ? 'd.rgb+=pow(max(dot(reflect(-l,normalize(vec3(-G.x,1,-G.y))),'
        +'normalize(e-v)),0.),12.)*.5;' : '')
    // Foam must lead with ONE wave: thresholding the SUM lights only where
    // both peak, and those coincidences are isolated points rather than a
    // line. The swell alone clears the threshold; the chop is weighted low
    // (.12) so it only wobbles the edge.
    +'d.rgb+=max(sin(a)+B*.12-.6,0.)*.55'
    +(PRISM ? '*(1.+.6*cos(w*3.+vec3(0,2,4)))' : '')+';'
    // Sparkle: each water vertex twinkles on its own hashed clock, so glints
    // pop at random rather than sweeping past as a pattern. max(cos(a),0.)
    // clusters them on the face tilted toward the light, where sun on water
    // actually glints - drop it to scatter them evenly.
    // KNOBS: .8 (raise for fewer), 100. (higher = briefer), 5. (rate),
    // .7 (brightness).
    +(SPARKLE ?
     'float h=fract(sin(v.x*127.1+v.z*311.7)*43758.5);'
    +'d.rgb+=step(.8,h)*pow(max(sin(h*63.+t*5.),0.),100.)*max(cos(a),0.)*.7;' : '');
const glLightColor = [.45, .45, .4], glAmbient = [.6, .6, .65];

// called by engine.js during engineInit, before the overlay canvas is
// appended - so the layering lands glCanvas < overlayCanvas
function glInit(rootElement)
{
    rootElement.appendChild(glCanvas = document.createElement('canvas'));
    // premultiplied alpha (the canvas default): the fragment shader
    // multiplies rgb by alpha and the blend is ONE/ONE_MINUS_SRC_ALPHA, so
    // the fog fade band composites correctly over the 2D sky and additive
    // batches (the flare) add straight onto the page
    glContext = glCanvas.getContext('webgl2');
    if (!glContext) return; // no webgl2: nothing renders (no 2D fallback)

    glShader = glCreateProgram(
        '#version 300 es\n' +         // (vertex shaders default to highp)
        'uniform mat4 m;uniform float t;uniform vec3 l,e,u;'+ // sun dir, eye pos, wind (xy dir, z water clock)
        'in vec4 p,c;'+               // position (w = fog-exempt flag), lit color
        'out vec4 d;out float q;'+
        // water rides the 254/255 alpha band - WATER_GLSL, at the top of
        // this file, is the whole effect
        'void main(){vec3 v=p.xyz;d=c;'
        +'if(c.a>.995&&c.a<1.){'+WATER_GLSL+'}'
        // Foliage rides a second alpha band. BOTH bands need `c.a<1.` -
        // opaque geometry is alpha 1, and without it every trunk, terrain
        // vert, pin and ball sways too.
        +'else if(c.a>.9&&c.a<1.){float w=sin(t*2.+v.x*.2+v.z*.5)+sin(t*3.3+v.z*.3-v.x*.1);'
        +'v.xz+=w*(c.a-.9)*3.;d.a=1.;}'
        +'gl_Position=m*vec4(v,1.);q=p.w;}'
        ,
        '#version 300 es\n' +
        'precision highp float;'+
        'uniform vec4 f;'+            // fog color, w = global fog scale (0 = off)
        'in vec4 d;in float q;'+
        'out vec4 c;'+
        'void main(){'+
        'float z=gl_FragCoord.z/gl_FragCoord.w*f.w;'+
        // fog: blend toward the haze color with distance (yards), then
        // alpha-fade at the far edge so the 2D sky shows through
        'c=q>0.?d:vec4(mix(d.xyz,f.xyz,clamp(z*z/5e5,0.,1.)),d.a*clamp(4.-z/200.,0.,1.));'+
        'c.rgb*=c.a;'+                // premultiply
        '}'
    );
    glContext.useProgram(glShader);
    glContext.blendFunc(gl_ONE, gl_ONE_MINUS_SRC_ALPHA);
    glContext.enable(gl_BLEND);
    glContext.enable(gl_DEPTH_TEST); // no face culling: mixed strip windings
    glStaticBuffer = glContext.createBuffer();
    glSetBuffer(glDynamicBuffer = glContext.createBuffer());
    glContext.bufferData(gl_ARRAY_BUFFER, gl_MAX_BATCH*gl_VERTEX_BYTE_STRIDE, gl_DYNAMIC_DRAW);
    glVertexData = new Float32Array((gl_STATIC_MAX + gl_MAX_BATCH)*gl_INDICIES_PER_VERT);
    glVertexU32 = new Uint32Array(glVertexData.buffer);
}

// bind a vertex buffer and point the two attributes at it
function glSetBuffer(buffer)
{
    glContext.bindBuffer(gl_ARRAY_BUFFER, buffer);
    const attr = (name, type, norm, offset)=>
    {
        const l = glContext.getAttribLocation(glShader, name);
        glContext.enableVertexAttribArray(l);
        glContext.vertexAttribPointer(l, 4, type, norm, gl_VERTEX_BYTE_STRIDE, offset);
    }
    attr('p', gl_FLOAT, 0, 0);
    attr('c', gl_UNSIGNED_BYTE, 1, 16);
}

function glCompileShader(source, type)
{
    const shader = glContext.createShader(type);
    glContext.shaderSource(shader, source);
    glContext.compileShader(shader);
    if (debug && !glContext.getShaderParameter(shader, gl_COMPILE_STATUS))
        throw glContext.getShaderInfoLog(shader);
    return shader;
}

function glCreateProgram(vsSource, fsSource)
{
    const program = glContext.createProgram();
    glContext.attachShader(program, glCompileShader(vsSource, gl_VERTEX_SHADER));
    glContext.attachShader(program, glCompileShader(fsSource, gl_FRAGMENT_SHADER));
    glContext.linkProgram(program);
    if (debug && !glContext.getProgramParameter(program, gl_LINK_STATUS))
        throw glContext.getProgramInfoLog(program);
    return program;
}

const glUniform = (name)=> glContext.getUniformLocation(glShader, name);

// engine.js compatibility: canvases stay layered, nothing to copy,
// and the engine's sprite textures are never GL-backed here
function glCopyToContext() {}
function glCreateTexture() {}

// View-projection + fog uniform, once per frame. glViewProj is kept for
// project(), so the 2D pin marker cannot drift from the GL view.
// NOTE this projection form puts 2nf/range (~2) into clip w, so fl=2.1 is an
// effective focal length of .525*height (FOCAL in view3d.js), not 1.05.
let glViewProj;
function glPreRender()
{
    if (!glContext) return;
    glContext.viewport(0, 0, glCanvas.width, glCanvas.height);
    glBatchCount = 0;

    // Depth row 1,2 is the INFINITE far plane - the limit of (n+f)/range and
    // 2nf/range as f goes to infinity. Nothing is ever clipped by distance
    // and the near clip stays at 1/3yd.
    const fl = 2.1, D = 57.3; // 180/Math.PI;
    const proj = new DOMMatrix([
        fl*glCanvas.height/glCanvas.width, 0, 0, 0,
        0, fl, 0, 0,
        0, 0, 1, 2,
        0, 0, -1, 0
    ]);
    // camera pose: pitch about x, yaw about y, then the eye offset. DOMMatrix
    // rotates counter-clockwise in degrees, LittleJS angles are clockwise
    // radians, hence the negated degrees. (Verified equal to the old
    // hand-built view matrix to float32 precision.)
    glViewProj = proj.rotate(-camPitch*D, 0, 0).rotate(0, -camYaw*D, 0).translate(-camX, -camY, -camZ);
    glContext.uniformMatrix4fv(glUniform('m'), 0, glViewProj.toFloat32Array());
    glContext.uniform4f(glUniform('f'), glFogColor.r, glFogColor.g, glFogColor.b, glFogScale);
    glContext.uniform1f(glUniform('t'), time);
    // the water shades its waves against the sun; everything else is lit at
    // bake time and needs no light uniform
    glContext.uniform3f(glUniform('l'), glLightDir.x, glLightDir.y, glLightDir.z);
    glContext.uniform3f(glUniform('e'), camX, camY, camZ);  // for the specular
    // the water's wind: xy = direction, z = the water CLOCK - time scaled
    // by strength so a windy hole chops faster. .6 + s*.05 spans .65 at
    // the calm floor (never zero, Frank's spec) to 1.2 at the 12 ceiling.
    glContext.uniform3f(glUniform('u'), Math.sin(H.wind.a), Math.cos(H.wind.a), time*(.6 + H.wind.s*.05));
    // Cleared to the HAZE: this is what shows below the horizon wherever the
    // terrain does not reach, so it has to match the fog. Clearing to the sky
    // top instead (p158) put sky colour along the horizon - the terrain does
    // NOT always rise above it. The high sky is covered by geometry instead.
    glContext.clearColor(glFogColor.r, glFogColor.g, glFogColor.b, 1);
    glContext.clear(gl_DEPTH_BUFFER_BIT|gl_COLOR_BUFFER_BIT);
}

// flush the dynamic batch
function glRender()
{
    if (!glBatchCount) return;
    glSetBuffer(glDynamicBuffer);
    glContext.bufferSubData(gl_ARRAY_BUFFER, 0,
        glVertexData.subarray(glBase*gl_INDICIES_PER_VERT, (glBase + glBatchCount)*gl_INDICIES_PER_VERT));
    glContext.drawArrays(gl_TRIANGLE_STRIP, 0, glBatchCount);
    glBatchCount = 0;
}

// Color -> packed RGBA8, lit by the fixed sun when a normal is given
// (lighting is baked here; the shader only fogs)
function packColor(c, n)
{
    const s = n ? Math.max(0, n.x*glLightDir.x + n.y*glLightDir.y + n.z*glLightDir.z) : 0;
    const b = (v, i)=> Math.min(255, v*(n ? glAmbient[i] + glLightColor[i]*s : 1)*255)|0;
    return b(c.r,0) | b(c.g,1)<<8 | b(c.b,2)<<16 | (c.a*255|0)<<24;
}

function glPushVert(pos, color)
{
    const i = (glBase + glBatchCount++)*gl_INDICIES_PER_VERT;
    glVertexData[i]   = pos.x;
    glVertexData[i+1] = pos.y;
    glVertexData[i+2] = pos.z;
    glVertexData[i+3] = !glEnableFog;
    glVertexU32[i+4]  = color;
}

// capped triangle strip; colors = one packed color or one per point
function glPushVerts(points, colors)
{
    const n = points.length, c = (i)=> colors[i] ?? colors;
    if (glBase && n+2 >= gl_MAX_BATCH - glBatchCount) // (the static build never flushes)
        glRender();
    glPushVert(points[0], c(0));
    for (let i=0; i<n; ++i)
        glPushVert(points[i], c(i));
    glPushVert(points[n-1], c(n-1));
}

// single-color strip lit by a face normal (null = unlit)

// gl constants as ints (minify-friendly, from Drive13K)
const
gl_TRIANGLE_STRIP = 5, gl_DEPTH_BUFFER_BIT = 256, gl_ONE = 1,
gl_ONE_MINUS_SRC_ALPHA = 771, gl_DEPTH_TEST = 2929, gl_BLEND = 3042,
gl_UNSIGNED_BYTE = 5121, gl_FLOAT = 5126, gl_COLOR_BUFFER_BIT = 16384,
gl_ARRAY_BUFFER = 34962, gl_STATIC_DRAW = 35044, gl_DYNAMIC_DRAW = 35048,
gl_FRAGMENT_SHADER = 35632, gl_VERTEX_SHADER = 35633,
gl_COMPILE_STATUS = 35713, gl_LINK_STATUS = 35714,
gl_MAX_BATCH = 3e4, gl_STATIC_MAX = 5e5, gl_INDICIES_PER_VERT = 5, gl_VERTEX_BYTE_STRIDE = 20;

///////////////////////////////////////////////////////////////////////////////
// static world: everything that never moves (terrain, trees) is pushed once
// per hole into its own GPU buffer and drawn with a single call.

// the static stream is [terrain | far trees + bushes | NEAR TREES]: hideTrees
// re-bakes just the tail, without the trees standing over the ball. Terrain
// goes first because it is the expensive part - 114ms of the 166ms a full
// rebake costs, against 8ms for the tail alone
let nearStart = 0;
function buildWorld()
{
    glBase = glBatchCount = 0;
    // Hole 1 is late morning, hole 18 nearly down (43 deg -> 11), and the
    // heading is scattered per hole with sin() of the index - no rand()
    // draw, since genHole's stream must not move. Both stay in frame from
    // the tee, which is what the flare needs.
    glLightDir = skyDir(SUN_A = Math.sin(H.index*2.4+1),
        SUN_E = lerp(.75, .2, H.index/17));
    if (debug && DEV_THUMBNAIL) // debug-gated or the 1 FOLDS INTO RELEASE
        SUN_E = .5;
    pushTerrain();
    for (const t of H.trees)
        if (t.k & 1) pushTreeGL(t); // the ODD kinds: far forest + flowers,
        // i.e. everything H.near (the even kinds) does not carry
    nearStart = glBatchCount;
    bakeNear();
}

// the tail of the static stream: the near trees from nearStart, then the
// whole world goes up to the GPU and the dynamic batch moves in behind it.
// (A whole-stream upload per shot, not just the tail: it is one call either
// way and a few ms of bus time against the 8ms tail bake.)
function bakeNear()
{
    glBase = 0; glBatchCount = nearStart;
    for (const t of H.near)
        pushTreeGL(t);
    glStaticCount = glBatchCount;
    ASSERT(glStaticCount < gl_STATIC_MAX, 'static stream overflow');
    glSetBuffer(glStaticBuffer);
    glContext.bufferData(gl_ARRAY_BUFFER, glVertexData.subarray(0, glStaticCount*gl_INDICIES_PER_VERT), gl_STATIC_DRAW);
    glBase = glStaticCount;
    glBatchCount = 0;
}

// grid coordinates: MESH_CELL cells through [a, b], then 12 steps growing
// x1.35 outward on both sides - the ground runs ~550yd past the corridor
// into the fog (a tensor grid cannot crack or T-junction)
const MESH_CELL = 2;
function gridAxis(a, b)
{
    const v = [];
    for (let x = a; x < b; x += MESH_CELL) v.push(x);
    v.push(b);
    // the coarse ring starts at 4yd whatever MESH_CELL is: it grows x1.35
    // for 12 steps, so tying it to the cell size would shrink the world's
    // reach with it (at 2yd cells: 315yd instead of 630, which drops the
    // outer forest off the grid entirely and NaNs meshHeightAt)
    for (let s = 4, i = 0; i < 12; ++i)
    {
        s *= 1.35;
        v.push(v[v.length-1] + s);
        v.unshift(v[0] - s);
    }
    return v;
}

// the terrain grid: axis coordinates + vertex heights, kept after the build
// so meshHeightAt can stand props on the surface the eye actually sees
let meshXs, meshZs, meshH;
function buildGrid()
{
    // fine cells over the path + features, coarse ring far out
    let minX = 0, maxX = 0;
    for (const p of H.path) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); }
    for (const w of H.waters) { minX = Math.min(minX, w.x-w.rx); maxX = Math.max(maxX, w.x+w.rx); }
    meshXs = gridAxis(minX - 80, maxX + 80);
    meshZs = gridAxis(-40, H.len + 60);
    meshH = meshZs.map(z => meshXs.map(x => groundAt(x, z).h));
}

// height of the DRAWN mesh at (x, z): the exact plane of the strip triangle
// under the point (the diagonal runs (i,j)->(i+1,j+1)). Props must use this,
// not heightAt: the coarse periphery cells (up to ~145yd) cut chords through
// the analytic hills, yards off the true height. No bounds guard - the grid
// reaches >= 630yd past the corridor and the forest scatters only 450
function meshHeightAt(x, z)
{
    const i = meshXs.findIndex(v => v > x) - 1, j = meshZs.findIndex(v => v > z) - 1;
    const u = (x-meshXs[i])/(meshXs[i+1]-meshXs[i]), w = (z-meshZs[j])/(meshZs[j+1]-meshZs[j]);
    const h00 = meshH[j][i], h10 = meshH[j][i+1], h01 = meshH[j+1][i], h11 = meshH[j+1][i+1];
    return h00 + (w > u ? u*(h11-h01) + w*(h01-h00) : u*(h10-h00) + w*(h11-h10));
}

// terrain: heightfield strips with per-vertex lit colours (smooth gouraud)
function pushTerrain()
{
    buildGrid();
    const xs = meshXs, zs = meshZs;
    const cols = xs.length-1, rows = zs.length-1;
    // corner grids: position, slope normal, surface colour
    const P = [], N = [], C = [];
    for (let j=0; j<=rows; ++j)
    {
        P[j] = []; N[j] = []; C[j] = [];
        for (let i=0; i<=cols; ++i)
        {
            const x = xs[i], z = zs[j];
            P[j][i] = vec3(x, meshH[j][i], z);
            const [gx, gz] = slopeAt(x, z, MESH_CELL/2);
            N[j][i] = vec3(-gx, 1, -gz).normalize();
            C[j][i] = groundColor(x, z);
        }
    }
    // Antialias surface boundaries: one box pass turns the 2yd sawtooth of
    // a green or bunker edge into a one-cell ramp. Water is skipped - its
    // 254/255 alpha is the wave marker, and averaging falls outside that
    // band, which is what `c.a == 1` tests.
    const C0 = C.map(r => r.slice());
    for (let j=13; j<rows-12; ++j)
    for (let i=13; i<cols-12; ++i)
    {
        const c = C0[j][i].add(C0[j-1][i]).add(C0[j+1][i]).add(C0[j][i-1]).add(C0[j][i+1]).scale(.2);
        if (c.a == 1) C[j][i] = c;
    }
    // Baked tree shadows, cast away from the sun but floored at
    // SHADOW_MIN_E so a low sun cannot smear them. Fine cells only: a dark
    // vertex on a coarse ring would streak 100yd.
    const sd = skyDir(SUN_A, Math.max(SUN_E, SHADOW_MIN_E)), sl = 1.2/sd.y;
    for (const t of H.trees)
    {
        if (t.k > 2) continue; // flowers are far too small to cast one
        const R = t.s*3;
        const sx = t.x - sd.x*t.s*sl, sz = t.z - sd.z*t.s*sl;
        const i0 = 12 + Math.max(0, (sx - R - xs[12])/MESH_CELL | 0);
        const j0 = 12 + Math.max(0, (sz - R - zs[12])/MESH_CELL | 0);
        for (let j=j0; j<=rows-12 && zs[j] < sz + R; ++j)
        for (let i=i0; i<=cols-12 && xs[i] < sx + R; ++i)
        {
            const d = Math.hypot(xs[i]-sx, zs[j]-sz);
            if (d < R) C[j][i] = C[j][i].scale(1 - .5*(1 - d/R), 1);
        }
    }
    // one triangle strip per row pair (winding: front faces up)
    for (let j=0; j<rows; ++j)
    {
        const pts = [], col = [];
        for (let i=0; i<=cols; ++i)
        {
            pts.push(P[j+1][i], P[j][i]);
            col.push(packColor(C[j+1][i], N[j+1][i]), packColor(C[j][i], N[j][i]));
        }
        glPushVerts(pts, col);
    }
}

///////////////////////////////////////////////////////////////////////////////
// low-poly props

// surface of revolution around the y axis at pos: profile = [[r, h], ...]
// rings, `sides` flat-shaded quads per ring pair (4 = the low-poly look).
// An octahedron is [[0,-r],[r,0],[0,r]]; a box trunk is [[w,0],[w*.7,h]].
// rot turns the whole lathe about the up axis (nothing is instanced here,
// so a per-prop heading is free geometry).
// rot is now a real rotation about Y rather than an offset added to the
// lathe angle - the two are identical (sin(a+rot) expands to exactly this),
// which frees it to double as the heading that `roll` tumbles across. roll
// turns the vertical and along-rot components together and the across one
// rides. Normals come from the transformed points, so the baked lighting
// tumbles with it for free - the only reason a plain white ball reads as
// rolling at all: its 32 facets span 113/255 of brightness.
function pushLathe(pos, profile, sides, color, rot=0, roll=0)
{
    const rc = Math.cos(roll), rs = Math.sin(roll);
    const dc = Math.cos(rot), ds = Math.sin(rot);
    const P = (r, h, a)=>
    {
        const x = Math.sin(a)*r, z = Math.cos(a)*r;
        const y = h*rc - z*rs, f = h*rs + z*rc;
        return vec3(pos.x + dc*x + ds*f, pos.y + y, pos.z + dc*f - ds*x);
    };
    for (let i=0; i+1<profile.length; ++i)
    for (let j=0; j<sides; ++j)
    {
        const [r0, h0] = profile[i], [r1, h1] = profile[i+1];
        const a0 = j/sides*2*Math.PI, a1 = (j+1)/sides*2*Math.PI;
        const p00 = P(r0,h0,a0), p01 = P(r0,h0,a1), p10 = P(r1,h1,a0), p11 = P(r1,h1,a1);
        // outward face normal = around x up (mid-edge vectors, so the
        // degenerate tip quads of a cone work too)
        const up = p11.add(p10).subtract(p01.add(p00));
        const around = p01.add(p11).subtract(p00.add(p10));
        glPushVerts([p00, p01, p10, p11], packColor(color, around.cross(up).normalize()));
    }
}

// t.k: 0 = full tree, 1 = far tree (one canopy), 2 = bush, 3 = wildflower
function pushTreeGL(t)
{
    const gh = meshHeightAt(t.x, t.z), pal = H.pal, s = t.s;
    // The hole's pal.flower plus a small jitter, so a meadow reads as one
    // species with variation - per-flower hues read as confetti. t.c is
    // already spent on that jitter, so the second-species roll takes an
    // uncorrelated slice of it (*7.3 %1).
    const leaf = t.k == 3 ? hslCol(pal.flower, t.c*30-9,
            t.c*44-22 + (t.c*7.3 % 1 < SECOND_MIX ? SECOND_HUE : 0))
        : hslCol(pal.tree, t.c*20-7, t.c*50-9);
    // A BUSH IS JUST A LOW TREE with no trunk - same canopy, same collision
    // sphere, one code path. TRUNK_H is the canopy centre and the only thing
    // that differs; course.js bakes the same number into t.y.
    const th = trunkH(t);
    // Every prop faces its own way. The POSITION is the random number, so
    // this costs no rand() draw - a new draw in genHole would re-roll every
    // hole's tree and bush layout, and bushes are in play.
    const rot = t.x*7 + t.z*5;
    // A five-sided CUP, not a gem: the faces splay outward like petals and
    // still read from this game's low camera, where a flat disc goes edge-on.
    // FIVE sides - an even count reads as a crystal.
    if (t.k == 3)
        return pushLathe(vec3(t.x, gh, t.z), [[0,0],[2*s,3*s]], 5, leaf, rot);
    // FOLIAGE SWAY rides the LEAF ALPHA, and only trees and bushes get it -
    // FLOWERS ARE TOO SMALL TO SWAY, so this sits below their early return
    // rather than beside the colour they share.
    // The vertex shader reads a colour in the (.9, .995) band as leaves,
    // offsets them by (a-.9)*3 yards of a two-wave rustle, then resets alpha
    // to 1 so they still draw opaque: the alpha is a channel carrying wind
    // strength, not a transparency, which is why setting it to a sensible
    // looking 1 silently switches the whole effect off.
    // Usable range is bytes 230..253. Below 230 falls outside the band and
    // never moves; 254 is the WATER marker and would put every leaf into the
    // wave shader. The calm floor packs to 234, wind 12 to 252.
    // The FLOOR was raised from .902 on 2026-08-31: at the old base a calm
    // hole's peak sway was .06yd on a 3yd canopy - frozen to the eye - and
    // Frank saw trees moving on some holes and not others. .92 gives calm
    // holes a visible idle (~.16yd peak) while wind 12 packs to the very
    // same byte as before, so the windy ceiling is untouched.
    // Also why H.wind must be set BEFORE buildWorld (see startHole): the
    // amplitude is baked into the vertex here and never read again.
    leaf.a = .92 + Math.min(H.wind.s/12, 1)*.07;
    if (t.k < 2) // box trunk (a stretched square prism)
        pushLathe(vec3(t.x, gh, t.z), [[s*.3, 0], [s*.22, th]], 4, hslCol(pal.trunk), rot);
    pushLathe(vec3(t.x, gh + th, t.z), [[0,-s*1.9],[s*1.7,0],[0,s*1.9]], 4, leaf, rot);
    if (t.k) return; // far tree / bush: one canopy is enough
    // the two side clumps ORBIT the trunk on that heading (they used to sit
    // at a fixed +x/-x, which is what made every tree the same shape from
    // the same angle) and each spins on its own multiple of it
    // ...and each rides its own HEIGHT and size off the same heading, so a
    // stand no longer reads as one silhouette repeated. dx and dz are already
    // sin and cos of rot, a quarter turn apart, so taking height from one and
    // size from the other costs no new trig and no rand() draw - and the
    // tree's x, z, s are untouched, so collision and the layout are too.
    for(let i=2;i--;)
    {
        const r = rot + i*rot*1e3;
        const dx = Math.sin(r)*s*.9, dz = Math.cos(r)*s*.9;
        const r1 = s + dz/4;
        pushLathe(vec3(t.x + dx, gh + s*3 + dz, t.z + dz), [[0,-r1],[r1,0],[0,r1]], 4, leaf, rot*3);
    }
}

function pushPinGL()
{
    // The cup is a flat disc and the drawn ground is a mesh chord, so on a
    // sloped green either can bury it (H17 clipped the whole hole). Stand
    // it on whichever surface is higher, then lift by slope x radius so
    // the uphill rim clears too - a couple of inches, only on a slope.
    const gh = Math.max(heightAt(H.pin.x, H.pin.z), meshHeightAt(H.pin.x, H.pin.z))
        + Math.hypot(...slopeAt(H.pin.x, H.pin.z))*HOLE_R;
    const p = vec3(H.pin.x, gh, H.pin.z);
    // distance-compensated pole width + flag size so the pin stays readable
    // from the tee (a true-width pole is sub-pixel at 300yd)
    // k = 0 when the pin is pulled: the pole and flag are both scaled by
    // it, so they collapse to degenerate geometry and no branch is needed.
    const k = clamp(Math.hypot(p.x-camX, p.z-camZ)*.012, 1, 4)*!pinOut;
    glEnableFog = 0; // the pin is always visible, like the aim ring
    // cup + pole + wind-vane flag (no face culling: one strip shows from any side)
    // drawn AT HOLE_R, so what you aim at is what the ball is tested against
    // A real flagstick is 7ft. The pole and flag scale together, so the pin
    // keeps exactly the shape it had and only stops being 1.7x life size.
    // (The FLAG is still proportionally about twice a real one - 20in on a
    // 7ft stick - if that ever wants correcting too.)
    pushLathe(vec3(p.x, p.y+.002, p.z), [[0,-.01],[HOLE_R,0],[0,.01]], 9, new Color(.1,.1,.1)); // 9-gon: a cup should read round
    pushLathe(p, [[.04*k, 0], [.04*k, POLE_H]], 4, new Color(.9,.9,.9));
    const len = Math.min(.6 + H.wind.s*.06, 1.2)*(1 + Math.sin(time*5)*.1)*k;
    const tip = vec3(p.x + Math.sin(H.wind.a)*len, p.y + POLE_H - .2*k + Math.sin(time*5)*.08,
        p.z + Math.cos(H.wind.a)*len);
    const a = vec3(p.x, p.y+POLE_H, p.z), b = vec3(p.x, p.y+POLE_H-.4*k, p.z);
    glPushVerts([a, tip, b], packColor(new Color(1,.2,.3), null));
    glEnableFog = 1;
}

function pushBallGL()
{
    const g = ballGround();
    const sink = clamp(1 - (g.h - ball.y)*2.2, 0, 1);
    if (!sink) return;
    // Never below the DRAWN ground. The ball sits at the analytic height,
    // but the mesh is a 4yd chord through it, so on a steep slope the
    // triangle can pass above the ball and swallow it - the same mismatch
    // that had trees floating. Lift ball and shadow onto the mesh.
    const mh = meshHeightAt(ball.x, ball.z);
    // TRUE SIZE, and no distance compensation any more: a real ball is
    // 1.68in and that is what gets drawn. It is about 1.4px at the 16yd
    // chase cam, so the cameras want pulling in - Frank's, after seeing it.
    const r = BALL_R*sink;
    pushSoftDisc(vec3(ball.x, Math.max(g.h, mh)+.003, ball.z), vec3(1), vec3(0,0,1), r*2, new Color(0,0,0,.5));
    // The ball is a LATHED SPHERE, 4 bands x 8 sides. It was [[0,-r],[r,0],
    // [0,r]] x 4 - an octahedron, which reads as a diamond once the putt cam
    // sits 5yd off it. Bands cost about twice what sides do here: 6 bands is
    // +20 against +13, for less than sides buy.
    const s = r*.7; // r*sin45
    // ROLL_K radians per yard travelled. Not the physical 1/radius - that is
    // 43 rad/yd on a real ball and strobes into nonsense at 60fps. This is
    // picked to read on the putt cam: about half a turn per yard, so a 5yd
    // putt turns 2.4 times. Frank's knob.
    pushLathe(vec3(ball.x, Math.max(ball.y, mh)+r, ball.z),
        [[0,-r],[s,-s],[r,0],[s,s],[0,r]], 8, WHITE, ballDir, ballRoll);
}

// putting aid: downhill arrows lying ON the green surface (z-buffered,
// exactly mapped - no screen-space projection involved). Length and color
// scale with steepness; flat spots draw nothing, which reads as flat.
function pushPuttAidGL()
{
    const gr = H.gr;
    if (SLOPE_ARROWS)
    for (let wx = Math.floor((H.green.x-gr)/2)*2; wx <= H.green.x+gr; wx += 2)
    for (let wz = Math.floor((H.green.z-gr)/2)*2; wz <= H.green.z+gr; wz += 2)
    {
        if (Math.hypot(wx-H.green.x, wz-H.green.z) > gr-1)
            continue;
        const h = heightAt(wx, wz);
        const [gx, gz] = slopeAt(wx, wz);
        const slope = Math.hypot(gx, gz);
        if (slope < .01)
            continue;
        const dx = -gx/slope, dz = -gz/slope;      // downhill direction
        const len = clamp(slope*24, .7, 2);
        const k = Math.min(slope*9, 1);            // steepness 0..1
        const px = -dz*.1, pz = dx*.1;           // shaft half-width
        const x2 = wx + dx*len, z2 = wz + dz*len;  // arrow tip
        const mx = wx + dx*len/2, mz = wz + dz*len/2; // head base
        const hm = heightAt(mx, mz), h2 = heightAt(x2, z2);
        const col = new Color(1, 1-k*.5, 1-k*.8, .8); // white -> hot as steeper
        // explicit shaft + arrowhead so the downhill direction is unambiguous
        glPushVerts([
            vec3(wx+px, h+.1, wz+pz), vec3(wx-px, h+.1, wz-pz),
            vec3(mx+px, hm+.1, mz+pz), vec3(mx-px, hm+.1, mz-pz)], packColor(col, null));
        glPushVerts([
            vec3(mx+px*3, hm+.1, mz+pz*3), vec3(mx-px*3, hm+.1, mz-pz*3),
            vec3(x2, h2+.1, z2)], packColor(col, null));
    }

    // The line the putt would ACTUALLY take, rolled with the real physics at
    // CUP pace. Only the first PUTT_LINE yards: enough to feel the break
    // starting, without a full path cluttering the green.
    const b = puttVel({x: ball.x, y: ball.y, z: ball.z}, ballToPin(), aimYaw);
    const col = new Color(1,1,1,.8);
    rollRest = 0;
    for (let i = 0, run = 0; i < 120 && !rollRest && run < PUTT_LINE; ++i)
    {
        const x0 = b.x, y0 = b.y, z0 = b.z;
        // a dash ends at PUTT_DASH steps OR the length cap, whichever first
        for(let j = PUTT_DASH; j-- && Math.hypot(b.x-x0, b.z-z0) < PUTT_MAXDASH;)
            rollStep(b);
        if (i & 1)
            continue;   // every other segment left out, so the line dashes
        const dx = b.x-x0, dz = b.z-z0, d = Math.hypot(dx, dz) || 1;
        run += d;
        const px = -dz/d*PUTT_W, pz = dx/d*PUTT_W;
        glPushVerts([vec3(x0+px, y0+.1, z0+pz), vec3(x0-px, y0+.1, z0-pz),
                     vec3(b.x+px, b.y+.1, b.z+pz), vec3(b.x-px, b.y+.1, b.z-pz)], packColor(col, null));
    }
}

// aim aid: rainbow ring on the terrain at the predicted landing point,
// z-buffered (hills occlude it), fog-exempt so it stays vivid far downrange
function pushLandingRingGL()
{
    // distance-compensated size so the ring stays readable at range
    // (much smaller floors for putts - the cam is close and greens are small)
    const k = clubI == CLUB_PUTTER ? .3 : 1;
    const d = Math.hypot(predLand.x-camX, predLand.z-camZ);
    const r = Math.max(3*k, d*.03), n = 20, w = Math.max(.4*k, d*.01);
    const gh = heightAt(predLand.x, predLand.z);
    glEnableFog = 0;
    for (let i=0; i<n; ++i)
    {
        const col = hsl(i/n + time/4, 1, .6); // (hsl wraps the hue)
        const pts = [];
        for (let k=0; k<2; ++k)
        {
            const a = (i + k*.8)/n*2*Math.PI;
            const dx = Math.sin(a), dz = Math.cos(a);
            for (const rr of [r-w, r+w])
            {
                const x = predLand.x + dx*rr, z = predLand.z + dz*rr;
                pts.push(vec3(x, heightAt(x, z)+.15, z));
            }
        }
        glPushVerts(pts, packColor(col, null));
    }
    // slim pulsing beacon so the spot reads even at grazing angles
    const bh = Math.max(2*k, d*.03)*(1 + Math.sin(time*4)*.1);
    const br = Math.max(.4*k, d*.006);
    pushLathe(vec3(predLand.x, gh+bh, predLand.z), [[0,-bh],[br,0],[0,bh]], 4,
        hsl(time/4, 1, .6));
    glEnableFog = 1;
}

// The predicted flight as a camera-facing ribbon, ball to landing. Debug
// only. Fades along its length so the far end does not compete with the ring.
function pushPredGL()
{
    const n = predPath.length;
    if (n < 2) return;
    const rx = Math.cos(camYaw), rz = -Math.sin(camYaw);
    const pts = [], cols = [];
    for (let i=0; i<n; ++i)
    {
        const s = predPath[i];
        const d = Math.hypot(s.x-camX, s.z-camZ);
        const w = Math.max(.15, d*.004);
        const c = packColor(hsl(.5, .8, .7, .55 - i/n*.35));
        pts.push(vec3(s.x-rx*w, s.y, s.z-rz*w), vec3(s.x+rx*w, s.y, s.z+rz*w));
        cols.push(c, c);
    }
    glEnableFog = 0;
    glPushVerts(pts, cols);
    glEnableFog = 1;
}

function pushTrailGL()
{
    const n = trail.length;
    if (n < 2) return;
    const rx = Math.cos(camYaw), rz = -Math.sin(camYaw); // camera right
    const pts = [], cols = [];
    for (let i=0; i<n; ++i)
    {
        const s = trail[i];
        const age = (time - s.t)/TRAIL_LIFE;        // 0 fresh .. 1 expiring
        const d = Math.hypot(s.x-camX, s.z-camZ);
        const w = Math.max(.1, d*.003)*(1 - age);
        const c = packColor(niceShot ? hsl((i + trailTotal)*.04, 1, .6, (1-age)*.8)
                                     : new Color(1, 1, 1, (1-age)/2));
        pts.push(vec3(s.x-rx*w, s.y+.1, s.z-rz*w), vec3(s.x+rx*w, s.y+.1, s.z+rz*w));
        cols.push(c, c);
    }
    glEnableFog = 0;
    glPushVerts(pts, cols);
    glEnableFog = 1;
}

///////////////////////////////////////////////////////////////////////////////
// Sky: camera-relative geometry at SKY_R, fog-exempt and unlit. Soft edges
// come from per-vertex alpha ramping to 0, no textures. Depth writes off, so
// the layers only ever blend over each other.

// soft disc "sprite": concentric rings with a bell-shaped alpha falloff in
// the plane spanned by u, w (unit vectors) around c - a gradient dot with
// no visible polygon edge. Sun, clouds and the ball shadow all use it.
const DISC_A = [1, .9, .7, 0]; // alpha profile, centre to rim
function pushSoftDisc(c, u, w, r, color)
{
    const pt = (k, i)=>
    {
        const a = i/16*2*Math.PI, s = r*k/4;
        return c.add(u.scale(Math.cos(a)*s)).add(w.scale(Math.sin(a)*s));
    };
    for (let k=0; k<3; ++k)
    {
        const pts = [], cols = [];
        const c0 = packColor(color.scale(1, DISC_A[k])), c1 = packColor(color.scale(1, DISC_A[k+1]));
        for (let i=0; i<17; ++i)
        {
            pts.push(pt(k, i), pt(k+1, i));
            cols.push(c0, c1);
        }
        glPushVerts(pts, cols);
    }
}

// sun heading/elevation (rad): a low sun left of the hole
const SKY_R = 5e3;
// Floor under the elevation the BAKED SHADOWS are cast from (the drawn sun
// and the shading light still go all the way down). The bake is a round
// darkened patch offset from the trunk, so a very low angle turns it into a
// smear instead of a shadow. .5 rad about 30 deg.
const SHADOW_MIN_E = .5;
// how many yards of the simulated putt path to draw
// The putt preview line. LENGTH in yards, HALF-WIDTH in yards, physics
// steps per dash, and the MAX LENGTH of one dash (or gap) in yards.
// A dash is PUTT_DASH steps of real roll, so its length reads as SPEED -
// dashes shrink as the ball dies, which is the design. The CAP is what
// keeps that honest off the green (Frank, 2026-08-31): a putt from the
// fairway launches at pin-distance pace, ~25yd/s from the tee, and one
// 9-step dash covered 3.75 of the 5 preview yards - the whole line drew
// as ONE dash, a solid stripe. Capped, a fast preview breaks into
// .6yd dashes and the slow end still tapers.
const PUTT_LINE = 5, PUTT_W = .1, PUTT_DASH = 9, PUTT_MAXDASH = .6;
// Downhill arrows over the whole green. The simulated putt line shows the
// break directly now, so these are the older and cruder version of the same
// reading; 0 drops them from the build entirely (Closure folds the flag).
const SLOPE_ARROWS = 0;
const skyDir = (a, e)=> vec3(Math.sin(a)*Math.cos(e), Math.sin(e), Math.cos(a)*Math.cos(e));
// Soft disc on the sky sphere, angular radius ang. squish < 1 flattens it
// and rot spins that ellipse - a thin ellipse is a two-armed bar, so several
// at an offset make the sun's star. Rotate the basis BEFORE the squish, or
// the arm does not point where rot says.
function pushSkyDisc(v, ang, color, squish=1, rot=0)
{
    const u = vec3(0,1).cross(v).normalize(), w = v.cross(u);
    const c = Math.cos(rot), s = Math.sin(rot);
    pushSoftDisc(vec3(camX + v.x*SKY_R, camY + v.y*SKY_R, camZ + v.z*SKY_R),
        u.scale(c).add(w.scale(s)), w.scale(c).subtract(u.scale(s)).scale(squish), ang*SKY_R, color);
}

// The sky gradient: a band around the camera from the horizon up, haze to
// sky0, capped by a cone to the zenith. Below the horizon is the clear
// colour. Camera-relative, so the horizon comes out of the PROJECTION.
function pushSkyBackGL()
{
    const pts = [], cols = [], cap = [], haze = packColor(glFogColor),
        hi = packColor(hslCol(H.pal.sky0));
    for (let i=13; i--;)
    {
        // .524 = 2PI/12: i/2 left a 16-degree wedge of the circle unfilled
        const a = i*Math.PI/6, x = camX + Math.sin(a)*SKY_R, z = camZ + Math.cos(a)*SKY_R;
        pts.push(vec3(x, camY, z), vec3(x, camY + SKY_R, z));
        cols.push(haze, hi);
        // and a cone from the band's rim to a point overhead, so the sky is
        // closed all the way to the zenith. Flat sky0, built by hand rather
        // than with pushLathe because that lights every face with a normal.
        cap.push(vec3(x, camY + SKY_R, z), vec3(camX, camY + SKY_R*2, camZ));
    }
    glPushVerts(pts, cols);
    glPushVerts(cap, hi);
}

function pushSkyGL()
{
    glEnableFog = 0;
    pushSkyBackGL();
    const sun = skyDir(SUN_A, SUN_E), sunCol = hslCol(H.pal.sun);
    // SUN STAR ARMS: three thin squished discs, each turned 60 degrees on
    // from the last, so the sun throws six rays. Drawn first, so the solid
    // disc and its halos sit on top of where the arms meet.
    // KNOBS:  the .8 length, the .1 thinness, the
    // alpha, and the count/spacing in the loop below.
    for (let i=6; i--;)
        pushSkyDisc(sun, 1, sunCol.scale(1, .2), .05, i*Math.PI/6);
    // sun: soft disc + wide faint halo
    pushSkyDisc(sun, .1, sunCol);
    pushSkyDisc(sun, .2, sunCol.scale(1, .7));
    pushSkyDisc(sun, .3, sunCol.scale(1, .5));
    // clouds: rows of overlapping soft puffs parked at headings, drifting
    for (let i=7; i--;)
    for (let j=5+i%3; j--;)
        pushSkyDisc(skyDir(i + time*.02 + j*.1, .3 + (i%3)*.2 + Math.sin(j*j+i+time*.02)*.04),
            .2 + Math.sin(j**3)*.05, new Color(1, 1, 1, .7), .5); // .5 = squished flat
    glEnableFog = 1;
}

// Lens flare: ghosts strung from the sun through the screen centre. A
// direction lerped between the sun and camera forward lies on their great
// circle, which projects to exactly that line - so each ghost is one sky
// disc and no screen-space math is needed. FLARE = 0 deletes it.
const FLARE = 1;
function pushFlareGL()
{
    const sun = skyDir(SUN_A, SUN_E), cp = Math.cos(camPitch);
    const fwd = vec3(Math.sin(camYaw)*cp, -Math.sin(camPitch), Math.cos(camYaw)*cp);
    const k = clamp((fwd.x*sun.x + fwd.y*sun.y + fwd.z*sun.z - .5));
    if (!k) return;

    glEnableFog = 0;
    for(let i=9; --i;)
    {
        const t = i/16, s = .05 - Math.sin(i**5)*.04, h = i**2.3;
        pushSkyDisc(sun.scale(1-t).add(fwd.scale(t)).normalize(), s, hsl(h, .9, .6, k));
    }
    glEnableFog = 1;
}

// debug (C key): the tree collision volumes flyStep tests - canopy sphere
// (red) and trunk cylinder (yellow), translucent, drawn through the trees.
// Dev/artifact only: 0 release bytes.
let showColl = 0;
function pushCollGL()
{
    for (const t of H.near)
    {
        // t.y IS the canopy centre now (course.js bakes trunkH into it), so
        // the sphere sits AT t.y and the trunk column runs from the ground UP
        // to it. Drawing either relative to the ground double-counted the
        // trunk and floated both volumes.
        const s = t.s, r = s*TRUNK_R, th = trunkH(t);
        pushLathe(vec3(t.x, t.y, t.z), [[0,-s],[s*.7,-s*.7],[s,0],[s*.7,s*.7],[0,s]], 8, new Color(1,0,0,.35));
        // flyStep's trunk test is `dy < 0` - unbounded downward - so the
        // column is drawn over the part that can actually be reached
        pushLathe(vec3(t.x, t.y - th, t.z), [[r,0],[r,th]], 8, new Color(1,1,0,.4));
    }
    // the pin post's strike volume (cyan): POST_R wide, cup up to POLE_H,
    // exactly the window ballUpdate tests. It was missing here and Frank
    // asked why the view showed trees but not the pole.
    const g = heightAt(H.pin.x, H.pin.z);
    pushLathe(vec3(H.pin.x, g, H.pin.z), [[POST_R, 0], [POST_R, POLE_H]], 8, new Color(0,1,1,.4));
}

// Drop trees close to the ball: H.near is BOTH the drawn set and the
// collision set, so what you see is what you hit. Called once per shot from
// enterAim - re-baking on every aim change was 8ms and read as jitter.
const HIDE_R = 18;
function hideTrees()
{
    H.near = H.trees.filter(t => !(t.k & 1) && Math.hypot(t.x-ball.x, t.z-ball.z) > HIDE_R);
    if (!glContext) return; // headless (sim/unit): the filter is all that matters
    bakeNear();
}

///////////////////////////////////////////////////////////////////////////////

// full 3D scene: the static world in one call, the sky, then the dynamic batch
function renderViewGL()
{
    glPreRender();
    glSetBuffer(glStaticBuffer);
    glContext.drawArrays(gl_TRIANGLE_STRIP, 0, glStaticCount);
    glContext.depthMask(0); // sky: tested against the world, never occludes itself (the sun/clouds only blend)
    pushSkyGL();
    glRender();
    glContext.depthMask(1);
    pushPinGL();
    pushBallGL();
    pushTrailGL();
    if (debug && showColl)
    {
        // through everything: the sphere sits INSIDE the opaque canopy
        glRender();
        glContext.disable(gl_DEPTH_TEST);
        pushCollGL();
        glRender();
        glContext.enable(gl_DEPTH_TEST);
    }
    if (state == ST_AIM || state == ST_SWING)
    {
        clubI == CLUB_PUTTER ? pushPuttAidGL() : pushLandingRingGL();
        debug && PRED_ARC && clubI != CLUB_PUTTER && pushPredGL();
    }
    glRender();
    if (FLARE)
    {
        // additive, alpha untouched (ZERO, ONE): the ghosts add onto the
        // world and, through the compositor, onto the 2D sky too
        glContext.disable(gl_DEPTH_TEST);
        glContext.blendFuncSeparate(gl_ONE, gl_ONE, 0, gl_ONE);
        pushFlareGL();
        glRender();
        glContext.blendFunc(gl_ONE, gl_ONE_MINUS_SRC_ALPHA);
        glContext.enable(gl_DEPTH_TEST);
    }
}
