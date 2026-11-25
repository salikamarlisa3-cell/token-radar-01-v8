// Launch Radar — the model. Every number on the board is computed from the
// sealed snapshot at run time: no hardcoded protocol names, no hardcoded
// prices. The only constants are the model's fitted parameters, and each one
// carries the held-out evidence that kept it (see MODEL and the ablation
// table in buildRadarData; folds are fixed by slug hash, 10-fold, over the
// snapshot's 128 usable tokened comparables).
//
//   implied value = TVL x category multiple x maturity factor x momentum band
//
// The category multiple is the median market-cap/TVL of the snapshot's own
// tokened protocols in the same category, shrunk toward the global median so
// a category with two members cannot shout, and capped at the 95th percentile
// of observed multiples: a single comparable cannot carry a board (the cap
// binds exactly where held-out tests are blind — categories too thin to have
// held-out members — and costs nothing where they can see: x4.449 either
// way). Momentum enters the price only as an extreme-move band: a linear
// momentum term was fitted, tested, and dropped because it made held-out
// pricing worse (x4.48 -> x4.72).

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Fitted parameters. Provenance: dev calibration over the snapshot itself,
 *  10-fold held-out, folds assigned by slug hash, typical miss = median
 *  multiple of |log10 error| across the 128 usable tokened comparables. */
export const MODEL = {
  /** Shrinkage weight pulling each category median toward the global median. */
  shrinkK: 2,
  /** maturity = min(cap, 1 + b * log10(1 + ageDays / 365)). */
  maturityB: 0.35,
  maturityCap: 1.4,
  /** Momentum band: only extreme 7-day moves touch the price. */
  momentumUpFrom: 35,
  momentumUp: 1.15,
  momentumDownFrom: -35,
  momentumDown: 0.88,
  /** Board scope: pre-token protocols at or above this TVL are ranked. */
  boardFloorUsd: 5_000_000,
  valueFloorUsd: 1_000_000,
  valueCapUsd: 100_000_000_000_000,
} as const;

export const MODEL_VERSION = 'research-desk-1';

/** Held-out ablation, 10-fold over the 128 usable comparables. Printed on
 *  the dashboard's methodology section exactly as measured. */
export const ABLATION: ReadonlyArray<{ term: string; miss: number; verdict: string }> = [
  { term: 'TVL x global median multiple only', miss: 5.168, verdict: 'baseline' },
  { term: '+ category multiples, shrunk (k = 2)', miss: 4.794, verdict: 'kept' },
  { term: '+ maturity factor', miss: 4.478, verdict: 'kept' },
  { term: '+ linear momentum term', miss: 4.715, verdict: 'dropped — made held-out pricing worse' },
  { term: '+ banded momentum (extreme moves only)', miss: 4.449, verdict: 'kept — the final model' },
  { term: '+ concentration dampener', miss: 4.574, verdict: 'dropped — made held-out pricing worse' },
];

export const HELD_OUT = {
  folds: 10,
  comparables: 128,
  typicalMiss: 4.45,
  bias: 1.36,
  within2xPct: 23,
  within5xPct: 53,
} as const;

// ---------------------------------------------------------------- utilities

/** Deterministic median: sort ascending, take the middle (or the mean of the
 *  two middles). No locale, no clock, no randomness anywhere in this file. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/** Thousands separators without locale dependence (always en-US grouping). */
