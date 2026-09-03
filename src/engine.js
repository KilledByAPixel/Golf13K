/** 
 * LittleJS - The Tiny Fast JavaScript Game Engine
 * MIT License - Copyright 2021 Frank Force
 * 
 * Engine Features
 * - Object oriented system with base class engine object
 * - Base class object handles update, physics, collision, rendering, etc
 * - Engine helper classes and functions like Vector2, Color, and Timer
 * - Super fast rendering system for tile sheets
 * - Sound effects audio with zzfx and music with zzfxm
 * - Input processing system with gamepad and touchscreen support
 * - Tile layer rendering and collision system
 * - Particle effect system
 * - Medal system tracks and displays achievements
 * - Debug tools and debug rendering system
 * - Post processing effects
 * - Call engineInit() to start it up!
 * @namespace Engine
 */

'use strict';

/** Name of engine
 *  @type {String}
 *  @default
 *  @memberof Engine */
const engineName = 'LittleJS';

/** Version of engine
 *  @type {String}
 *  @default
 *  @memberof Engine */
const engineVersion = '1.18.25-js13k';

/** Frames per second to update
 *  @type {Number}
 *  @default
 *  @memberof Engine */
const frameRate = 60;

/** How many seconds each frame lasts, engine uses a fixed time step
 *  @type {Number}
 *  @default 1/60
 *  @memberof Engine */
const timeDelta = 1/frameRate;

/** Array containing all engine objects
 *  @type {Array}
 *  @memberof Engine */
let engineObjects = [];

/** Array with only objects set to collide with other objects this frame (for optimization)
 *  @type {Array}
 *  @memberof Engine */
let engineObjectsCollide = [];

/** Current update frame, used to calculate time
 *  @type {Number}
 *  @memberof Engine */
let frame = 0, drawn = -1;

/** Current engine time since start in seconds
 *  @type {Number}
 *  @memberof Engine */
let time = 0;

/** Actual clock time since start in seconds (not affected by pause or frame rate clamping)
 *  @type {Number}
 *  @memberof Engine */
let timeReal = 0;

/** Is the game paused? Causes time and objects to not be updated
 *  @type {Boolean}
 *  @default false
 *  @memberof Engine */
let paused = false;
/** Get if game is paused
 *  @return {Boolean}
 *  @memberof Engine */
function getPaused() { return paused; }

/** Set if game is paused
 *  @param {Boolean} [isPaused]
 *  @memberof Engine */
function setPaused(isPaused=true) { paused = isPaused; }

// Frame time tracking
let frameTimeLastMS = 0, frameTimeBufferMS = 0, averageFPS = 0;

///////////////////////////////////////////////////////////////////////////////
// plugin hooks

const pluginUpdateList = [], pluginRenderList = [];

/** Add a new update function for a plugin
 *  @param {Function} [updateFunction]
 *  @param {Function} [renderFunction]
 *  @memberof Engine */
function engineAddPlugin(updateFunction, renderFunction)
{
    ASSERT(!pluginUpdateList.includes(updateFunction));
    ASSERT(!pluginRenderList.includes(renderFunction));
    updateFunction && pluginUpdateList.push(updateFunction);
    renderFunction && pluginRenderList.push(renderFunction);
}

///////////////////////////////////////////////////////////////////////////////
// Main engine functions

/** Startup LittleJS engine with your callback functions
 *  @param {Function|function():Promise} gameInit - Called once after the engine starts up
 *  @param {Function} gameUpdate - Called every frame before objects are updated
 *  @param {Function} gameUpdatePost - Called after physics and objects are updated, even when paused
 *  @param {Function} gameRender - Called before objects are rendered, for drawing the background
 *  @param {Function} gameRenderPost - Called after objects are rendered, useful for drawing UI
 *  @param {Array} [imageSources=[]] - List of images to load
 *  @param {HTMLElement} [rootElement] - Root element to attach to, the document body by default
 *  @memberof Engine */
function engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, rootElement=document.body)
{
    ASSERT(!glCanvas, 'engine already initialized');

    // allow passing in empty functions
    gameInit       ||= ()=>{};
    gameUpdate     ||= ()=>{};
    gameUpdatePost ||= ()=>{};
    gameRender     ||= ()=>{};
    gameRenderPost ||= ()=>{};

    // internal update loop for engine
    function engineUpdate(frameTimeMS=0)
    {
        // update time keeping
        let frameTimeDeltaMS = frameTimeMS - frameTimeLastMS;
        frameTimeLastMS = frameTimeMS;
        if (debug || showWatermark)
            averageFPS = lerp(averageFPS, 1e3/(frameTimeDeltaMS||1), .05);
        const debugSpeedUp   = debug && keyIsDown('Equal'); // +
        const debugSpeedDown = debug && keyIsDown('Minus'); // -
        if (debug) // +/- to speed/slow time
            frameTimeDeltaMS *= debugSpeedUp ? 10 : debugSpeedDown ? .1 : 1;
        timeReal += frameTimeDeltaMS / 1e3;
        frameTimeBufferMS += paused ? 0 : frameTimeDeltaMS;
        if (!debugSpeedUp)
            frameTimeBufferMS = min(frameTimeBufferMS, 50); // clamp min framerate
        if (debug && debugVideoCaptureIsActive())
            frameTimeBufferMS = 0; // disable time smoothing when capturing video

        if (paused)
        {
            // update object transforms even when paused
            for (const o of engineObjects)
                o.parent || o.updateTransforms();
            inputUpdate();
            pluginUpdateList.forEach(f=>f());
            debugUpdate();
            gameUpdatePost();
            inputUpdatePost();
        }
        else
        {
            // apply time delta smoothing, improves smoothness of framerate in some browsers
            let deltaSmooth = 0;
            if (frameTimeBufferMS < 0 && frameTimeBufferMS > -9)
            {
                // force at least one update each frame since it is waiting for refresh
                deltaSmooth = frameTimeBufferMS;
                frameTimeBufferMS = 0;
            }
            
            // update multiple frames if necessary in case of slow framerate
            for (;frameTimeBufferMS >= 0; frameTimeBufferMS -= 1e3 / frameRate)
            {
                // increment frame and update time
                time = frame++ / frameRate;

                // update game and objects
                inputUpdate();
                gameUpdate();
                pluginUpdateList.forEach(f=>f());
                engineObjectsUpdate();

                // do post update
                debugUpdate();
                gameUpdatePost();
                inputUpdatePost();
            }

            // add the time smoothing back in
            frameTimeBufferMS += deltaSmooth;
        }

        // ONE DRAW PER UPDATE, NEVER MORE. `frame` counts fixed updates, so
        // on a screen faster than 60Hz this skips the frames that would come
        // out pixel for pixel identical - every input to the scene is
        // quantised to that step, so there is nothing new to show. Both
        // canvases keep their contents, which is why updateCanvas above had
        // to stop re-assigning their width: that wipes a canvas even when the
        // size has not changed, and it ran at the top of every rAF.
        if (!headlessMode && drawn != frame)
        {
            drawn = frame;
            // in here, not before the update loop: sizing a canvas WIPES it,
            // so doing it on a frame that is not going to be drawn would
            // blank the screen. Nothing reads the size on a skipped frame.
            updateCanvas();
            glPreRender();
            gameRender();
            engineObjects.sort((a,b)=> a.renderOrder - b.renderOrder);
            for (const o of engineObjects)
                o.destroyed || o.render();
            gameRenderPost();
            pluginRenderList.forEach(f=>f());
            touchGamepadRender();
            debugRender();

            if (showWatermark)
            {
                // update fps
                overlayContext.textAlign = 'right';
                overlayContext.textBaseline = 'top';
                overlayContext.font = '1em monospace';
                overlayContext.fillStyle = '#000';
                const text = engineName + ' ' + 'v' + engineVersion + ' / ' 
                    + drawCount + ' / ' + engineObjects.length + ' / ' + averageFPS.toFixed(1)
                    + (glEnable ? ' GL' : ' 2D') ;
                overlayContext.fillText(text, glCanvas.width-3, 3);
                overlayContext.fillStyle = '#fff';
                overlayContext.fillText(text, glCanvas.width-2, 2);
                drawCount = 0;
            }
        }

        debugVideoCaptureUpdate();
        requestAnimationFrame(engineUpdate);
    }

    function updateCanvas()
    {
        if (headlessMode) return;

        // THE LAYOUT VIEWPORT, not innerWidth/innerHeight. innerWidth tracks
        // the VISUAL viewport - the zoomable one - and on mobile it goes
        // wrong after a rotation: measured in an emulated iPhone XR, rotating
        // portrait->landscape->portrait left innerWidth/innerHeight reporting
        // 898x1944 while the page was really 414x896, so the canvas was built
        // more than twice the viewport and `margin:auto` centred it 524px
        // off the top until a reload. (visualViewport was wrong too.)
        // BODY, NOT documentElement, BECAUSE THIS PAGE IS IN QUIRKS MODE: there
        // is no doctype in dev or in the release shell (on purpose, it costs
        // 18 bytes). In quirks mode the spec makes body.clientWidth/Height the
        // viewport and documentElement.client* the html element's OWN box -
        // which is empty here, so Firefox read 1280x0 and squashed the canvas
        // to nothing, while Chromium leniently returned the viewport either
        // way. Measured on both engines and through emulated rotation: in
        // quirks mode body.client* equals what documentElement.client* gave in
        // Chromium. If a doctype is EVER added, this must go back to
        // documentElement.client*, since body's then reads 0.
        const winW = document.body.clientWidth;
        const winH = document.body.clientHeight;

        if (canvasFixedSize.x)
        {
            // clear canvas and set fixed size
            glCanvas.width  = canvasFixedSize.x;
            glCanvas.height = canvasFixedSize.y;
            
            // fit to window by adding space on top or bottom if necessary
            const aspect = winW / winH;
            const fixedAspect = glCanvas.width / glCanvas.height;
            glCanvas.style.width = overlayCanvas.style.width  = aspect < fixedAspect ? '100%' : '';
            glCanvas.style.height = overlayCanvas.style.height = aspect < fixedAspect ? '' : '100%';
        }
        else
        {
            // clear canvas and set size to same as window
            glCanvas.width  = min(winW, canvasMaxSize.x);
            glCanvas.height = min(winH, canvasMaxSize.y);
        }

        // clear overlay canvas and set size
        overlayCanvas.width  = glCanvas.width;
        overlayCanvas.height = glCanvas.height;

        // save canvas size
        mainCanvasSize = vec2(glCanvas.width, glCanvas.height);
    }

    function startEngine()
    {
        gameInit();
        engineUpdate();
    }
    if (headlessMode)
        return startEngine();

    // setup html
    const styleRoot = 
        // (no margin:0: the canvases are absolutely positioned against the
        // viewport, so the body's default margin never reaches them)
        'overflow:hidden;' +          // no scroll bars
        'background:#000;' +          // set background color
        'user-select:none;' +         // prevent hold to select
        '-webkit-user-select:none;' + // compatibility for ios
        (!touchInputEnable ? '' :     // no touch css settings
        'touch-action:none;' +        // prevent mobile pinch to resize
        '-webkit-touch-callout:none');// compatibility for ios
    rootElement.style.cssText = styleRoot;

    // init stuff and start engine
    inputInit();
    debugInit();
    glInit(rootElement); // appends glCanvas, so the hud lands on top of it

    // create overlay canvas for hud to appear above gl canvas
    rootElement.appendChild(overlayCanvas = document.createElement('canvas'));
    overlayContext = overlayCanvas.getContext('2d');

    // set canvas style
    const styleCanvas = 'position:absolute;'+ // allow canvases to overlap
        'inset:0;margin:auto'; // center on screen (canvas never exceeds window)
    glCanvas.style.cssText = overlayCanvas.style.cssText = styleCanvas;
    updateCanvas();
    
    return startEngine();
}

