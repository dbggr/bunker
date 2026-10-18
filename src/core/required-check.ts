export type Read = { code: number; out: string; err: string };

export type RequiredCheck = { state: "required" } | { state: "none" } | { state: "unreadable"; detail: string };

/**
 * Whether the default branch requires a status check, from its rulesets or classic branch protection.
 * Classic protection needs admin read access: a 403, or a 404 that isn't "not protected", means "can't tell", never "none".
 * `rules` is a failed ruleset read only when the caller lets it fall through; the callers report that themselves.
 */
export async function requiredCheck(readRules: () => Promise<Read>, readProtection: () => Promise<Read>): Promise<RequiredCheck & { rulesFailed?: Read }> {
  const rules = await readRules();
  if (rules.code !== 0) return { state: "unreadable", detail: rules.err.trim(), rulesFailed: rules };
  try {
    const list = JSON.parse(rules.out) as { type?: string; parameters?: { required_status_checks?: unknown[] } }[];
    if (list.some((r) => r.type === "required_status_checks" && (r.parameters?.required_status_checks?.length ?? 0) > 0)) return { state: "required" };
  } catch {}
  const prot = await readProtection();
  if (prot.code !== 0) {
    const text = `${prot.err}${prot.out}`.trim();
    // GitHub answers 404 with one of these when the branch (or its status-check rule) is genuinely unprotected.
    if (/branch not protected|required status checks not enabled/i.test(text)) return { state: "none" };
    return { state: "unreadable", detail: text };
  }
  try {
    const p = JSON.parse(prot.out) as { contexts?: unknown[]; checks?: unknown[] };
    if ((p.contexts?.length ?? 0) > 0 || (p.checks?.length ?? 0) > 0) return { state: "required" };
  } catch {}
  return { state: "none" };
}
