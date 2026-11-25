# Launch Radar — Research Desk

A token launch radar for [make.fun's token-radar-01 bounty](https://make.fun/bounty/token-radar-01): every pre-token protocol in the sealed snapshot, priced from the snapshot's own comparables, with a farm plan per protocol.

[![Competition](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![Rank](https://make.fun/badge/token-radar-01/salikamarlisa3-cell/token-radar-01-v8/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![Reward](https://make.fun/badge/token-radar-01/salikamarlisa3-cell/token-radar-01-v8/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

## The model

`implied value = TVL x category multiple x maturity factor x momentum band`

- The category multiple is the median market-cap/TVL of the snapshot's own tokened protocols in the same category, shrunk toward the global median (k = 2) so thin categories cannot shout, and capped at the 95th percentile of observed multiples (x5.13 on this snapshot) so a single comparable cannot carry a board. 128 of the 144 tokened records carry a usable price; the 16 records priced at $0 or below are excluded as comparables and the exclusion is stated on the page.
- Every other term was fitted and then kept, banded or dropped on held-out tests (10-fold, folds fixed by slug hash, typical miss = median multiple of the pricing error): TVL x global median alone misses by x5.17; category multiples bring it to x4.79; maturity to x4.48; a linear momentum term made it worse (x4.72) and was dropped; momentum survives only as an extreme-move band (x4.45, the final model); a concentration dampener made it worse (x4.57) and was dropped. Final held-out bias x1.36 — the model prices slightly hot and says so. The full ablation table is printed on the dashboard's methodology section.
- The board ranks all 198 pre-token protocols above $5M TVL under the house rule generalized — the 40-protocol watchlist is a floor, not a ceiling — and each row carries a verdict (Farm now / Watch / Skip) and a farm plan priced from the protocol's own chain, category and size.

## Running it

```
node main.ts --input <snapshot.json>   # writes /output (or $MAKEFUN_OUTPUT_DIR)
```

Node 22, standard library only. Two runs write identical bytes: no clock, no randomness, the snapshot is read in its given order.
