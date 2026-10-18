import type { IssueInfo } from "../../github/issues.ts";
import type { OnEvent } from "../../core/events.ts";
import type { Timeouts } from "../../sandboxes/exec.ts";
import type { IssueResult } from "../issue.ts";

/** What runIssueInner sets up once and every pipeline step reads: the issue, its repo/worktree, and the run's log and result helpers. */
export interface IssueRunContext {
  number: number;
  cwd: string;
  issue: IssueInfo;
  repo: string;
  branch: string;
  worktree: string;
  logPath: string;
  token: string | undefined;
  env: Record<string, string>;
  gitCfg: string[];
  remote: string;
  defaultBranch: string;
  gitCommonDir: string;
  onEvent: OnEvent | undefined;
  timeouts: Timeouts;
  log: (title: string, text?: string) => void;
  fail: (status: IssueResult["status"], extra?: Partial<IssueResult>) => IssueResult;
  finish: (status: IssueResult["status"], extra: Partial<IssueResult>) => IssueResult;
  failNote: (title: string, text: string) => void;
  fetchDefault: () => Promise<{ sha: string } | { error: string }>;
}
