#!/usr/bin/env node
// Attaches achievement icons through the Wavedash CLI. Drop images named
// <IDENTIFIER>.png (or .jpg/.jpeg/.webp/.avif) into local/achievement-icons/
// and run this from the repo root; every file whose name matches an
// achievement identifier on the game is uploaded with `achievement update`.
// Prompts for the images: docs/wavedash-achievement-icons.md.
//   node game/tools/wavedash-icons.mjs
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { join, parse } from 'node:path';

const DIR = 'local/achievement-icons';
const EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif']);

if (!fs.existsSync(DIR))
{
    console.error(`no ${DIR}/ folder - put the icons there first`);
    process.exit(1);
}

const achievements = JSON.parse(execSync('wavedash achievement list --json', {encoding: 'utf8'}));
const idOf = Object.fromEntries(achievements.map(a => [a.identifier, a._id]));

let done = 0;
for (const file of fs.readdirSync(DIR))
{
    const {name, ext} = parse(file);
    if (!EXT.has(ext.toLowerCase()))
        continue;
    const id = idOf[name.toUpperCase()];
    if (!id)
    {
        console.warn(`skip ${file}: no achievement named ${name.toUpperCase()}`);
        continue;
    }
    console.log(`${name.toUpperCase()} <- ${file}`);
    execSync(`wavedash achievement update --id ${id} --image "${join(DIR, file)}"`, {stdio: 'inherit'});
    ++done;
}
console.log(`${done} icon(s) attached; missing: ` +
    (achievements.filter(a => !fs.readdirSync(DIR).some(f => parse(f).name.toUpperCase() == a.identifier))
        .map(a => a.identifier).join(', ') || 'none'));
