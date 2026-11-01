// Decide whether a live Worker deployment is the commit and version a release check expected.
// Wrangler JSON shapes: `wrangler deployments status --json` and `wrangler versions list --json`.

export function activeVersionId(deployment) {
  const versions = deployment?.versions;
  if (!Array.isArray(versions) || versions.length === 0) return null;
  const full = versions.find((v) => v && v.percentage === 100) ?? versions[0];
  const id = full?.version_id ?? full?.versionId ?? null;
  return typeof id === "string" && id !== "" ? id : null;
}

export function previousVersionId(versions, activeId) {
  if (!activeId || !Array.isArray(versions)) return null;
  const rows = versions.filter((v) => v && typeof v.id === "string" && v.metadata && typeof v.metadata.created_on === "string");
  rows.sort((a, b) => a.metadata.created_on.localeCompare(b.metadata.created_on));
  const i = rows.findIndex((v) => v.id.toLowerCase() === activeId.toLowerCase());
  if (i <= 0) return null;
  return rows[i - 1].id;
}

function messagesOf(deployment, versionRow) {
  const bits = [];
  for (const src of [deployment?.annotations, versionRow?.annotations]) {
    if (!src || typeof src !== "object") continue;
    for (const key of ["workers/message", "workers/tag"]) {
      if (typeof src[key] === "string" && src[key] !== "" && src[key] !== "-") bits.push(src[key]);
    }
  }
  return bits.join("\n");
}

/** True when the deploy message names this commit (full sha, or a 7+ hex prefix as its own token). */
export function commitInMessage(commit, message) {
  const full = String(commit).toLowerCase();
  const msg = String(message).toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(full)) return false;
  if (msg.includes(full)) return true;
  for (let n = Math.min(full.length, 40); n >= 7; n--) {
    const prefix = full.slice(0, n);
    const re = new RegExp(`(?:^|[^0-9a-f])${prefix}(?:[^0-9a-f]|$)`);
    if (re.test(msg)) return true;
  }
  return false;
}

/**
 * @param {{ commit: string, version: string, deployment: unknown, versions: unknown }} input
 * @returns {{ status: "PASS" | "FAIL", reason: string, active: string | null, previous: string | null }}
 */
export function judgeRelease(input) {
  const active = activeVersionId(input.deployment);
  const previous = previousVersionId(input.versions, active);
  if (!active) return { status: "FAIL", reason: "no live deployment version", active, previous };
  if (active.toLowerCase() !== String(input.version).toLowerCase()) {
    return { status: "FAIL", reason: `live version ${active} is not the expected version`, active, previous };
  }
  const row = Array.isArray(input.versions)
    ? input.versions.find((v) => v && typeof v.id === "string" && v.id.toLowerCase() === active.toLowerCase())
    : null;
  const message = messagesOf(input.deployment, row);
  if (!commitInMessage(input.commit, message)) {
    return {
      status: "FAIL",
      reason: "deployment message does not name the commit; deploy with: npx wrangler deploy --message <sha>",
      active,
      previous,
    };
  }
  return { status: "PASS", reason: "live version and commit message match", active, previous };
}
