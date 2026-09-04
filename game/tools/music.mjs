// Render the music and the sound effects through zzfxG and compare them
// objectively: peak (clipping) and RMS (does the music sit under the
// effects?). A headless run cannot listen, so these numbers are the only
// check on the mix that does not need ears.
//
// NOTHING here is a copy of the game's data: the instrument arrays are read
// out of sfx.js, and the sequence is produced by running the REAL
// updateMusic against a stub Sfx that records what it was asked to play, so
// a rewrite of the music cannot leave this silently reporting the old one.
// usage: npm run music
import fs from 'node:fs';
const R = 'C:/dev/GitHub/JS13K/golf/';
const sfxSrc = fs.readFileSync(R + 'game/sfx.js', 'utf8');

// pull the game's own generator out of sfx.js, so this measures what
// actually plays
const zzfxG = new Function('const PI=Math.PI; let audioDefaultSampleRate=44100;'
  + 'const sign=Math.sign, abs=Math.abs, clamp=(v,mn=0,mx=1)=>v<mn?mn:v>mx?mx:v;'
  + sfxSrc.slice(sfxSrc.indexOf('const sfxGen'), sfxSrc.indexOf('class Sfx'))
  + '; return sfxGen;')();

const SR = 44100;
const rms = a => (a.reduce((s, v) => s + v*v, 0)/a.length)**.5;
const peak = a => { let m = 0; for (const v of a) m = Math.max(m, Math.abs(v)); return m; };

// every `const snd_x = [MUSIC &&] new Sfx([...])` in sfx.js, by name
const arrays = {};
for (const m of sfxSrc.matchAll(/const\s+(snd_\w+)\s*=\s*(?:MUSIC\s*&&\s*)?new Sfx\((\[[^\]]*\])\)/g))
    arrays[m[1]] = new Function('return ' + m[2])();

console.log('SOUND EFFECTS (as rendered from sfx.js)');
const samples = {};
for (const k in arrays)
{
    const s = samples[k] = zzfxG(...arrays[k]);
    console.log(`  ${k.padEnd(11)} ${(s.length/SR).toFixed(2)}s  peak ${peak(s).toFixed(2)}  rms ${rms(s).toFixed(3)}`);
}

// ---- run the REAL updateMusic, recording every note it asks for ----
const events = [];
// the beat the stub stamps onto each note - the run loop advances it, and
// without that every note lands at t=0 and the mix reads as one huge peak
const clock = {t: 0};
const stub = (name)=> ({
    play: (vol=1, rate=1)=> events.push([name, clock.t, Math.log2(rate)*12, vol]),
    playNote: (n=0, vol=1)=> events.push([name, clock.t, n, vol]),
});
let seed = 1;
const musicSrc = sfxSrc.slice(sfxSrc.indexOf('// PROCEDURAL MUSIC'));
const run = new Function('EV', 'STUB', 'TICK', 'CLOCK', `
    Math.random = (()=>{ let s=1; return ()=>{ s=(s*1664525+1013904223)>>>0; return s/2**32; }; })();
    const rand=(a=1,b=0)=>b+Math.random()*(a-b);
    const randInt=(a,b=0)=>Math.floor(rand(a,b));
    const randSign=()=>randInt(2)*2-1;
    const mod=(a,b=1)=>((a%b)+b)%b;
    let frame = 0;
    class Sfx { constructor(){ return STUB(Sfx.n = (Sfx.n||0)+1); } }
    const snd_bounce = STUB("snd_bounce"); // the hat: updateMusic plays the turf blip
    const ST_TITLE = 0, ST_INTRO = 1; let state = ST_TITLE; // updateMusic reads the game state (title mix)
    ${musicSrc.replace(/const (snd_\w+)\s*=\s*MUSIC\s*&&\s*new Sfx\((\[[^\]]*\])\)/g,
        'const $1 = STUB("$1")')}
    for (let i = 0; i < TICK; ++i) { CLOCK.t = i; updateMusic(); frame += 8; }
`);
const BEATS = 320;                       // 320 beats at 8 frames = ~42s
run(events, stub, BEATS, clock);

// ---- mix them down ----
const DT = 8/60;                         // one beat = 8 frames at 60fps
const inst = { snd_kick: 'snd_kick', snd_hat: 'snd_hat', snd_bass: 'snd_bass', snd_lead: 'snd_lead' };
const len = Math.ceil((BEATS*DT + 2)*SR);
const mix = new Float32Array(len);
const counts = {};
for (const [name, beat, semis, vol] of events)
{
    counts[name] = (counts[name]||0) + 1;
    const src = samples[name];
    if (!src) continue;
    const rate = 2**(semis/12), start = Math.round(beat*DT*SR);
    for (let i = 0; i < src.length/rate && start+i < len; ++i)
        mix[start+i] += src[Math.floor(i*rate)]*vol;
}
const played = mix.slice(0, Math.round(BEATS*DT*SR));
console.log(`\nMUSIC  ${(BEATS*DT).toFixed(1)}s of generated music`);
for (const k in counts)
    console.log(`  ${k.padEnd(11)} ${String(counts[k]).padStart(4)} notes`);
// Everything above is the RAW zzfxG amplitude. What actually reaches the
// speakers is scaled by the engine's master gain (soundVolume in
// engineSettings.js), so the clipping test has to use that or it cries wolf:
// the hat alone peaks at 1.7 raw and is perfectly safe at .5 out.
const MASTER = +(/^let soundVolume = ([\d.]+)/m.exec(
    fs.readFileSync(R + 'src/engineSettings.js', 'utf8')) || [0, .3])[1];
console.log(`  peak ${peak(played).toFixed(2)}   rms ${rms(played).toFixed(3)}   (raw, before master gain)`);
console.log(`  master gain ${MASTER}  ->  peak out ${(peak(played)*MASTER).toFixed(2)}`);
let clip = 0; for (const v of played) if (Math.abs(v)*MASTER > 1) ++clip;
console.log(`  clipping samples after gain: ${clip}` + (clip ? '   <-- TOO LOUD' : '   (none)'));
const loud = samples['snd_tee'] || samples['snd_hole'];
if (loud)
    console.log(`  music rms as a fraction of the loudest effect: ${(rms(played)/rms(loud)).toFixed(2)}x`
        + '   (background music wants to sit well under, but stay audible)');
