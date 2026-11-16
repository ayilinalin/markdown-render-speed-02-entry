// Driver for markdown-render-speed-02.
// Reads every case from /input/cases.json, renders each one with parse()
// from ./parse.js, and writes the HTML strings (same order) as a JSON
// array to <output-dir>/html.json. The output directory honours
// MAKEFUN_OUTPUT_DIR when set, otherwise /output.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

function resolveInputDir(): string {
  const env = process.env.MAKEFUN_INPUT_DIR;
  if (env !== undefined && env.length > 0) return env;
  return '/input';
}

function resolveOutputDir(): string {
  const env = process.env.MAKEFUN_OUTPUT_DIR;
  if (env !== undefined && env.length > 0) return env;
  return '/output';
}

function main(): void {
  const cases = JSON.parse(
    readFileSync(join(resolveInputDir(), 'cases.json'), 'utf8'),
  ) as Case[];
  const out: string[] = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) {
    out[i] = parse(cases[i].markdown);
  }
  const outDir = resolveOutputDir();
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'html.json'), JSON.stringify(out));
}

main();
