#!/usr/bin/env node
// Creates the game's stats through the Wavedash CLI, once. Ids are the
// ones wavedash.js adds to; names are the portal's to change later.
// Run from the repo root (the CLI reads game_id from wavedash.toml there):
//   node game/tools/wavedash-stats.mjs
import { execSync } from 'node:child_process';

const STATS =
[
    ['SHOTS',    'Shots taken'],
    ['DISTANCE', 'Yards travelled'],
    ['HOLES',    'Holes completed'],
    ['ROUNDS',   'Rounds completed'],
];

for (const [id, name] of STATS)
{
    console.log(`creating ${id}`);
    execSync(`wavedash stat create --identifier ${id} --name "${name}"`, {stdio: 'inherit'});
}
