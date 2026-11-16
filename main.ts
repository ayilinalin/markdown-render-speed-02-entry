// Entrypoint for the markdown-render-speed-02 bounty.
// Reads every case from $MAKEFUN_INPUT_DIR/cases.json (default /input),
// renders each markdown string with the dependency-free parser in
// parse.js, and writes the HTML strings (same order) as a JSON array to
// $MAKEFUN_OUTPUT_DIR/html.json (default /output).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw: unknown = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const cases: Case[] = Array.isArray(raw) ? raw : (raw as { cases: Case[] }).cases;
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
