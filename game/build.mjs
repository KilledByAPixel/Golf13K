#!/usr/bin/env node

/**
 * LittleJS Build System - JS13K Edition
 * - Concatenates engine + game source
 * - Minifies with Closure Compiler and UglifyJS
 * - Compresses with Roadroller
 * - Inlines everything into a single HTML file
 * - Zips with ect and checks against the JS13K size limit
 */

import fs from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import ectLocation from 'ect-bin';

const __dirname = dirname(fileURLToPath(import.meta.url));

// No PROGRAM_TITLE: the shipped page has no <title> tag (-22 bytes). To put
// one back, add `buffer += '<title>SUNSHINE GOLF CLASSIC</title>';` to
// htmlBuildStep - it costs 22 plus a byte or so per character.
const PROGRAM_NAME = 'game';
const BUILD_FOLDER = 'build';
const SIZE_LIMIT = 13312; // JS13K limit in bytes

// Turn off engine features your game does not use to save space.
// Each disabled feature becomes a compile time constant, which lets Closure
// delete the whole subsystem. See "Saving space" in README.md for measurements.
const FEATURES =
{
    webgl:   false, // the engine's WebGL renderer is replaced by the game's glRender.js
    touch:   true,  // touch input and the on screen touch gamepad
    gamepad: false, // gamepad input
    sound:   true,  // all audio
    physics: false, // ball physics is custom, no engine solver needed
    // image-rendering:pixelated is for pixel art, and this game is smooth 3D
    pixelated: false,
};

// feature name -> [engine flag, its setter]
const FEATURE_FLAGS =
{
    webgl:   ['glEnable',         'setGLEnable'],
    touch:   ['touchInputEnable', 'setTouchInputEnable'],
    gamepad: ['gamepadsEnable',   'setGamepadsEnable'],
    sound:   ['soundEnable',      'setSoundEnable'],
    physics: ['enablePhysicsSolver', 'setEnablePhysicsSolver'],
    pixelated: ['canvasPixelated', 'setCanvasPixelated'],
};

// Engine methods Closure keeps because their NAME is also used on another
// type (Vector2/Vector3/Color share names), cut from the source before it
// minifies. Each fails loudly if the class or method is not found.
const STRIP_METHODS =
{
    Vector2: ['set', 'add', 'subtract', 'scale', 'length', 'normalize', 'cross',
              'angle', 'rotate', 'setDirection', 'direction', 'abs', 'floor', 'toString'],
    Color:   ['set', 'subtract', 'multiply'],
};

