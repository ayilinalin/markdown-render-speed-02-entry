# markdown-render-speed-02

[![make.fun](https://img.shields.io/badge/make.fun-bounty-7c3aed)](https://make.fun/c/markdown-render-speed-02)
[![make.fun](https://img.shields.io/badge/make.fun-markdown--render--speed--02-2563eb)](https://make.fun/c/markdown-render-speed-02)
[![make.fun](https://img.shields.io/badge/make.fun-709%2F720-16a34a)](https://make.fun/c/markdown-render-speed-02)

A dependency-free, single-file Markdown renderer (`parse.js`) that reproduces
`marked.parse` output (marked 18.1.3 defaults: GFM on, breaks off) exactly,
and a thin runner (`main.ts`) that renders a whole case set to JSON.

## Layout

- `parse.js` — the renderer. `parse(markdown)` returns the HTML string.
  ES module, no dependencies, no I/O, stateless per call.
- `main.ts` — entrypoint. Reads `$MAKEFUN_INPUT_DIR/cases.json`
  (default `/input`), renders every case, writes the HTML strings in order
  to `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output`).

## Run

```sh
node --experimental-strip-types main.ts
```

## Score

Practice set: 709/720 cases identical to the reference output (all 680 spec
examples pass). Steady-state render is about 2.2x faster than marked.

## License

MIT — see `LICENSE`.
