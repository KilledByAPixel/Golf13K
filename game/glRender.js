'use strict';

/*  SUNSHINE GOLF CLASSIC - WebGL renderer
    Ported from the Dr1v3n Wild (Drive13K) rendering engine: batched
    triangle strips, vertex colors, fog, z-buffer. Terrain is a heightfield
    mesh (smooth gouraud), props are flat-shaded lathes (octahedra, boxes).
    Lighting is BAKED at push time - the sun is fixed per hole - so a vertex
    is 20 bytes (xyz, fog-exempt flag, lit RGBA8) and the shader only fogs.
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
// Set per hole in buildWorld, which runs before anything is pushed; the
// headless unit harness supplies its own glLightDir, never building a world.
let SUN_E = .5, SUN_A = -.5, glLightDir;
///////////////////////////////////////////////////////////////////////////////
// THE WATER: a vertex-shader snippet spliced into the terrain shader.
// Lakes are marked by an alpha of 254/255, a band no other geometry uses.
// Keep a wave several times longer than the 2yd mesh cell or it aliases.
const PRISM = 1;    // 1 = rainbow foam instead of white (+18 bytes)
const SPARKLE = 0;  // twinkling glints on the water (Closure folds the 0 out)
const SPEC = 1;     // sun specular on the water - the only camera-aware light

// A second species of wildflower: this fraction take a big hue offset from
// the hole's pal.flower instead of the small jitter. SECOND_MIX = 0 removes
// it; 150 degrees is near-complementary, 30-60 a shade of the same family.
const SECOND_MIX = .1, SECOND_HUE = 90;
const WATER_GLSL =
// THE WAVES TRAVEL WITH THE WIND: positions project into the wind frame, U
// along u.xy (the wind direction), V across it. The MAIN wave rides the wind
// axis toward +U, the way the arrow points; B is the SMALL wave on the CROSS
// axis, and it warps the main wave's phase (+B*.9) so crests bunch and
// stretch. A very long still sine is an AMPLITUDE FIELD of calm and choppy
// stretches. u.z is the water CLOCK: time pre-scaled by wind strength on the
// CPU (glPreRender), so a windy hole chops faster and a calm one idles.
// KNOBS: .33 main wavelength, .28 cross wavelength, B's .6 in w = the cross
// wave's height share, .9 = the warp.
     'float U=v.x*u.x+v.z*u.y,'          // yards along the wind
    +'V=v.x*u.y-v.z*u.x,'                // yards across it
    +'b=u.z*.3+V*.28,B=sin(b),'          // the small CROSS wave, slow
    +'a=u.z-U*.33+B*.9,'                 // the MAIN wave, warped by B
    +'w=(sin(a)+B*.6)'               // surface height: main-dominant
    +'*(.6+.4*sin(v.x*.04+v.z*.03));'    // calm/choppy patches (still, world-anchored)
    +'v.y+=w*.4;'                      // WAVE HEIGHT, yards
    // THE SURFACE GRADIENT as an (x,z) vector: main wave along the wind (P),
    // cross wave across it (Q), each cos (the derivative) x amplitude.
    +'vec2 P=vec2(u.x,u.y),Q=vec2(u.y,-u.x),'
    +'G=P*-.33*cos(a)*1.2+Q*.28*cos(b)*.6;'
    // Shading MUST project the gradient onto the LIGHT, or the same face of
    // every wave brightens whatever SUN_A is. Vertex lighting is baked at
    // push time, so displacing the surface cannot otherwise re-light it.
    +'d.rgb*=1.-dot(G,l.xz)*.6;'
    // Specular: the one term that depends on where the camera stands. Broad
    // exponent on purpose - per-VERTEX on a 2yd mesh, a tight highlight would
    // pop between vertices. KNOBS: 12. (higher = tighter), .5 (brightness).
    +(SPEC ? 'd.rgb+=pow(max(dot(reflect(-l,normalize(vec3(-G.x,1,-G.y))),'
        +'normalize(e-v)),0.),12.)*.5;' : '')
    // Foam must lead with ONE wave: thresholding the SUM lights only where
    // both peak, isolated points rather than a line. The main wave alone
    // clears the threshold; the cross wave (.12) only wobbles the edge.
    +'d.rgb+=max(sin(a)+B*.12-.6,0.)*.55'
    +(PRISM ? '*(1.+.6*cos(w*9.+vec3(0,2,4)))' : '')+';'
    // Sparkle: each water vertex twinkles on its own hashed clock, so glints
    // pop at random; max(cos(a),0.) clusters them on the face tilted toward
    // the light. KNOBS: .8 (raise for fewer), 100. (higher = briefer),
    // 5. (rate), .7 (brightness).
    +(SPARKLE ?
     'float h=fract(sin(v.x*127.1+v.z*311.7)*43758.5);'
    +'d.rgb+=step(.8,h)*pow(max(sin(h*63.+t*5.),0.),100.)*max(cos(a),0.)*.7;' : '');
const glLightColor = [.65, .65, .6], glAmbient = [.5, .5, .55];


// called by engine.js during engineInit, before the overlay canvas is
// appended - so the layering lands glCanvas < overlayCanvas
function glInit(rootElement)
{
    rootElement.appendChild(glCanvas = document.createElement('canvas'));
    // premultiplied alpha (the canvas default): the fragment shader multiplies
    // rgb by alpha and the blend is ONE/ONE_MINUS_SRC_ALPHA, so the fog fade
    // composites correctly and the additive flare batch adds straight on
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
        // alpha-fade at the far edge into the clear colour
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

    // Depth row 1,2 is the INFINITE far plane (the limit of (n+f)/range and
    // 2nf/range as f goes to infinity); the near clip stays at 1/3yd.
    const fl = 2.1, D = 57.3; // 180/Math.PI;
    const proj = new DOMMatrix([
        fl*glCanvas.height/glCanvas.width, 0, 0, 0,
        0, fl, 0, 0,
        0, 0, 1, 2,
        0, 0, -1, 0
    ]);
    // camera pose: pitch about x, yaw about y, then the eye offset. DOMMatrix
    // rotates counter-clockwise in degrees, LittleJS angles are clockwise
    // radians, hence the negated degrees.
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
    // the calm floor (wind.s is never zero) to 1 at the ceiling of 8.
    glContext.uniform3f(glUniform('u'), Math.sin(hole.wind.a), Math.cos(hole.wind.a), time*(.6 + hole.wind.s*.05));
    // Cleared to the HAZE: what shows below the horizon wherever the terrain
    // does not reach, so it must match the fog - the terrain does NOT always
    // rise above the horizon. The high sky is covered by geometry.
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

// capped triangle strip; colors = one packed color or one per point.
// The .length test is not tidiness: `colors[i] ?? colors` INDEXES A NUMBER
// whenever a strip has one packed colour (most of them), and a keyed read on
// a primitive takes V8's generic path - ten times slower over a tree bake.
function glPushVerts(points, colors)
{
    const n = points.length, c = (i)=> colors.length ? colors[i] : colors;
    if (glBase && n+2 >= gl_MAX_BATCH - glBatchCount) // (the static build never flushes)
        glRender();
    glPushVert(points[0], c(0));
    for (let i=0; i<n; ++i)
        glPushVert(points[i], c(i));
    glPushVert(points[n-1], c(n-1));
}

// gl constants as ints (minify-friendly, from Drive13K)
// gl_STATIC_MAX IS A REAL CEILING: the world build ASSERTs against it and
// the release strips that assert, so an overrun would silently eat into the
// dynamic batch behind it and drop geometry with no warning. The classic 18
// peaks near 452k verts and sampled REMIX courses near 474k, with a million
// seeds unsampled - anything that adds static geometry must be measured
// against remix seeds. 7e5 is 4MB more of Float32Array and no bigger in the
// zip than 5e5.
const
gl_TRIANGLE_STRIP = 5, gl_DEPTH_BUFFER_BIT = 256, gl_ONE = 1,
gl_ONE_MINUS_SRC_ALPHA = 771, gl_DEPTH_TEST = 2929, gl_BLEND = 3042,
gl_UNSIGNED_BYTE = 5121, gl_FLOAT = 5126, gl_COLOR_BUFFER_BIT = 16384,
gl_ARRAY_BUFFER = 34962, gl_STATIC_DRAW = 35044, gl_DYNAMIC_DRAW = 35048,
gl_FRAGMENT_SHADER = 35632, gl_VERTEX_SHADER = 35633,
gl_COMPILE_STATUS = 35713, gl_LINK_STATUS = 35714,
gl_MAX_BATCH = 3e4, gl_STATIC_MAX = 7e5, gl_INDICIES_PER_VERT = 5, gl_VERTEX_BYTE_STRIDE = 20;

///////////////////////////////////////////////////////////////////////////////
// static world: everything that never moves (terrain, trees) is pushed once
// per hole into its own GPU buffer and drawn with a single call.

// the static stream is [terrain | far trees + bushes | NEAR TREES]: hideTrees
// re-bakes just the tail, without the trees standing over the ball. Terrain
// goes first because it is most of the cost of a full rebake.
let nearStart = 0;
function buildWorld()
{
    glBase = glBatchCount = 0;
    // Hole 1 is late morning, hole 18 nearly down (43 deg -> 11), and the
    // heading is scattered per hole with sin() of the index - no rand()
    // draw, since genHole's stream must not move. Both stay in frame from
    // the tee, which is what the flare needs.
    glLightDir = skyDir(SUN_A = Math.sin(hole.index*2.4+1),
        SUN_E = lerp(.75, .2, hole.index/17));
    if (debug && DEV_THUMBNAIL) // debug-gated or the 1 FOLDS INTO RELEASE
        SUN_E = .5;
    pushTerrain();
    for (const t of hole.trees)
        if (t.k & 1) pushTreeGL(t); // the ODD kinds: far forest + flowers,
        // i.e. everything hole.near (the even kinds) does not carry
    nearStart = glBatchCount;
    bakeNear();
}

// the tail of the static stream: the near trees from nearStart, then the
// whole world goes up to the GPU (one call either way) and the dynamic batch
// moves in behind it.
function bakeNear()
{
    glBase = 0; glBatchCount = nearStart;
    for (const t of hole.near)
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
    // the coarse ring starts at 4yd whatever MESH_CELL is: tying it to the
    // cell size would shrink the world's reach with it (315yd instead of 630
    // at 2yd cells), dropping the outer forest off the grid - NaN in meshHeightAt
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
    for (const p of hole.path) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); }
    for (const w of hole.waters) { minX = Math.min(minX, w.x-w.rx); maxX = Math.max(maxX, w.x+w.rx); }
    meshXs = gridAxis(minX - 80, maxX + 80);
    meshZs = gridAxis(-40, hole.len + 60);
    // meshH is filled by pushTerrain's corner loop, off the SAME groundAt
    // call that feeds groundColor - do not sample it here as well
    meshH = [];
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
    // ONE groundAt per vertex, feeding the height, the mesh grid and the
    // colour - terrain sampling is nearly all of the world build's cost.
    for (let j=0; j<=rows; ++j)
    {
        P[j] = []; N[j] = []; C[j] = []; meshH[j] = [];
        for (let i=0; i<=cols; ++i)
        {
            const x = xs[i], z = zs[j];
            const [gx, gz] = slopeAt(x, z, MESH_CELL/2);
            N[j][i] = vec3(-gx, 1, -gz).normalize();
            // groundAt and groundColor must stay ADJACENT and last: the
            // colour reads the lastAlong/lastDist that groundAt leaves
            // behind, and slopeAt's four heightAt calls each re-run
            // distToPath at an OFFSET point. slopeAt between them breaks
            // no test and shifts every mow stripe by half a cell.
            const g = groundAt(x, z);
            P[j][i] = vec3(x, meshH[j][i] = g.h, z);
            C[j][i] = groundColor(x, z, g);
        }
    }
    // Antialias surface boundaries: one box pass turns the 2yd sawtooth of a
    // green or bunker edge into a one-cell ramp. Water is skipped - its 254/255
    // alpha is the wave marker, and an average falls outside that band (`c.a == 1`).
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
    for (const t of hole.trees)
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

// Surface of revolution about the y axis at pos: profile = [[r, h], ...]
// rings, `sides` flat-shaded quads per ring pair (4 = the low-poly look).
// An octahedron is [[0,-r],[r,0],[0,r]]; a box trunk is [[w,0],[w*.7,h]].
// rot is a heading about Y, roll TUMBLES across it; normals come from the
// transformed points, so the baked lighting tumbles with the shape.
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
    const gh = meshHeightAt(t.x, t.z), pal = hole.pal, s = t.s;
    // pal.flower plus a small jitter, so a meadow reads as one species with
    // variation (per-flower hues read as confetti). t.c is spent on that
    // jitter, so the second-species roll takes an uncorrelated slice (*7.3 %1).
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
    // A five-sided CUP: the faces splay like petals and still read from the
    // low camera, where a flat disc goes edge-on; an even count reads as a crystal.
    if (t.k == 3)
        return pushLathe(vec3(t.x, gh, t.z), [[0,0],[2*s,3*s]], 5, leaf, rot);
    // FOLIAGE SWAY RIDES THE LEAF ALPHA. The vertex shader reads a colour in
    // the (.9, .995) band as leaves, offsets them by (a-.9)*3 yards of a
    // two-wave rustle, then resets alpha to 1 so they still draw opaque. So
    // alpha here is a CHANNEL CARRYING WIND STRENGTH, not a transparency -
    // a sensible-looking 1 silently switches the effect off. Usable range is
    // bytes 230..253: below 230 never moves, and 254 is the WATER marker,
    // which would put every leaf through the wave shader. .92 packs to 234
    // (a calm hole's visible idle, ~.16yd); the top of the wind packs to 252.
    // THE 8 IS THE TOP OF course.js's WIND RANGE (1 + MAXWIND) and the two
    // must move together. Trees and bushes only - flowers are too small to
    // sway. hole.wind must be set BEFORE buildWorld: the amplitude is baked
    // into the vertex here.
    leaf.a = .92 + hole.wind.s/8*.07;
    if (t.k < 2) // box trunk (a stretched square prism)
        pushLathe(vec3(t.x, gh, t.z), [[s*.3, 0], [s*.22, th]], 4, hslCol(pal.trunk), rot);
    pushLathe(vec3(t.x, gh + th, t.z), [[0,-s*1.9],[s*1.7,0],[0,s*1.9]], 4, leaf, rot);
    if (t.k) return; // far tree / bush: one canopy is enough
    // the two side clumps ORBIT the trunk on its heading, each spinning on
    // its own multiple of it, and take HEIGHT and size off the same heading
    // (dx, dz are sin and cos of rot, a quarter turn apart) so a stand does
    // not read as one silhouette repeated - no new trig, no rand() draw, and
    // x, z, s untouched so collision and the layout are too.
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
    // sloped green either can bury it. Stand it on whichever surface is
    // higher, then lift by slope x radius so the uphill rim clears too.
    const gh = Math.max(heightAt(hole.pin.x, hole.pin.z), meshHeightAt(hole.pin.x, hole.pin.z))
        + Math.hypot(...slopeAt(hole.pin.x, hole.pin.z))*HOLE_R;
    const p = vec3(hole.pin.x, gh, hole.pin.z);
    // distance-compensated pole width + flag size so the pin stays readable
    // from the tee (a true-width pole is sub-pixel at 300yd). k = 0 when the
    // pin is pulled: pole and flag collapse to degenerate geometry, no branch.
    const k = clamp(Math.hypot(p.x-camX, p.z-camZ)*.012, 1, 4)*!pinOut;
    glEnableFog = 0; // the pin is always visible, like the aim ring
    // cup + pole + wind-vane flag (no face culling: one strip shows from any
    // side), drawn AT HOLE_R so what you aim at is what the ball is tested
    // against. POLE_H is a real 7ft flagstick; pole and flag scale together.
    pushLathe(vec3(p.x, p.y+.002, p.z), [[0,-.01],[HOLE_R,0],[0,.01]], 9, new Color(.1,.1,.1)); // 9-gon: a cup should read round
    pushLathe(p, [[.04*k, 0], [.04*k, POLE_H]], 4, new Color(.9,.9,.9));
    const len = Math.min(.6 + hole.wind.s*.06, 1.2)*(1 + Math.sin(time*5)*.1)*k;
    const tip = vec3(p.x + Math.sin(hole.wind.a)*len, p.y + POLE_H - .2*k + Math.sin(time*5)*.08,
        p.z + Math.cos(hole.wind.a)*len);
    const a = vec3(p.x, p.y+POLE_H, p.z), b = vec3(p.x, p.y+POLE_H-.4*k, p.z);
    glPushVerts([a, tip, b], packColor(new Color(1,.2,.3), null));
    glEnableFog = 1;
}

function pushBallGL()
{
    const g = ballGround();
    const sink = clamp(1 - (g.h - ball.y)*2.2, 0, 1);
    if (!sink) return;
    // Never below the DRAWN ground: the ball sits at the analytic height, but
    // the mesh is a chord through it, so on a steep slope the triangle can
    // pass above the ball and swallow it. Lift ball and shadow onto the mesh.
    const mh = meshHeightAt(ball.x, ball.z);
    // TRUE SIZE, no distance compensation: a real 1.68in ball, about 1.4px
    // at the 16yd chase cam.
    const r = BALL_R*sink;
    pushSoftDisc(vec3(ball.x, Math.max(g.h, mh)+.003, ball.z), vec3(1), vec3(0,0,1), r*2, new Color(0,0,0,.5));
    // The ball is a LATHED SPHERE, 4 bands x 8 sides: an octahedron reads as
    // a diamond once the putt cam sits 5yd off it. Bands cost about twice
    // the bytes sides do.
    const s = r*.7; // r*sin45
    // ballRoll advances ROLL_K (golfSim.js) radians per yard travelled. Not
    // the physical 1/radius - 43 rad/yd on a real ball strobes into nonsense
    // at 60fps - but about half a turn per yard, which reads on the putt cam.
    pushLathe(vec3(ball.x, Math.max(ball.y, mh)+r, ball.z),
        [[0,-r],[s,-s],[r,0],[s,s],[0,r]], 8, WHITE, ballDir, ballRoll);
}

// The landing spot as a SLOPE GRID instead of a ring: a chevron at every grid
// point, RED where the ground stands above the centre, BLUE below, white at
// the centre's height, POINTING DOWNHILL off slopeAt - the only thing in the
// game that shows which way a ball will run. A DISC so it reads as a spot.
// Unlike the ring it draws for PUTTS too (Everybody's Golf's arrow field,
// EA's contour grid, PGA 2K's slope colours).
// DEBUG ONLY, the G key: `debug` is a const 0 in the release, so the call
// folds out and Closure drops the function, as with showColl. To ship it,
// swap the pushLandingRingGL() call in renderViewGL (about +91 bytes).
// THE COLOUR SCALE AUTO-RANGES: over the 18 greens the relief across this
// disc has a median of .11yd and a median MAXIMUM of .71, so a fixed scale
// washes a green out white, while a full shot's landing point on open ground
// has relief many times larger. GRID_FLOOR stops the auto-range turning a
// dead-flat green into a rainbow of noise: nothing under it reaches full
// colour (hole 1's green moves .12yd across the 18yd disc, and reads flat).
const GRID_R = 4, GRID_S = 2.2, GRID_FLOOR = .3; // rings, yards apart, min full-scale
function pushLandingGridGL()
{
    const d = Math.hypot(predLand.x-camX, predLand.z-camZ);
    const s = Math.max(.3, d*.005);           // chevron size, distance-compensated
    const h0 = heightAt(predLand.x, predLand.z);
    // pass one: the relief, so pass two can colour against it
    const pts = [];
    let range = GRID_FLOOR;
    for (let j=-GRID_R; j<=GRID_R; ++j)
    for (let i=-GRID_R; i<=GRID_R; ++i)
        if (i*i + j*j <= GRID_R*GRID_R)
        {
            const x = predLand.x + i*GRID_S, z = predLand.z + j*GRID_S;
            const dh = heightAt(x, z) - h0;
            range = Math.max(range, Math.abs(dh));
            pts.push([x, z, dh]);
        }
    glEnableFog = 0;
    for (const [x, z, dh] of pts)
    {
        // white at the centre's height, to red at the top of the range, blue
        // at the bottom
        const t = dh/range;
        const col = packColor(new Color(clamp(1+t), clamp(1-Math.abs(t)), clamp(1-t)), null);
        // the gradient points UPHILL, so negate it. The epsilon keeps a
        // near-flat spot pointing somewhere instead of collapsing the
        // triangle to a point and vanishing.
        const [gx, gz] = slopeAt(x, z);
        const m = Math.hypot(gx, gz) + 1e-6, dx = -gx/m, dz = -gz/m;
        const p = (f, r)=>
        {
            const px = x + dx*f*s - dz*r*s, pz = z + dz*f*s + dx*r*s;
            return vec3(px, heightAt(px, pz)+.1, pz);
        };
        glPushVerts([p(1.6, 0), p(-.8, 1), p(-.8, -1)], col);
    }
    glEnableFog = 1;
}

// aim aid: rainbow ring on the terrain at the predicted landing point,
// z-buffered (hills occlude it), fog-exempt so it stays vivid far downrange.
// FULL SHOTS ONLY: a putt is read off the dashed line and the cup itself,
// both right under a close camera, so the ring only gets in the way there.
function pushLandingRingGL()
{
    // distance-compensated size so the ring stays readable at range
    const d = Math.hypot(predLand.x-camX, predLand.z-camZ);
    const r = Math.max(3, d*.03), n = 20, w = Math.max(.4, d*.01);
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
    // Slim pulsing beacon so the spot reads at grazing angles (showBeacon = 0
    // folds it out). It LEANS TOWARD hole.wind.a, the way the ball is pushed
    // (flyStep's air velocity is (sin(wind.a), cos(wind.a))*wv, and the HUD
    // arrow points the same way), and PIVOTS AT THE GROUND - the profile runs
    // 0..2bh from gh - since the base marks the spot and leaning about the
    // middle walks it upwind.
    const showBeacon = 0;
    if (showBeacon)
    {
        const bh = Math.max(2, d*.03)*(1 + Math.sin(time*4)*.1)*hole.wind.s*.2;
        const br = Math.max(.4, d*.006);
        pushLathe(vec3(predLand.x, gh, predLand.z), [[0,0],[br,bh],[0,2*bh]], 4,
            hsl(.3 - hole.wind.s/35, 1, .6), hole.wind.a, 1.3);
    }
    glEnableFog = 1;
}

// THE SHOT LINE: predictLanding's own path drawn - the flight arc of a full
// shot, the rolled break of a putt. It ENDS at the stopping point, where
// pushLandingRingGL draws the ring, so the line always runs into the middle
// of the ring. No collision test and none wanted: it is z-buffered, so a tree
// or a ridge in the way simply EATS the line, and that is the cue. A faint
// ribbon built exactly like pushTrailGL (the shared shape is what roadroller
// pays for). PRED_NEAR: yards over which the line fades in away from the
// camera, nothing at the eye, full alpha at PRED_NEAR - at 4 a full shot's
// swing cam (ball ~6.5yd out) is untouched and a putt's (~2.7yd) starts at
// about two thirds alpha.
const PRED_NEAR = 4;
function pushPredGL()
{
    const n = predPath.length;
    const rx = Math.cos(camYaw), rz = -Math.sin(camYaw); // camera right
    const pts = [], cols = [];
    for (let i=0; i<n; ++i)
    {
        const s = predPath[i];
        // a FLAT half-width in yards, so the ribbon thins with distance
        const w = .1;
        // Fades along its length so the far end never competes with the ring.
        // A PUTT DASHES: two samples lit, two blanked, in alpha since the strip
        // is already here. And a NEAR FADE over PRED_NEAR yards: in the
        // placement cam the arc arrives from behind and runs through the eye,
        // where a .1yd ribbon inches away covers half the screen. Nothing else
        // ever comes within PRED_NEAR of the camera.
        const c = packColor(new Color(1, 1, 1,
            (clubI == CLUB_PUTTER && i&2 ? 0 : .5 - i/n*.3)
            * clamp(Math.hypot(s.x-camX, s.y-camY, s.z-camZ)/PRED_NEAR)));
        pts.push(vec3(s.x-rx*w, s.y+.1, s.z-rz*w), vec3(s.x+rx*w, s.y+.1, s.z+rz*w));
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
        const w = .06*(1 - age);
        const c = packColor(niceShot ? hsl((i + trailTotal)*.02, 1, .6, (1-age)*.8)
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

// sky sphere radius, yards (the world reaches ~960)
const SKY_R = 5e3;
// Floor under the elevation the BAKED SHADOWS are cast from (the drawn sun
// and the shading light go all the way down): a very low angle turns the
// round darkened patch into a smear. .5 rad is about 30 deg.
const SHADOW_MIN_E = .5;
const skyDir = (a, e)=> vec3(Math.sin(a)*Math.cos(e), Math.sin(e), Math.cos(a)*Math.cos(e));
// Soft disc on the sky sphere, angular radius ang. squish < 1 flattens it and
// rot spins that ellipse - a thin one is a two-armed bar, several at an offset
// make the sun's star. Rotate the basis BEFORE the squish, or the arm misses.
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
        hi = packColor(hslCol(hole.pal.sky0));
    for (let i=13; i--;)
    {
        // 12 wedges of 30 degrees; 13 columns close the circle
        const a = i*Math.PI/6, x = camX + Math.sin(a)*SKY_R, z = camZ + Math.cos(a)*SKY_R;
        pts.push(vec3(x, camY, z), vec3(x, camY + SKY_R, z));
        cols.push(haze, hi);
        // and a cone from the rim to a point overhead closes the sky to the
        // zenith - flat sky0, by hand since pushLathe lights every face
        cap.push(vec3(x, camY + SKY_R, z), vec3(camX, camY + SKY_R*2, camZ));
    }
    glPushVerts(pts, cols);
    glPushVerts(cap, hi);
}

function pushSkyGL()
{
    glEnableFog = 0;
    pushSkyBackGL();
    const sun = skyDir(SUN_A, SUN_E), sunCol = hslCol(hole.pal.sun);
    // SUN STAR ARMS: thin squished discs turned 30 degrees on from each
    // other, drawn first so the solid disc and its halos sit on top of where
    // the arms meet. KNOBS: the angular length (1), the thinness (.05), the
    // .2 alpha, and the count/spacing in the loop.
    for (let i=6; i--;)
        pushSkyDisc(sun, 1, sunCol.scale(1, .2), .05, i*Math.PI/6);
    // sun: soft disc + wide faint halo
    pushSkyDisc(sun, .1, sunCol);
    pushSkyDisc(sun, .2, sunCol.scale(1, .7));
    pushSkyDisc(sun, .3, sunCol.scale(1, .5));
    
    // clouds: rows of overlapping soft puffs parked at headings, drifting
    for (let i=7; i--;)
    for (let j=5+i%3; j--;)
        pushSkyDisc(skyDir(i + time*.02 + j*.1, .3 + (i%3)*.2 + Math.sin(j*j+i+time*.02)*.05),
            .2 + Math.sin(j**3)*.05, new Color(1, 1, 1, .7), .5);
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
    for(let i=9; i--;)
    {
        const t = i/20+.2-Math.sin(i**3)*.05, s = .04 + Math.sin(i*i)*.03;
        pushSkyDisc(sun.scale(1-t).add(fwd.scale(t)).normalize(), s, hsl(k/2+i/5, Math.sin(i**3)**2, .3, k));
    }
    glEnableFog = 1;
}

// (showColl and pushCollGL - the C-key collision volumes - live in
// debugGame.js; the call site below is the only thing left here)

// Drop trees close to the ball: hole.near is BOTH the drawn set and the
// collision set, so what you see is what you hit. Called once per shot from
// enterAim, not per aim change - a re-bake is ~8ms and reads as jitter.
const HIDE_R = 18;
function hideTrees()
{
    hole.near = hole.trees.filter(t => !(t.k & 1) && Math.hypot(t.x-ball.x, t.z-ball.z) > HIDE_R);
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
    // OPAQUE dynamic props, writing depth like the world does
    pushPinGL();
    pushBallGL();
    if (state == ST_AIM || state == ST_SWING)
        debug && gridAid ? pushLandingGridGL()      // G: the slope-grid experiment
            : clubI == CLUB_PUTTER || pushLandingRingGL();
    if (debug && showColl)
    {
        // through everything: the sphere sits INSIDE the opaque canopy
        glRender();
        glContext.disable(gl_DEPTH_TEST);
        pushCollGL();
        glRender();
        glContext.enable(gl_DEPTH_TEST);
    }
    glRender();
    // EVERYTHING TRANSPARENT LAST, WITH DEPTH WRITES OFF. The trail and the
    // shot line are ribbons that cross themselves, and if they wrote depth
    // the first segment on a pixel would block every later one and bite holes
    // out of the ribbon. They still depth-TEST, so the world and props occlude
    // them; they just stop occluding each other.
    glContext.depthMask(0);
    pushSkyGL();
    pushTrailGL();
    if (state == ST_AIM || state == ST_SWING)
        pushPredGL();
    glRender();
    glContext.depthMask(1); // the next frame's world draw needs it back
    if (FLARE)
    {
        // additive, alpha untouched (ZERO, ONE), and no depth test at all -
        // the ghosts add onto whatever is already there
        glContext.disable(gl_DEPTH_TEST);
        glContext.blendFuncSeparate(gl_ONE, gl_ONE, 0, gl_ONE);
        pushFlareGL();
        glRender();
        glContext.blendFunc(gl_ONE, gl_ONE_MINUS_SRC_ALPHA);
        glContext.enable(gl_DEPTH_TEST);
    }
}
