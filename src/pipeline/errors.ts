import type { Usage } from "../agents/agent.ts";
import type { Session } from "../worktree/session.ts";
import type { ReviewRound } from "./review.ts";

/** Where a run stopped on the usage limit, so it can be picked up again. JSON-serialisable. */
export interface Pause {
  /** Epoch ms the limit resets, when the agent said. */
  resetAt?: number;
  role: "implementer" | "reviewer";
  /** 1-based review round. */
  round: number;
  sessionId?: string;
  /** Host copy of the session file. */
  sessionFile?: string;
  /** The review worktree and branch holding the work so far. */
  worktree: string;
  branch: string;
  /** With role `reviewer`: the implementer's output and session this round. */
  implOutput?: string;
  implSessionId?: string;
  rounds: ReviewRound[];
}

/** Thrown inside a step when the agent hit the usage limit. */
export class UsageLimit extends Error {
  constructor(readonly resetAt: number | undefined, readonly session: Session | undefined) {
    super("claude usage limit reached");
  }
}

/** A failed agent run; carries the usage already spent. */
export class AgentFailure extends Error {
  constructor(message: string, readonly usage?: Usage) {
    super(message);
  }
}
