/**
 * LittleJS Audio System - REDUCED TO WHAT THIS GAME USES
 * The generator, the sound object and the whole graph live in game/sfx.js
 * now. Gone from here: Sound, SoundWave, ZzFXMusic, playAudioFile,
 * playSamples, speak, getNoteFrequency, zzfxG, zzfx, zzfxM, and the master
 * gain node - the game never referenced any of them, and three of them were
 * being cut by build-step regexes instead, so the dev build ran code the
 * release did not.
 * @namespace Audio
 */

'use strict';

/** Audio context used by the engine
 *  @type {AudioContext}
 *  @memberof Audio */
let audioContext = new AudioContext;

/** Default sample rate used for all ZzFX sounds
 *  @default 44100
 *  @memberof Audio */
const audioDefaultSampleRate = 44100;