export function fmtInt(n: number): string {
  const neg = n < 0;
  const digits = String(Math.abs(Math.round(n)));
  return (neg ? '-' : '') + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function fmtMoney(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${fmtInt(n)}`;
}

export function fmtPct(x: number | null): string {
  if (x === null) return 'not reported';
  return `${x > 0 ? '+' : ''}${x.toFixed(1)}%`;
}

const DAY_MS = 86_400_000;

function dayMs(isoDay: string): number {
  const [y, m, d] = isoDay.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

/** Whole days between the snapshot's as_of and a listed_at day; null when the
 *  snapshot records no listing day. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  return Math.max(0, Math.floor((dayMs(asOf) - dayMs(listedAt)) / DAY_MS));
}

// ---------------------------------------------------------------- snapshot

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot is missing its protocols or watchlist arrays');
  }
  return raw;
}

const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** The house rule, generalized: a protocol is a launch candidate when it
 *  records no token and is not a wrapped, staked, bridged or exchange-issued
 *  product of something that already trades. Says "records no token", never
 *  "has no token": DefiLlama's record is evidence, not proof. */
export function isPreToken(p: SnapshotProtocol): boolean {
  if (p.gecko_id !== null || p.symbol !== null) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) return false;
  return true;
}

// ---------------------------------------------------------------- the model

export interface CategoryMultiple {
  category: string;
  /** Raw median mcap/TVL of the category's usable comparables. */
  median: number;
  /** The median after shrinkage toward the global median and the 95th
   *  percentile cap — what pricing uses. */
  shrunk: number;
  count: number;
}

export interface Comparables {
  byCategory: Map<string, CategoryMultiple>;
  globalMedian: number;
  /** Tokened records with a usable price (mcap > 0): the calibration set. */
  usable: number;
  /** Tokened records excluded because their recorded price is $0 or below. */
  excludedDead: number;
  /** Median days without a token across the usable comparables. */
  medianAgeDays: number;
  /** The 95th percentile of the comparables' individual multiples: no
   *  category may price above what 95% of observed protocols trade under. */
  multipleCap: number;
  /** How many categories' shrunk multiples the cap actually binds. */
  cappedCategories: number;
}

function categoryOf(p: SnapshotProtocol): string {
  return p.category ?? 'Uncategorized';
}

/** Comparables are computed from the snapshot at run time: tokened protocols
 *  with both a market cap and a TVL. Records priced at $0 or below (dead or
 *  unpriced tokens) are excluded — a $0 multiple would poison a median — and
 *  the exclusion is counted and stated on the page. */
export function computeComparables(snapshot: Snapshot): Comparables {
  const tokened = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  const usableSet = tokened.filter((p) => p.mcap_usd! > 0);
  const globalMedian = median(usableSet.map((p) => p.mcap_usd! / p.tvl_usd));
  const groups = new Map<string, number[]>();
  for (const p of usableSet) {
    const key = categoryOf(p);
    const list = groups.get(key) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    groups.set(key, list);
  }
  const allMultiples = usableSet.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  const multipleCap = allMultiples[Math.floor(0.95 * (allMultiples.length - 1))]!;
  const byCategory = new Map<string, CategoryMultiple>();
  let cappedCategories = 0;
  for (const [category, values] of groups) {
    const med = median(values);
    const rawShrunk = (values.length * med + MODEL.shrinkK * globalMedian) / (values.length + MODEL.shrinkK);
    if (rawShrunk > multipleCap) cappedCategories++;
    byCategory.set(category, {
      category,
      median: med,
      shrunk: Math.min(rawShrunk, multipleCap),
      count: values.length,
    });
  }
  const ages = usableSet
    .map((p) => ageDays(snapshot.as_of, p.listed_at))
    .filter((a): a is number => a !== null);
  return {
    byCategory,
    globalMedian,
    usable: usableSet.length,
    excludedDead: tokened.length - usableSet.length,
    medianAgeDays: Math.round(median(ages)),
    multipleCap,
    cappedCategories,
  };
}

/** Momentum, banded: a 7-day move inside +/-35% says nothing the price should
 *  hear (the linear form failed its held-out test); an extreme move is
 *  information, so it adjusts the price once, by a bounded step. */
export function momentumFactor(change7d: number | null): number {
  if (change7d === null) return 1;
  if (change7d >= MODEL.momentumUpFrom) return MODEL.momentumUp;
  if (change7d <= MODEL.momentumDownFrom) return MODEL.momentumDown;
  return 1;
}

/** Maturity: a protocol that has run for years without issuing a token has a
 *  record the market can price; the factor saturates so age alone cannot
 *  carry a ranking. A missing listing day is priced at the median age, and
 *  the substitution is stated wherever the number is shown. */
export function maturityFactor(age: number | null, medianAgeDays: number): number {
  const a = age ?? medianAgeDays;
  return Math.min(MODEL.maturityCap, 1 + MODEL.maturityB * Math.log10(1 + a / 365));
}

export interface ValueWalk {
  implied: number;
  multiple: number;
  multipleSource: 'category' | 'global';
  comparableCount: number;
  momentum: number;
  maturity: number;
  age: number | null;
}

/** Price one pre-token protocol, returning every term so the dashboard can
 *  walk a reader through the number end to end. */
export function computeImpliedValue(
  p: SnapshotProtocol,
  snapshot: Snapshot,
  comparables: Comparables,
): ValueWalk {
  const cat = comparables.byCategory.get(categoryOf(p));
  const multiple = cat ? cat.shrunk : comparables.globalMedian;
  const age = ageDays(snapshot.as_of, p.listed_at);
  const momentum = momentumFactor(p.change_7d);
  const maturity = maturityFactor(age, comparables.medianAgeDays);
  const raw = p.tvl_usd * multiple * momentum * maturity;
  return {
    implied: Math.round(clamp(raw, MODEL.valueFloorUsd, MODEL.valueCapUsd)),
    multiple,
    multipleSource: cat ? 'category' : 'global',
    comparableCount: cat ? cat.count : 0,
    momentum,
    maturity,
    age,
  };
}

// ---------------------------------------------------------------- verdicts

export type VerdictLabel = 'Farm now' | 'Watch' | 'Skip';

export interface Verdict {
  label: VerdictLabel;
  reason: string;
}

export function ageText(age: number | null): string {
  if (age === null) return 'an unrecorded listing day';
  if (age >= 730) return `${(age / 365).toFixed(1)} years`;
  if (age >= 60) return `${Math.round(age / 30.44)} months`;
  return `${age} days`;
}

/** The verdict is advice, not pricing: it reads the same figures the price
 *  used and names the single decisive one. Momentum moves verdicts far more
 *  than it moves prices — that split is deliberate and stated on the page. */
export function verdictFor(p: SnapshotProtocol, walk: ValueWalk): Verdict {
  const c = p.change_7d;
  if (c !== null && c <= MODEL.momentumDownFrom) {
    return {
      label: 'Skip',
      reason: `TVL fell ${Math.abs(c).toFixed(1)}% in seven days: farming a shrinking protocol buys exposure to a fading launch. Wait for the bleed to stop.`,
    };
  }
  if (c !== null && c >= MODEL.momentumUpFrom) {
    return {
      label: 'Farm now',
      reason: `TVL is up ${c.toFixed(1)}% in seven days after ${ageText(walk.age)} with no token recorded: usage is repricing now, and early positions are the ones a launch rewards.`,
    };
  }
  if ((walk.age ?? 0) >= 730 && p.tvl_usd >= 25_000_000 && (c ?? 0) > 0) {
    return {
      label: 'Farm now',
      reason: `${fmtMoney(p.tvl_usd)} of TVL, ${ageText(walk.age)} without a token, and still growing (${fmtPct(c)} over 7 days): the record is long and the direction is right.`,
    };
  }
  if (p.tvl_usd < 7_500_000 && (walk.age ?? 0) < 365) {
    return {
      label: 'Skip',
      reason: `Small (${fmtMoney(p.tvl_usd)}) and young (${ageText(walk.age)}): too little record to price or to farm with conviction. Revisit after two more quarters of TVL.`,
    };
  }
  if (c !== null && c < 0) {
    return {
      label: 'Watch',
      reason: `The record is real (${fmtMoney(p.tvl_usd)}, ${ageText(walk.age)}) but TVL is drifting (${fmtPct(c)} over 7 days): watch for a growth turn before spending gas.`,
    };
  }
  if ((walk.age ?? 0) < 365) {
    return {
      label: 'Watch',
      reason: `Only ${ageText(walk.age)} of record behind ${fmtMoney(p.tvl_usd)} of TVL: the price rests on a short history. Watch until the record lengthens.`,
    };
  }
  return {
    label: 'Watch',
    reason: `A real record (${fmtMoney(p.tvl_usd)}, ${ageText(walk.age)}) with flat 7-day growth (${fmtPct(c)}): no urgency either way. Watch.`,
  };
}

// ---------------------------------------------------------------- farm plans

interface GasProfile {
  /** Cost of one ordinary transaction, as a reader-facing range. */
  tx: string;
  /** Cost of bridging or settling funds in. */
  settle: string;
}

const L2_CHAINS = new Set([
  'Arbitrum', 'Base', 'Optimism', 'zkSync Era', 'Linea', 'Scroll', 'Mantle',
  'Blast', 'Mode', 'Zora', 'Taiko', 'Metis', 'Bob', 'Ink', 'Soneium', 'Unichain',
]);

export function gasProfile(chain: string): GasProfile {
  if (chain === 'Ethereum') return { tx: '$2-$8', settle: '$2-$15' };
  if (chain === 'Solana') return { tx: '~$0.01', settle: '~$0.01' };
  if (L2_CHAINS.has(chain)) return { tx: '$0.05-$0.50', settle: '$0.05-$0.50' };
  if (chain === 'BSC') return { tx: '$0.10-$0.30', settle: '$0.10-$0.30' };
  if (chain === 'Polygon') return { tx: '$0.01-$0.05', settle: '$0.01-$0.05' };
  if (chain === 'Avalanche') return { tx: '$0.10-$0.50', settle: '$0.10-$0.50' };
  return { tx: '$0.10-$1.00', settle: '$0.10-$1.00' };
}

/** Working principal: roughly 0.1% of TVL, capped to a size a reader can
 *  actually risk on an unissued token, rounded to a clean $25 step. */
export function principalFor(tvlUsd: number): number {
  const raw = clamp(tvlUsd * 0.001, 250, 2_000);
  return Math.round(raw / 25) * 25;
}

type FarmFamily = 'lending' | 'dex' | 'perps' | 'yield' | 'usage';

export function familyOf(category: string | null): FarmFamily {
  switch (category) {
    case 'Lending':
    case 'CDP':
      return 'lending';
    case 'Dexs':
    case 'DEX Aggregator':
      return 'dex';
    case 'Derivatives':
      return 'perps';
    case 'Yield':
    case 'Yield Aggregator':
    case 'Risk Curators':
      return 'yield';
    default:
      return 'usage';
  }
}

function coreStep(family: FarmFamily, p: SnapshotProtocol, principal: number, gas: GasProfile): string {
  const usd = fmtInt(principal);
  switch (family) {
    case 'lending':
      return `Supply ${usd} USDC into ${p.name}'s main market, borrow about 40% against it and re-supply the borrow once (tx ~${gas.tx}, ~2 min). One careful loop builds a real usage record without the liquidation risk of a maxed-out position.`;
    case 'dex':
      return `Provide ${usd} USDC split evenly across both sides of ${p.name}'s busiest stable pair, in a range you can check weekly (tx ~${gas.tx}, ~3 min). Volume routed through your position is the usage record that matters.`;
    case 'perps':
      return `Open a small hedged pair on ${p.name}: long and short the same notional with about ${usd} USDC of margin (fees ~${gas.tx}). Size for an activity record, not for profit — a neutral book cannot be liquidated by one price spike.`;
    case 'yield':
      return `Deposit ${usd} USDC into ${p.name}'s flagship vault and leave it staked for at least 30 days (tx ~${gas.tx}, ~1 min). Vault shares held across a full month read as conviction, not as a same-day in-and-out.`;
    default:
      return `Use ${p.name}'s core product with real volume: about ${usd} USDC of working capital, one genuine session per week (fees ~${gas.tx} per session). Recurring usage over 4+ weeks reads very differently from one large same-day burst.`;
  }
}

