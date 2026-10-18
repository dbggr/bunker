import { $ } from "bun";
import { MAINTAINER_ROLES } from "./labeler.ts";
import type { IssueInfo } from "./issues.ts";

/** Authors whose issue body is shown unfenced; anyone else can open an issue on a public repo. */
export const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
/** Associations worth a permission lookup before trusting a comment. */
const MAYBE_TRUSTED = new Set(["MEMBER", "COLLABORATOR"]);

/**
 * Sets `trusted` on each comment and `bodyTrusted` on the issue: only the repo owner and users with admin/maintain permission
 * count (a read/triage collaborator does not). Fails closed when the permission lookup fails. The body needs `author`.
 */
export async function markTrust(info: Pick<IssueInfo, "author" | "comments" | "bodyTrusted">, cwd: string, env: Record<string, string | undefined>): Promise<void> {
  const isIdentity = (login: string | undefined) => !!login && (login.endsWith("[bot]") || login === env.BUNKER_IDENTITY_LOGIN);
  const cache = new Map<string, Promise<boolean>>();
  const maintainer = (login: string | undefined) => {
    // bunker's own identity is never the maintainer, whatever its association or permission
    if (!login || isIdentity(login)) return Promise.resolve(false);
    let p = cache.get(login);
    if (!p) {
      p = (async () => {
        const perm = await $`gh api repos/{owner}/{repo}/collaborators/${login}/permission --jq .role_name`.cwd(cwd).env(env as Record<string, string>).nothrow().quiet();
        return perm.exitCode === 0 && MAINTAINER_ROLES.has(perm.stdout.toString().trim());
      })();
      cache.set(login, p);
    }
    return p;
  };
  info.bodyTrusted = await maintainer(info.author?.login);
  await Promise.all((info.comments ?? []).map(async (c) => {
    const assoc = c.authorAssociation ?? "";
    c.trusted = (assoc === "OWNER" && !isIdentity(c.author?.login)) || (MAYBE_TRUSTED.has(assoc) && (await maintainer(c.author?.login)));
  }));
}
