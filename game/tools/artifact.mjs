#!/usr/bin/env node
// Builds artifact.html: a single self-contained UNMINIFIED page for playing
// in the Claude desktop artifact panel (or anywhere). Differences vs the
// compo build: no minification, and localStorage is shimmed because
// sandboxed iframes block it.
// Bundles engineDebug.js on purpose: the debug tools (F fly cam with mouse
// look, M hole map, [ ] hole skip) stay available in the artifact.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const eng = (f)=> join(root, '../src', f);

const files =
[
    eng('engineDebug.js'), eng('engineMath.js'), eng('engineUtilities.js'),
    eng('engineSettings.js'), eng('engineObject.js'), eng('engineDraw.js'),
    eng('engineInput.js'), eng('engineAudio.js'), eng('engineTileLayer.js'),
    eng('engineParticles.js'), eng('engineMedals.js'),
    eng('engine.js'),
    join(root, 'course.js'), join(root, 'golfSim.js'), join(root, 'glRender.js'), join(root, 'view3d.js'),
    join(root, 'sfx.js'), join(root, 'game.js'), join(root, 'hud.js'),
];

let src = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');

// disable the same engine features as the release build (build.mjs FEATURES)
// - gamepad especially: sandboxed iframes block the Gamepad API entirely
for (const [flag, setter] of [
    ['glEnable', 'setGLEnable'],
    ['gamepadsEnable', 'setGamepadsEnable'],
    ['enablePhysicsSolver', 'setEnablePhysicsSolver']])
{
    src = src.replace(new RegExp(`^let ${flag} = \\w+;`, 'm'), `let ${flag} = false;`);
    src = src.replace(new RegExp(`^function ${setter}\\(([^)]*)\\)[^\\n]*$`, 'm'),
        `function ${setter}($1) {}`);
}

// sandboxed iframes throw on localStorage access - swap in a safe shim
src = 'let LSAFE={}; try { LSAFE = window.localStorage || {}; } catch(e) {}\n'
    + src.replaceAll('localStorage', 'LSAFE');

const html = '<!DOCTYPE html><html><head><title>RAINBOW GOLF TOUR</title>'
    + '<meta charset=utf-8>'
    + '<meta name=viewport content="width=device-width,initial-scale=1">'
    + '<style>body{margin:0;background:#000}</style></head><body>'
    + '<script>\n' + src + '\n</script></body></html>';

fs.writeFileSync(join(root, 'artifact.html'), html);
console.log('artifact.html:', (html.length/1024).toFixed(0) + 'KB');
