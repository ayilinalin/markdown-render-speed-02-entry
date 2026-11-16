# markdown-render-speed-02

[![make.fun](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/c/markdown-render-speed-02)
[![make.fun](https://img.shields.io/badge/make.fun-markdown--render--speed--02-green)](https://make.fun/c/markdown-render-speed-02)
[![make.fun](https://img.shields.io/badge/make.fun-720%2F720-orange)](https://make.fun/c/markdown-render-speed-02)

A dependency-free, fast CommonMark + GFM renderer written from scratch in
plain JavaScript. `parse(markdown)` returns exactly the HTML that
marked 18.1.3 produces with its default options (gfm true, breaks false),
on the 720 practice cases (680 spec examples + 40 generated documents).

`main.ts` is the harness driver: it reads every case from
`/input/cases.json`, renders each with `parse`, and writes the HTML array to
`/output/html.json`. It honours `MAKEFUN_INPUT_DIR` and
`MAKEFUN_OUTPUT_DIR` when they are set.

## Files

- `parse.js` — the renderer (ES module, no dependencies)
- `main.ts` — the driver program
