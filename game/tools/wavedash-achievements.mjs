#!/usr/bin/env node
// Creates the game's achievements through the Wavedash CLI, once. Ids are
// the ones wavedash.js sends; titles, descriptions and icons are the
// portal's to change later (the CLI requires a description; --image is optional).
// Run from the repo root (the CLI reads game_id from wavedash.toml there):
//   node game/tools/wavedash-achievements.mjs
import { execSync } from 'node:child_process';

const ACHIEVEMENTS =
[
    ['HOLE_IN_ONE',  'Hole in One',   'Hole out in a single stroke'],
    ['ALBATROSS',    'Albatross',     'Finish a hole three under par'],
    ['EAGLE',        'Eagle',         'Finish a hole two under par'],
    ['BIRDIE',       'Birdie',        'Finish a hole one under par'],
    ['PIN_HIT',      'Flagstick',     'Strike the pin with a shot'],
    ['CLASSIC_DONE', 'Classic Round', 'Play all 18 holes of the Classic course'],
    ['CLASSIC_PAR',  'Tour Card',     'Finish the Classic course at par or better'],
    ['REMIX_DONE',   'Remix Round',   'Play all 18 holes of a Remix course'],
    ['REMIX_PAR',    'Remix Master',  'Finish a Remix course at par or better'],
];

for (const [id, title, desc] of ACHIEVEMENTS)
{
    console.log(`creating ${id}`);
    execSync(`wavedash achievement create --identifier ${id} --title "${title}" --description "${desc}"`, {stdio: 'inherit'});
}