// Engine code paths the release cannot reach but Closure cannot prove dead,
// because they hang off mutable state the game never touches (an empty
// engineObjects list, an unset canvasFixedSize, no plugins, no images).
// Each is an exact match against the engine source and fails loudly when the
// engine changes under it. [description, pattern, replacement]
const STRIP_CODE =
[
    ['engineObjects update', /^function engineObjectsUpdate\(\)\n\{[\s\S]*?\n\}/m,
        'function engineObjectsUpdate() {}'],
    ['engineObjects render', /^ *engineObjects\.sort\(.*\n *for \(const o of engineObjects\)\n *o\.destroyed \|\| o\.render\(\);\n/m, ''],
    ['plugin update hooks', /^ *pluginUpdateList\.forEach\(f=>f\(\)\);\n/mg, ''],
    ['plugin render hooks', /^ *pluginRenderList\.forEach\(f=>f\(\)\);\n/mg, ''],
    ['fixed canvas size', /^ *if \(canvasFixedSize\.x\)\n *\{[\s\S]*?\n {8}\}\n *else\n/m, ''],
    ['callback defaults', /^ *game\w+ +\|\|= \(\)=>\{\};\n/mg, ''],
];

// Set true to keep intermediate .closure.js / .uglify.js files for debugging
const DEBUG_BUILD = false;
// Roadroller shrinks the code a lot but is the slowest step
const USE_ROADROLLER = true;
// Roadroller's parameters, PINNED. Left to itself roadroller runs
// --optimize 1, a RANDOMISED ~30-attempt parameter search, so the same
// source packs to a different size on every build - a spread of ~15 bytes,
// more than most single changes are worth, which makes A/B measurement
// unreliable. Set ROADROLLER_RETUNE to search again (about a minute) and
// paste the parameters it prints back here: worth doing before submission
// and after any large change.
const ROADROLLER_ARGS = '-Zab31 -Zlr1064 -Zmc4 -Zmd10 -Zpr13 -S0,1,2,3,6,7,13,21,25,42,226,385';
const ROADROLLER_RETUNE = false;

const sourceFiles =
[
    // LittleJS engine files
    `../src/engineRelease.js`,
    `../src/engineMath.js`,
    `../src/engineUtilities.js`,
    `../src/engineSettings.js`,
    `../src/engineObject.js`,
    `../src/engineDraw.js`,
    `../src/engineInput.js`,
    `../src/engineAudio.js`,
    `../src/engineTileLayer.js`,
    `../src/engineParticles.js`,
    `../src/engineMedals.js`,
    // engineWebGL.js replaced by the game's glRender.js
    `../src/engine.js`,

    // game files
    'course.js',
    'golfSim.js',
    'glRender.js',
    'view3d.js',
    'sfx.js',
    'game.js',
    'debugGame.js',
    'hud.js',
];
const dataFiles =
[
    // no data files, all art is procedural
];

console.log(`Building ${PROGRAM_NAME}...`);
const startTime = Date.now();

// always run relative to this script's folder so npm run build works from anywhere
process.chdir(__dirname);

try
{
    // remove old files and setup build folder
    fs.rmSync(BUILD_FOLDER, { recursive: true, force: true });
    fs.rmSync(`${PROGRAM_NAME}.zip`, { force: true });
    fs.mkdirSync(BUILD_FOLDER);

    // copy data files
    for (const file of dataFiles)
        fs.copyFileSync(file, `${BUILD_FOLDER}/${file}`);

    const buildSteps = [closureCompilerStep, uglifyBuildStep];
    if (USE_ROADROLLER)
        buildSteps.push(roadrollerBuildStep);
    buildSteps.push(htmlBuildStep, zipBuildStep);

    Build(`${BUILD_FOLDER}/index.js`, sourceFiles, buildSteps);
}
catch (e) { handleError(e, 'Build failed!'); }

// report size against the JS13K budget
const size = fs.statSync(`${PROGRAM_NAME}.zip`).size;
const percent = (100*size/SIZE_LIMIT).toFixed(1);
console.log('');
console.log(`Build completed in ${((Date.now() - startTime)/1e3).toFixed(2)} seconds!`);
console.log(`${PROGRAM_NAME}.zip: ${size} / ${SIZE_LIMIT} bytes (${percent}%)`);
if (size > SIZE_LIMIT)
{
    console.error(`OVER BUDGET by ${size - SIZE_LIMIT} bytes!`);
    process.exit(1);
}
console.log(`${SIZE_LIMIT - size} bytes remaining`);

///////////////////////////////////////////////////////////////////////////////

// A single build with its own source files, build steps, and output file
// - each build step is a callback that accepts a single filename
function Build(outputFile, files=[], buildSteps=[])
{
    // copy files into a buffer. CR is stripped (git checks out CRLF on
    // Windows and LF elsewhere, and that alone moves the packed size), and
    // so are the 'use strict' directives: Closure would carry one to the top
    // of the release (17 bytes of zip) and nothing here behaves differently
    // in sloppy mode (classes are strict regardless).
    let buffer = '';
    for (const file of files)
        buffer += fs.readFileSync(file, 'utf8').split(String.fromCharCode(13)).join('')
            .split("'use strict';").join('') + '\n';

    // strip out disabled features before minifying
    buffer = applyFeatureFlags(buffer);
    buffer = stripEngineMethods(buffer);
    buffer = stripEngineCode(buffer);

    // output file
    fs.writeFileSync(outputFile, buffer, {flag: 'w+'});

    // execute build steps in order
    for (const buildStep of buildSteps)
        buildStep(outputFile);
}

// Rewrite disabled feature flags to compile time constants. The engine
// declares them as mutable 'let' so setters can change them, and Closure
// cannot fold a mutable binding, so the whole subsystem behind the flag
// survives; 'const false' plus an emptied setter lets it prove the branch
// dead and delete it.
function applyFeatureFlags(buffer)
{
    for (const feature in FEATURE_FLAGS)
    {
        if (FEATURES[feature])
            continue;

        const [flag, setter] = FEATURE_FLAGS[feature];
        const flagPattern = new RegExp(`^let ${flag} = \\w+;`, 'm');
        const setterPattern = new RegExp(`^function ${setter}\\(([^)]*)\\)[^\\n]*$`, 'm');

        // fail loudly rather than silently skipping the optimization
        if (!flagPattern.test(buffer))
            handleError(`could not find "let ${flag}"`, 'Failed to disable feature: ' + feature);
        if (!setterPattern.test(buffer))
            handleError(`could not find "function ${setter}"`, 'Failed to disable feature: ' + feature);

        buffer = buffer.replace(flagPattern, `const ${flag} = false;`);
        buffer = buffer.replace(setterPattern, `function ${setter}($1) {}`);
        console.log(`Feature disabled: ${feature}`);
    }
    return buffer;
}

function stripEngineCode(buffer)
{
    for (const [what, pattern, replacement] of STRIP_CODE)
    {
        if (!pattern.test(buffer))
            handleError('pattern not found: ' + what, 'Failed to strip engine code');
        buffer = buffer.replace(pattern, replacement);
    }
    return buffer;
}

function stripEngineMethods(buffer)
{
    for (const className in STRIP_METHODS)
    {
        const classStart = buffer.indexOf('\nclass ' + className + '\n');
        const classEnd = buffer.indexOf('\n}\n', classStart);
        if (classStart < 0 || classEnd < 0)
            handleError('could not find class ' + className, 'Failed to strip methods');
        for (const method of STRIP_METHODS[className])
        {
            // the method starts at its 4-space-indented signature line and
            // ends where its braces balance (single- or multi-line body)
            const start = buffer.indexOf('\n    ' + method + '(', classStart);
            if (start < 0 || start > classEnd)
                handleError('could not find ' + className + '.' + method, 'Failed to strip method');
            let i = buffer.indexOf('{', start), depth = 0;
            for (; ; ++i)
            {
                if (buffer[i] == '{') ++depth;
                else if (buffer[i] == '}' && !--depth) break;
            }
            buffer = buffer.slice(0, start) + buffer.slice(i+1);
        }
    }
    return buffer;
}

function closureCompilerStep(filename)
{
    console.log(`Running closure compiler...`);
    const filenameTemp = filename + '.tmp';
    fs.copyFileSync(filename, filenameTemp);
    try
    {
        execSync(`npx google-closure-compiler --js=${filenameTemp} --js_output_file=${filename} --compilation_level=ADVANCED --warning_level=VERBOSE --jscomp_off=* --assume_function_wrapper`, {stdio: 'inherit'});
    }
    catch (e) { handleError(e, 'Closure Compiler step failed!'); }
    if (DEBUG_BUILD)
        fs.copyFileSync(filename, filename+'.closure.js');
    fs.rmSync(filenameTemp);
};

function uglifyBuildStep(filename)
{
    console.log(`Running uglify...`);
    try
    {
        execSync(`npx uglifyjs ${filename} -c -m --toplevel -o ${filename}`, {stdio: 'inherit'});
    }
    catch (e) { handleError(e, 'Uglify step failed!'); }
    if (DEBUG_BUILD)
        fs.copyFileSync(filename, filename+'.uglify.js');
};

function roadrollerBuildStep(filename)
{
    console.log(`Running roadroller...`);
    const args = ROADROLLER_RETUNE ? '--optimize 2' : ROADROLLER_ARGS;
    try
    {
        execSync(`npx roadroller ${filename} -o ${filename} ${args}`, {stdio: 'inherit'});
    }
    catch (e) { handleError(e, 'Roadroller step failed!'); }
};

function htmlBuildStep(filename)
{
    console.log(`Building html...`);

    // The SHELL IS STRIPPED to what the browser cannot infer. Measured:
    //   <!DOCTYPE html><head><title>..</title><meta charset><meta viewport>
    //   </head><body>                                       baseline
    //   no <title>                                          -22
    //   no <head>, </head>, </body>                          -8
    // <head> and </body> really are optional - the parser opens the head
    // implicitly, the metas land in it either way, and it closes the body at
    // EOF. <body> ITSELF IS NOT (see below). These cuts are not additive, so
    // measure the combination.
    // NO DOCTYPE either, which puts the page in QUIRKS MODE - the SAFE
    // direction here: the dev index.html has no doctype, so quirks is the
    // mode every playtest runs in, and the two MATCH. Nothing in the layout
    // cares anyway: body at margin 0, two absolutely positioned canvases
    // centred with a transform, no percentage-height chains and no tables.
    // CHARSET only if the payload actually needs one. The shipped file is
    // pure ASCII - roadroller escapes everything it packs, and the emoji live
    // inside that payload as JS code points rebuilt at runtime - so every
    // legacy decoding reads it identically. It is emitted the moment a high
    // byte appears, because one escaping past roadroller would corrupt the
    // whole payload silently, and nobody would spot that by looking.
    const js = fs.readFileSync(filename);
    let buffer = js.some(c => c > 127) ? '<meta charset=utf-8>' : '';
    // Mobile: real CSS pixels. Without this a phone lays the page out in a
    // virtual ~980px viewport and scales the result down, so the canvas gets
    // sized for a desktop and shrunk - HUD and meter unreadable. It cannot go.
    // initial-scale=1 only sets the OPENING zoom, to a level browsers already
    // default to when width=device-width is present, so it looks like 15 free
    // bytes. It is kept anyway: that level is the one old iOS could lose on
    // an orientation change, and a phone that comes back from landscape at
    // the wrong zoom is a bug nothing here can see - the cheapest insurance
    // in the file against a device we cannot test.
    // The value stays QUOTED. Unquoted, the "=" inside the value is a spec
    // parse error that Chrome happens to forgive, and two bytes to be right
    // by the spec everywhere beats being right by leniency, on the one
    // attribute whose failure only shows on a device we cannot test.
    buffer += '<meta name=viewport content="width=device-width,initial-scale=1">';
    // <body> is REQUIRED, unlike <head>. Without it the parser is still in
    // "in head" mode when it reaches the <script>, so the script runs with
    // document.body === null - and engineInit takes `rootElement =
    // document.body` as a DEFAULT ARGUMENT, evaluated right then, so it
    // throws. The OPENING tag is the whole fix; </body> is genuinely optional
    // (the parser closes it at EOF).
    buffer += '<body>';
    buffer += '<script>';
    buffer += js;
    buffer += '</script>';

    // output html file
    fs.writeFileSync(`${BUILD_FOLDER}/index.html`, buffer, {flag: 'w+'});
};

function zipBuildStep(filename)
{
    console.log(`Zipping...`);
    const args = ['-9', '-strip', '-zip', `../${PROGRAM_NAME}.zip`, 'index.html', ...dataFiles];

    // run ect zip compressor
    try
    {
        const result = spawnSync(ectLocation, args, {stdio: 'inherit', cwd: BUILD_FOLDER});
        if (result.error || result.status)
            handleError(result.error || `exit code ${result.status}`, 'Zip step failed!');
    }
    catch (e) { handleError(e, 'Zip step failed!'); }
};

// display the error and exit
function handleError(e, message)
{
    console.error(e);
    console.error(message);
    process.exit(1);
}
