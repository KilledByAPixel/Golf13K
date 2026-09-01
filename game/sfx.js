'use strict';

/*  RAINBOW GOLF TOUR - zzfx sound effects
    Preset-derived shapes (noise thumps for impacts, coin/powerup arps for
    rewards), never ear-tuned. The first parameter is the volume. */

// OUR OWN ZzFX generator, so the dev build runs exactly the code that ships.
// The parameter POSITIONS are ZzFX's, untouched, so the arrays below are
// ordinary zzfx sounds - but every feature this game never sets is gone:
// randomness (Sfx does its own pitch jitter per play and passes 0 here, so
// the rand() call was a no-op that still burned a Math.random draw),
// modulation, bitCrush, tremolo, the biquad LP/HP filter, and (2026-08-31)
// the saw/tan/square wave shapes - the arrays only ever use sin, triangle
// and noise. The earlier cuts used to be regexes in build.mjs, which meant
// the code you stepped through in dev was not the code that shipped.
// Verified sample-identical to the engine's zzfxG on all of this game's
// sounds (re-verified byte-exact after the shape cut).
const sfxGen = (volume = 1, randomness, frequency = 220, attack = 0,
    sustain = 0, release = .1, shape = 0, shapeCurve = 1, slide = 0,
    deltaSlide = 0, pitchJump = 0, pitchJumpTime = 0, repeatTime = 0,
    noise = 0, modulation, bitCrush, delay = 0, sustainVolume = 1, decay = 0)=>
{
    const PI2 = PI*2, SR = audioDefaultSampleRate;
    let startSlide = slide *= 500 * PI2 / SR / SR,
        startFrequency = frequency *= PI2 / SR,
        b = [], t = 0, i = 0, j = 1, r = 0, s = 0, f, length;

    attack = attack * SR || 9; // 9 samples: a zero attack pops
    decay *= SR;
    sustain *= SR;
    release *= SR;
    delay *= SR;
    deltaSlide *= 500 * PI2 / SR**3;
    pitchJump *= PI2 / SR;
    pitchJumpTime *= SR;
    repeatTime = repeatTime * SR | 0;

    for (length = attack + decay + sustain + release + delay | 0;
        i < length; b[i++] = s * volume)               // sample
    {
        // Wave shape - ONLY the shapes this game's arrays use ship (Frank's
        // audit, 2026-08-31): 0 sin, 1 triangle, anything above = noise (4).
        // Saw (2), tan (3) and square-with-duty (5) are gone; a new sound
        // wanting one puts its branch back from zzfx. Square was also the
        // one shape that skipped the curve, so the curve now applies
        // unconditionally.
        s = shape? shape>1?
            Math.sin(t**3) :                           // 4 noise
            1-4*abs(Math.round(t/PI2)-t/PI2):          // 1 triangle
            Math.sin(t);                               // 0 sin

        s = sign(s)*(abs(s)**shapeCurve) *             // shape curve
            (i < attack ? i/attack :                 // attack
            i < attack + decay ?                     // decay
            1-((i-attack)/decay)*(1-sustainVolume) : // decay falloff
            i < attack + decay + sustain ?           // sustain
            sustainVolume :                          // sustain volume
            i < length - delay ?                     // release
            (length - i - delay)/release *           // release falloff
            sustainVolume :                          // release volume
            0);                                      // post release

        s = delay ? s/2 + (delay > i ? 0 :           // delay
            (i<length-delay? 1 : (length-i)/delay) * // release delay
            b[i-delay|0]/2/volume) : s;              // sample delay

        f = frequency += slide += deltaSlide;        // frequency
        t += f + f*noise*Math.sin(i**5);             // noise

        if (j && ++j > pitchJumpTime)                // pitch jump
        {
            frequency += pitchJump;                  // apply pitch jump
            startFrequency += pitchJump;             // also apply to start
            j = 0;                                   // stop pitch jump time
        }

        if (repeatTime && !(++r % repeatTime))       // repeat
        {
            frequency = startFrequency;              // reset frequency
            slide = startSlide;                      // reset slide
            j = j || 1;                              // reset pitch jump time
        }
    }
    return b;
};

// The engine's Sound carried a panner, range, loop and stop this game never
// used, and a master gain node that only ever held one constant. All gone
// from the engine now; this is the whole graph: samples -> gain -> out.
class Sfx
{
    constructor(z)
    {
        this.j = z[1] ?? .05; // zzfx randomness, applied as pitch jitter per play
        z[1] = 0;
        this.s = sfxGen(...z);
    }
    play(volume=1, rate=1, jitter=1)
    {
        if (!soundEnable) return; // dev: silent until the first click
        const ctx = audioContext, src = ctx.createBufferSource(), g = ctx.createGain();
        const b = ctx.createBuffer(1, this.s.length, audioDefaultSampleRate);
        b.getChannelData(0).set(this.s);
        src.buffer = b;
        src.playbackRate.value = rate*(1 + this.j*jitter*rand(-1, 1));
        // soundVolume was the master gain node's value; applied here
        // instead, so the graph is samples -> gain -> destination
        g.gain.value = volume * soundVolume;
        src.connect(g).connect(ctx.destination);
        // a click resumes the context, but that is async: start after it
        ctx.state == 'running' ? src.start() : ctx.resume().then(()=> src.start());
    }
    playNote(semitones, volume) { this.play(volume, 2**(semitones/12), 0); }
}

