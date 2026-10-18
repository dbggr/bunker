import type { Agent } from "./agent.ts";

type Env = Record<string, string | undefined>;

export type ModelRole = "implementer" | "reviewer" | "auditor";

/** What is shown when no model is configured: claude gets no `--model` and uses the account default. */
export const DEFAULT_MODEL_LABEL = "Claude default";

export const modelLabel = (agent: Pick<Agent, "model">): string => agent.model || DEFAULT_MODEL_LABEL;

/**
 * Model per role. Precedence, per role: role flag > `--model` > role env (`BUNKER_<ROLE>_MODEL`) > `BUNKER_MODEL` > `models.<role>` > `models.default` of .bunker/config.toml.
 * A role with no model is absent: claude then runs with its own default.
 */
export function resolveModels(
  flags: { model?: string | undefined; "implementer-model"?: string | undefined; "reviewer-model"?: string | undefined; "auditor-model"?: string | undefined },
  env: Env = process.env,
  config: { implementer?: string; reviewer?: string; auditor?: string; default?: string } = {},
): Partial<Record<ModelRole, string>> {
  const out: Partial<Record<ModelRole, string>> = {};
  for (const role of ["implementer", "reviewer", "auditor"] as const) {
    const m = flags[`${role}-model`] || flags.model || env[`BUNKER_${role.toUpperCase()}_MODEL`] || env.BUNKER_MODEL || config[role] || config.default;
    if (m) out[role] = m;
  }
  return out;
}
