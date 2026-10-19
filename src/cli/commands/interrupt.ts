import type { BunkerEvent } from "../../core/events.ts";
import { formatDuration } from "../../agents/agent.ts";

export interface InterruptOptions {
  /** Aborted by the first signal: stops new work and releases runs that only wait on GitHub. */
  ctl: AbortController;
  log: (line: string) => void;
  exit: (code: number) => void;
  /** Second signal: put one interrupted issue back (keep its work as a stale tag, relabel it). */
  requeue: (issue: number) => Promise<void>;
  /** Second signal: stop the agent containers. */
  stopContainers: () => void;
  /** How long a forced stop may spend putting issues back. Defaults to 4 s. */
  forceMs?: number;
  /** Seconds-level progress while waiting for the first stop. Defaults to 30 s; 0 turns it off. */
  progressMs?: number;
  /** A step is killed after this long; shown as a countdown. */
  stepTimeoutMs?: number;
  /** Tells the hub the watcher is stopping. */
  onStopping?: () => void;
  now?: () => number;
  /** The command that picks the work up again. Defaults to `bunker watch`. */
  resume?: string;
}

const WAITING = new Set(["waiting for merge", "awaiting review"]);

/** Two-stage Ctrl-C for `bunker watch`: the first finishes in-flight steps, the second stops now and re-queues. */
export function createInterrupt(o: InterruptOptions) {
  const now = o.now ?? Date.now;
  const running = new Map<number, { stage: string; since: number }>();
  const waiting = new Map<number, string>();
  const merged = new Set<number>();
  const requeued: number[] = [];
  let spentUsd = 0;
  let signals = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;

  const describe = (n: number, r: { stage: string; since: number }) => {
    const left = o.stepTimeoutMs === undefined ? "" : ` · step times out in ${formatDuration(Math.max(0, o.stepTimeoutMs - (now() - r.since)))}`;
    return `#${n} ${r.stage} ${formatDuration(now() - r.since)}${left}`;
  };

  const onEvent = (e: BunkerEvent) => {
    if (e.type === "result" && e.costUsd) spentUsd += e.costUsd;
    if (e.issue === undefined) return;
    if (e.type === "meta" && !running.has(e.issue) && !waiting.has(e.issue)) running.set(e.issue, { stage: "setup", since: e.at });
    if (e.type !== "stage" || !e.name) return;
    const n = e.issue;
    if (e.name === "merged") {
      running.delete(n);
      waiting.delete(n);
      merged.add(n);
    } else if (e.name === "failed" || e.name === "done") {
      running.delete(n);
      waiting.delete(n);
    } else if (WAITING.has(e.name)) {
      running.delete(n);
      waiting.set(n, e.name);
    } else {
      waiting.delete(n);
      if (running.get(n)?.stage !== e.name) running.set(n, { stage: e.name, since: e.at });
    }
    if (signals > 0 && !running.has(n)) o.log(`bunker: #${n} ${merged.has(n) ? "merged" : waiting.has(n) ? `${waiting.get(n)}; released to GitHub` : "finished"}`);
  };

  /** The lines printed on exit. `interrupted` is who the second Ctrl-C put back. */
  const summary = (): string[] => {
    const list = (xs: Iterable<number>) => [...xs].map((n) => `#${n}`).join(", ") || "none";
    return [
      "bunker: stopped. Summary of this session:",
      `  merged: ${list(merged)}`,
      `  interrupted (re-queued): ${list(requeued)}`,
      `  waiting on GitHub: ${list(waiting.keys())}`,
      `  spend: $${spentUsd.toFixed(2)}`,
      `  resume with: ${o.resume ?? "bunker watch"}`,
    ];
  };

  const stopTicker = () => ticker && clearInterval(ticker);

  const force = async () => {
    stopTicker();
    o.log("bunker: stopping now; putting interrupted issues back in the queue");
    o.stopContainers();
    const interrupted = [...running.keys()];
    const put = Promise.all(interrupted.map((n) => o.requeue(n).then(() => void requeued.push(n)).catch((e) => o.log(`bunker: could not re-queue #${n}: ${e instanceof Error ? e.message : e}`))));
    await Promise.race([put, new Promise((r) => setTimeout(r, o.forceMs ?? 4000))]);
    for (const l of summary()) o.log(l);
    o.exit(130);
  };

  return {
    onEvent,
    summary,
    /** Whether a first signal arrived (the stop is clean unless a second one follows). */
    get stopping() { return signals > 0; },
    signal(name = "SIGINT") {
      signals++;
      if (signals > 1) return force();
      o.ctl.abort();
      o.onStopping?.();
      o.log(`bunker: ${name} received; no new work will start`);
      for (const [n, r] of running) o.log(`  ${describe(n, r)} · finishing this step`);
      for (const [n, stage] of waiting) o.log(`  #${n} ${stage} · released (GitHub merges without bunker)`);
      if (running.size) {
        o.log("bunker: Ctrl-C again stops now (agent containers are killed and the issues put back in the queue)");
        const every = o.progressMs ?? 30_000;
        if (every > 0) {
          ticker = setInterval(() => {
            if (!running.size) return stopTicker();
            o.log(`bunker: still waiting for ${[...running].map(([n, r]) => describe(n, r)).join("; ")}`);
          }, every);
          ticker.unref?.();
        }
      }
      return undefined;
    },
    /** Call once the watch loop returned: stops the progress ticker and says how the session ended. */
    finish() {
      stopTicker();
      if (signals > 0) for (const l of summary()) o.log(l);
    },
  };
}
