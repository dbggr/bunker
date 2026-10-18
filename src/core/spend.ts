import { readFileSync, writeFileSync } from "node:fs";
import { readUserConfig } from "./user-config.ts";

export const DAY_MS = 24 * 3_600_000;
export const MONTH_MS = 30 * DAY_MS;

/** Optional caps in notional USD (what `claude -p` reports); absent means no cap. */
export interface SpendCaps {
  day?: number;
  month?: number;
}

interface Spend {
  at: number;
  usd: number;
}

const WINDOWS = [
  { window: "day", ms: DAY_MS, noun: "today", cap: (c: SpendCaps) => c.day },
  { window: "month", ms: MONTH_MS, noun: "this month", cap: (c: SpendCaps) => c.month },
] as const;

export function readSpend(file: string): Spend[] {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(raw) ? raw.filter((e) => typeof e?.at === "number" && typeof e?.usd === "number") : [];
  } catch {
    return [];
  }
}

const within = (file: string, ms: number) => readSpend(file).filter((e) => e.at > Date.now() - ms);

export const spentWithin = (file: string, ms: number): number => within(file, ms).reduce((a, e) => a + e.usd, 0);

/** Appends to the log, dropping entries older than the longest window. */
export function addSpend(file: string, usd: number): void {
  writeFileSync(file, JSON.stringify([...within(file, MONTH_MS), { at: Date.now(), usd }]));
}

/** When the oldest spend leaves the window far enough for spending to resume. */
export function capLiftsAt(file: string, ms: number, cap: number): number {
  const entries = within(file, ms).sort((a, b) => a.at - b.at);
  let total = entries.reduce((a, e) => a + e.usd, 0);
  for (const e of entries) {
    total -= e.usd;
    if (total < cap) return e.at + ms;
  }
  return Date.now();
}

export interface ExceededCap {
  window: "day" | "month";
  spent: number;
  cap: number;
  liftsAt: number;
}

export function exceededCaps(file: string, caps: SpendCaps): ExceededCap[] {
  const out: ExceededCap[] = [];
  for (const w of WINDOWS) {
    const cap = w.cap(caps);
    if (cap === undefined) continue;
    const spent = spentWithin(file, w.ms);
    if (spent >= cap) out.push({ window: w.window, spent, cap, liftsAt: capLiftsAt(file, w.ms, cap) });
  }
  return out;
}

/** `$5.00 of $20 today · $5.00 this month (no cap)` */
export function formatSpend(file: string, caps: SpendCaps): string {
  return WINDOWS.map((w) => {
    const cap = w.cap(caps);
    const spent = `$${spentWithin(file, w.ms).toFixed(2)}`;
    return cap === undefined ? `${spent} ${w.noun} (no cap)` : `${spent} of $${cap} ${w.noun}`;
  }).join(" · ");
}

/** `max-cost-day` / `max-cost-month` from ~/.config/bunker/config.toml; absent keys mean no cap. */
export async function loadSpendCaps(env: Record<string, string | undefined> = process.env): Promise<SpendCaps> {
  const parsed = await readUserConfig(env);
  const caps: SpendCaps = {};
  for (const [key, field] of [["max-cost-day", "day"], ["max-cost-month", "month"]] as const) {
    const v = parsed[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !(v > 0) || !Number.isFinite(v)) throw new Error(`config.toml: ${key} must be a positive number of US dollars`);
    caps[field] = v;
  }
  return caps;
}
