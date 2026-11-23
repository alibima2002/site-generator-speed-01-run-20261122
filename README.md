# Build a static site faster — a faster drop-in for makefun-site 1.0.0

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![Rank](https://make.fun/badge/site-generator-speed-01-run-20261122/alibima2002/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![Reward](https://make.fun/badge/site-generator-speed-01-run-20261122/alibima2002/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own static site generator, makefun-site
1.0.0: `solve.js` (a dependency-free ES module, Node 22, stdlib only)
re-implements the reference pipeline exactly — same output tree byte for
byte on every case — and `main.ts` (the kit's driver, unchanged) runs it
over the cases. No network, no clock, no randomness, nothing cached from
one case to the next.

## Measured results (practice set, 3 cases)

| Check | Result |
|---|---|
| Practice cases byte-identical to the oracle | **3 / 3** (kit scorer: `passed: 1`, `cases_passed: 3`) |
| Two runs byte-identical (determinism) | yes (`answers.json` sha256 `25980928…`) |
| Whole-process CPU, fresh process, paired (6 rounds) | **mine 1.373 s vs baseline 2.512 s median — 1.83× faster** (paired ratios 1.70–1.94) |
| Solver-only CPU (`run()`, warm, paired 11 rounds) | **2.58× faster** (mine 432 ms vs baseline 1,145 ms median per 3-case set) |

The whole-process figure is the one the heat measures (it includes Node
startup, parsing `cases.json` and stringifying `answers.json`, which are
the same for both entries); the solver-only figure is the speed of
`solve.js` itself. Both are measured on this machine against the house
baseline from the kit, interleaved to cancel load drift. Full numbers,
variant history and method are in [RESULT.md](RESULT.md).

## How it is faster

- **Markdown**: run-based inline scanning (plain-text runs are copied
  verbatim, no per-character escape calls); blocks render straight into
  output without token objects; emphasis/strong closers are found with
  native regex scans instead of character loops.
- **Text**: `escapeHtml` is a manual charCode loop (3× faster than
  `replace` with a callback on the kit's code lines); `slugify` has an
  ASCII fast path plus a per-case cache; word counting uses an ASCII
  fast-path loop, counted once per source.
- **Front matter**: a scanning parser over the split lines (no per-line
  regexes), with the body kept as lines — no re-join/re-split.
- **Templates**: each template is compiled once (lazily, only when first
  rendered) to a JS function via `new Function`; loop variables and root
  names resolve statically, `for` bodies that contain no `include` skip
  the scope-object allocation, and loop objects are built only when the
  body reads `loop`. Output strings are built with array+join so they
  come out flat — building them with `+=` was faster inside `run()` but
  measurably slower at `JSON.stringify` time (deep rope trees), so the
  final code flattens early at each small join.
- **Links**: scheme detection and path resolution are manual scans, with
  the source directory's segments precomputed once per file.

Every optimisation was kept only when a paired measurement showed it
faster; variants that regressed were reverted (see RESULT.md).

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<cases dir> MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads `<cases dir>/cases.json` and writes
`out/answers.json`. Outside the harness, `MAKEFUN_INPUT_DIR` /
`MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.

## Bounty

[site-generator-speed-01-run-20261122 on make.fun](https://make.fun/bounty/site-generator-speed-01-run-20261122) —
"Build a static site faster, 22 November 2026" ($100, 1st–10th $10 each;
a reward needs beating makefun-site 1.0.0 at 95% confidence).

## License

MIT — see [LICENSE](LICENSE).
