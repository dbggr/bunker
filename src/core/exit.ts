const SIGNALS: Record<number, string> = {
  1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 4: "SIGILL", 5: "SIGTRAP", 6: "SIGABRT", 7: "SIGBUS", 8: "SIGFPE", 9: "SIGKILL", 10: "SIGUSR1",
  11: "SIGSEGV", 12: "SIGUSR2", 13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM",
};

/** An exit code for humans: `139 (SIGSEGV)` when it is 128 + a signal, else the bare number. */
export function exitLabel(code: number): string {
  if (code < 128) return String(code);
  const n = code - 128;
  return `${code} (${SIGNALS[n] ?? `signal ${n}`})`;
}