const snd_tee     = new Sfx([,,400,.04,,.15,,,3,,,,,3,,,,.3,.06]);       // driver thump
const snd_putt    = new Sfx([,,1e3,.02,,,,,3,,,,,3,,,,.4,.01]);      // soft tap
const snd_bounce  = new Sfx([.5,,,,,.04,4]);    // turf blip
const snd_sand    = new Sfx([,,160,,,.4,4,,,,,,,5]);  // sand thud
const snd_splash  = new Sfx([,,,.05,.1,.5,4,,,,,,,8]);   // water
const snd_hole    = new Sfx([,,1600,,,.4,,,,,800,.05]);        // coin (cup rattle)
const snd_nice    = new Sfx([.8,,1e3,,,.4,1,2,,,600,.1]);           // high coin
const snd_fanfare = new Sfx([,,500,.02,.1,1,1,,,,250,,.05,,,,.1]); // powerup arp
const snd_tick    = new Sfx([.3,,500,,,.03,,,9]);              // UI: view toggle, power set
// UI: nudging a shot setting
const snd_adjust  = new Sfx([.15,,1200,,,.012,,,6]);           // UI: club/spin/distance
const snd_ob      = new Sfx([,,900,.05,.2,.4,1,.3,,6,-200,.1,.2]);     // fail slide

// speed is the impact speed in yards/second - a full drive lands at about
// 25, hence the divisor. SQUARE ROOT, not linear: impact speeds are heavily
// skewed (median 5.7), and a linear map left 40% of bounces on the floor.
function sfxBounce(surf, speed)
{
    const v = clamp((speed/25)**.5, .3, 1);
    if (surf == SURF_BUNKER)
        snd_sand.play(v);
    else
        snd_bounce.play(v);
}

///////////////////////////////////////////////////////////////////////////////
// PROCEDURAL MUSIC. No song data, only a beat counter: every note is a
// random WALK over a major pentatonic, which has no semitone clashes, so
// any two notes it can pick sound intentional together.
// Voices enter in turn so the piece BUILDS - drums first, bass after 4 bars,
// melody after 8. The chord walks a step every 32 beats and is pulled home
// every 256, so it wanders without drifting away.
// Ticks only in the quiet states; game.js gates the call, so the beat
// counter stops during a swing. MUSIC = 0 folds it all out of the build.
const MUSIC = 1;
const snd_kick = MUSIC && new Sfx([,,99,,,.02,,,,,,,,2]);
const snd_hat  = MUSIC && new Sfx([,,1e3,,,.02,4]);
const snd_bass = MUSIC && new Sfx([.5,0,82,,,.05,,.5,,,,,,,,,,.1,.1]);
const snd_lead = MUSIC && new Sfx([.3,0,164,,,,,9,,,,,,,,,,.1,.2]);
const BASS_SCALE = [0,5,7,5]; // pentatonic
const SCALE = [0,7,4,12,11,12,7,4];   // major
let beat = -1, bassNote = 0, leadNote = 0, chord = 0;
const musicTick = 8;

function updateMusic()
{
    if (frame%musicTick)
        return;
        
    ++beat;

    // a new chord every 4 bars, home again every 32
    if (beat%32 == 0)
        bassNote = leadNote = chord = beat%128 ? chord + randSign() : 0;

    // hat on eighths, dropping out for the last bar of every 4 so the loop
    if (beat%128 < 96 && (beat%2 == 0 || !randInt(9)))
        snd_hat.play(((beat>>1)%4 - 2 ? .2 : .4) - rand(.1));
    if (beat%4 == 0)
        snd_kick.play(((beat>>1)%4? 1 : .5) - rand(.1));
        
    // bass: mostly on the beat, occasionally off it
    if (beat%2 == 0 && (beat%8 == 0 || randInt(4)) || !randInt(9))
        snd_bass.playNote(BASS_SCALE[mod(bassNote = bassNote + (state != ST_TITLE), BASS_SCALE.length)]);

    // melody, an octave above the bass
    if (state == ST_TITLE)
    if (beat%128 < 64 ? beat%8 == 0 : beat%2==0 || beat%3 == 0)
    {
        const b = BASS_SCALE[mod(chord, BASS_SCALE.length)];
        const a = b+SCALE[mod(leadNote = beat%16 && leadNote+1, SCALE.length)];
        snd_lead.playNote(a+7);
    }
}