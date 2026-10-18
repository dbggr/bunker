/** Token counts of an agent call (or of one message of it). */
export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** USD per million tokens. */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Rough list prices by model family, first match wins. Only for the running estimate: the exact cost is the `result`'s `total_cost_usd`. */
const PRICES: [RegExp, Price][] = [
  [/opus-4(-1)?(-\d{8})?(?![\w-])/, { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  [/opus/, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  [/haiku-3/, { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
  [/haiku/, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
];

/** Estimated USD for `t` on `model`; undefined for a model without a price (show tokens only). */
export function estimateCostUsd(model: string | undefined, t: Tokens): number | undefined {
  const p = model && PRICES.find(([re]) => re.test(model))?.[1];
  if (!p) return undefined;
  return (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite) / 1e6;
}

export const addTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

export const noTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** `1.2k` / `3.4M` */
export function formatTokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}
