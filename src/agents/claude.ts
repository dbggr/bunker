import { join } from "node:path";
import { findSessionId, findUsageLimit, parseClaudeStreamLine } from "../core/events.ts";
import { COMMIT_INSTRUCTION, NO_ATTRIBUTION, parseClaudeJson, type Agent } from "./agent.ts";

export function claudeCode(opts: { model?: string; attribution?: boolean; json?: boolean } = {}): Agent {
  return {
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.json ? { parse: parseClaudeJson, parseLine: parseClaudeStreamLine } : {}),
    ...(opts.json ? { sessionId: findSessionId, usageLimit: findUsageLimit } : {}),
    command: (prompt, mode = "write", o) => [
      "claude",
      "-p",
      mode === "write" ? prompt + COMMIT_INSTRUCTION : prompt,
      "--dangerously-skip-permissions",
      ...(o?.resume ? ["--resume", o.resume] : o?.fork ? ["--resume", o.fork, "--fork-session"] : []),
      ...(opts.json ? ["--output-format", "stream-json", "--verbose"] : []),
      ...(opts.model ? ["--model", opts.model] : []),
      ...(opts.attribution ? [] : ["--settings", NO_ATTRIBUTION]),
    ],
  };
}

/** The only files of the real HOME the agent gets: what `claude` needs to authenticate. */
export const CLAUDE_AUTH_FILES = [".claude.json", join(".claude", ".credentials.json")];

/** Claude credentials: the agent needs them; code it wrote (verify) must not see them. */
export const CLAUDE_CREDENTIAL_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;