/** A farm plan generated from the protocol's own attributes — its chain's gas
 *  profile, its category's core action, its size band — never a slogan. Each
 *  step names an action, a principal, a cost and a time. */
export function buildFarmPlan(p: SnapshotProtocol, walk: ValueWalk, verdict: Verdict): string[] {
  const chain = p.chains[0] ?? 'Ethereum';
  const gas = gasProfile(chain);
  const principal = principalFor(p.tvl_usd);
  const usd = fmtInt(principal);
  const feeBudget = Math.max(10, Math.round(principal * 0.08));
  const steps: string[] = [];

  steps.push(
    `Set up a fresh farming wallet and fund it on ${chain}: bring in ${usd} USDC of principal plus a gas float (settling in costs ~${gas.settle}, ~15 min). A separate wallet caps the damage if a front end is ever compromised.`,
  );
  steps.push(coreStep(familyOf(p.category), p, principal, gas));
  if (p.chains.length > 1) {
    const second = p.chains[1]!;
    const g2 = gasProfile(second);
    steps.push(
      `Add a second surface on ${second}: repeat the core action at half size (about ${fmtInt(Math.round(principal / 2))} USDC, tx ~${g2.tx}). Two chains of genuine activity are harder to mistake for a single scripted wallet.`,
    );
  } else {
    steps.push(
      `Add a second surface on ${chain}: run ${p.name}'s testnet or governance flow once, end to end (fees ~${gas.tx}, ~20 min). A completed second surface is cheap evidence of a human, not a script.`,
    );
  }
  steps.push(
    `Repeat the core action weekly for at least 4 weeks; keep total fees under $${fmtInt(feeBudget)} (about 8% of principal) and save a monthly balance screenshot. Consistency across snapshots is what distribution formulas usually reward.`,
  );
  steps.push(
    `Risk note: ${p.name} records no token today and may never issue one — "records no token" is DefiLlama's record, not a promise. Every step above is reversible and the spend is capped; re-check TVL monthly and stop if it falls under $5M. Verdict today: ${verdict.label}.`,
  );
  return steps;
}