/** Update each engine object, remove destroyed objects, and update time
 *  @memberof Engine */
function engineObjectsUpdate()
{
    // get list of solid objects for physics optimization
    engineObjectsCollide = engineObjects.filter(o=>o.collideSolidObjects);

    // recursive object update
    function updateObject(o)
    {
        if (!o.destroyed)
        {
            o.update();
            for (const child of o.children)
                updateObject(child);
        }
    }
    for (const o of engineObjects)
    {
        // update top level objects
        if (!o.parent)
        {
            updateObject(o);
            o.updateTransforms();
        }
    }

    // remove destroyed objects
    engineObjects = engineObjects.filter(o=>!o.destroyed);
}

/** Destroy and remove all objects
 *  @memberof Engine */
function engineObjectsDestroy()
{
    for (const o of engineObjects)
        o.parent || o.destroy();
    engineObjects = engineObjects.filter(o=>!o.destroyed);
}

/** Collects all object within a given area
 *  @param {Vector2} [pos]                 - Center of test area, or undefined for all objects
 *  @param {Number|Vector2} [size]         - Radius of circle if float, rectangle size if Vector2
 *  @param {Array} [objects=engineObjects] - List of objects to check
 *  @return {Array}                        - List of collected objects
 *  @memberof Engine */
function engineObjectsCollect(pos, size, objects=engineObjects)
{
    const collectedObjects = [];
    if (!pos) // all objects
    {
        for (const o of objects)
            collectedObjects.push(o);
    }
    else if (size instanceof Vector2)  // bounding box test
    {
        for (const o of objects)
            isOverlapping(pos, size, o.pos, o.size) && collectedObjects.push(o);
    }
    else  // circle test
    {
        const sizeSquared = size*size;
        for (const o of objects)
            pos.distanceSquared(o.pos) < sizeSquared && collectedObjects.push(o);
    }
    return collectedObjects;
}

/** Triggers a callback for each object within a given area
 *  @param {Vector2} [pos]                 - Center of test area, or undefined for all objects
 *  @param {Number|Vector2} [size]         - Radius of circle if float, rectangle size if Vector2
 *  @param {Function} [callbackFunction]   - Calls this function on every object that passes the test
 *  @param {Array} [objects=engineObjects] - List of objects to check
 *  @memberof Engine */
function engineObjectsCallback(pos, size, callbackFunction, objects=engineObjects)
{ engineObjectsCollect(pos, size, objects).forEach(o => callbackFunction(o)); }

/** Return a list of objects intersecting a ray
 *  @param {Vector2} start
 *  @param {Vector2} end
 *  @param {Array} [objects=engineObjects] - List of objects to check
 *  @return {Array} - List of objects hit
 *  @memberof Engine */
function engineObjectsRaycast(start, end, objects=engineObjects)
{
    const hitObjects = [];
    for (const o of objects)
    {
        if (o.collideRaycast && isIntersecting(start, end, o.pos, o.size))
        {
            debugRaycast && debugRect(o.pos, o.size, '#f00');
            hitObjects.push(o);
        }
    }

    debugRaycast && debugLine(start, end, hitObjects.length ? '#f00' : '#00f', .02);
    return hitObjects;
}