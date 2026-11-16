# markdown-render-speed-02

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ayilinalin/markdown-render-speed-02-entry/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ayilinalin/markdown-render-speed-02-entry/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A dependency-free, from-scratch Markdown renderer that produces byte-identical
output to `marked` 18.1.3 (GFM defaults: gfm on, breaks off) — and renders a
720-case set several times faster than marked itself.

Entry for the [make.fun bounty](https://make.fun/bounty/markdown-render-speed-02):
write `parse.js`, a dependency-free ES module whose `parse(markdown)` returns
exactly `marked.parse(markdown)`, plus a `main.ts` driver that renders every
case in `/input/cases.json` to `/output/html.json`.

## Files

- `parse.js` — the renderer. Single ES module, no dependencies, stateless per
  call: block parser (ATX/setext headings, fenced/indented code, lists,
  blockquotes, tables, HTML blocks, thematic breaks, link reference
  definitions) plus an inline parser (emphasis/strong/strikethrough, links
  and images incl. reference/collapsed/shortcut forms, code spans, autolinks
  incl. GFM extended `www.`/scheme/email autolinks, entities, hard/soft
  breaks). Behaviour was developed against the practice set only; it never
  reads `marked`'s source.
- `main.ts` — the driver (Node 22). Reads `/input/cases.json`, renders each
  case with `parse`, writes the HTML strings in order to
  `<output-dir>/html.json`. The output directory honours `MAKEFUN_OUTPUT_DIR`
  when set, otherwise `/output`.

## Run locally

```sh
node main.ts        # needs /input/cases.json present; writes /output/html.json
```

## Practice score

720-case practice set: **700/720 identical** (all 680 CommonMark + GFM spec
examples pass; 20 generated README-doc cases differ on emphasis edge cases
and a few fenced-code/list interactions). Whole-set render takes ~1.1 s
(parse) / ~1.6 s wall locally, vs ~4 s CPU for marked itself on the same set.

## License

MIT — see [LICENSE](LICENSE).