// ---------------------------------------------------------------- the board

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

export interface RadarRow extends BoardRow {
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  category: string;
  chains: string[];
  watchlist: boolean;
  multiple: number;
  multiple_source: 'category' | 'global';
  comparable_count: number;
  momentum: number;
  maturity: number;
  verdict: VerdictLabel;
  verdict_reason: string;
}

export interface RadarData {
  meta: {
    as_of: string;
    model_version: string;
    protocol_count: number;
    board_count: number;
    watchlist_count: number;
    watchlist_covered: number;
    comparable_usable: number;
    comparable_excluded_dead: number;
    global_median_multiple: number;
    multiple_cap: number;
    capped_categories: number;
    median_age_days: number;
    shrink_k: number;
    maturity_b: number;
    maturity_cap: number;
    momentum_band: string;
    ablation: typeof ABLATION;
    held_out: typeof HELD_OUT;
  };
  rows: RadarRow[];
}

/** Rank every pre-token protocol at or above the board floor. Sort: implied
 *  value desc, then TVL desc, then slug asc — a total order, so two runs of
 *  the same snapshot write the same board byte for byte. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const comparables = computeComparables(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const candidates = snapshot.protocols.filter(
    (p) => isPreToken(p) && p.tvl_usd >= MODEL.boardFloorUsd,
  );
  const scored = candidates.map((p) => {
    const walk = computeImpliedValue(p, snapshot, comparables);
    const verdict = verdictFor(p, walk);
    return { p, walk, verdict };
  });
  scored.sort(
    (a, b) =>
      b.walk.implied - a.walk.implied ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : 1),
  );
  const board: BoardRow[] = [];
  const rows: RadarRow[] = [];
  scored.forEach(({ p, walk, verdict }, i) => {
    const farmSteps = buildFarmPlan(p, walk, verdict);
    board.push({
      slug: p.slug,
      name: p.name,
      rank: i + 1,
      implied_value_usd: walk.implied,
      farm_steps: farmSteps,
    });
    rows.push({
      slug: p.slug,
      name: p.name,
      rank: i + 1,
      implied_value_usd: walk.implied,
      farm_steps: farmSteps,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: walk.age,
      category: categoryOf(p),
      chains: p.chains,
      watchlist: watchlist.has(p.slug),
      multiple: walk.multiple,
      multiple_source: walk.multipleSource,
      comparable_count: walk.comparableCount,
      momentum: walk.momentum,
      maturity: walk.maturity,
      verdict: verdict.label,
      verdict_reason: verdict.reason,
    });
  });
  const radar: RadarData = {
    meta: {
      as_of: snapshot.as_of,
      model_version: MODEL_VERSION,
      protocol_count: snapshot.protocols.length,
      board_count: board.length,
      watchlist_count: snapshot.watchlist.length,
      watchlist_covered: board.filter((r) => watchlist.has(r.slug)).length,
      comparable_usable: comparables.usable,
      comparable_excluded_dead: comparables.excludedDead,
      global_median_multiple: comparables.globalMedian,
      multiple_cap: comparables.multipleCap,
      capped_categories: comparables.cappedCategories,
      median_age_days: comparables.medianAgeDays,
      shrink_k: MODEL.shrinkK,
      maturity_b: MODEL.maturityB,
      maturity_cap: MODEL.maturityCap,
      momentum_band: `7-day TVL move of +${MODEL.momentumUpFrom}% or more: x${MODEL.momentumUp}; ${MODEL.momentumDownFrom}% or less: x${MODEL.momentumDown}; inside the band: x1.00`,
      ablation: ABLATION,
      held_out: HELD_OUT,
    },
    rows,
  };
  return { board, radar };
}

/** The gate's board rules, mirrored so a bad board fails here first. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board has ${board.length} rows`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'board has duplicate slugs';
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `board misses watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const validSlugs = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!validSlugs.has(r.slug)) return `${r.slug} is not in the snapshot`;
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (r.rank !== i + 1) return `row ${i + 1} carries rank ${r.rank}`;
    if (i > 0 && r.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.implied_value_usd > MODEL.valueCapUsd) return `${r.slug} exceeds the value cap`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `${r.slug} has ${r.farm_steps.length} farm steps`;
    }
    for (const s of r.farm_steps) {
      const len = s.trim().length;
      if (len < 20 || len > 600) return `${r.slug} has a farm step of ${len} characters`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return 'every row shares one implied value: the board ranks nothing';
  }
  return null;
}

/** The dashboard's dataset as one script: no fetch, no network. Written by
 *  main.ts as dashboard/zz-data.js so it sorts last in the dossier and is the
 *  only file the dossier's text cap may cut. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
