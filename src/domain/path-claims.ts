// Two rows that may edit the same files must not run at the same time in the shared worktree.
// Conservative by design: a false "overlap" only serialises two rows; a missed one corrupts a batch.

import { matchesGlob } from "node:path";

// Whether a repo-relative file falls inside a row's claims. No claims = the whole repo. A file under a claim's
// literal directory counts too, matching how overlap is judged (by literal prefix), so the two rules agree.
export function withinClaims(file: string, claims: string[]): boolean {
  const f = file.replace(/^\.\//, "");
  return !claims.length || claims.some((g) => matchesGlob(f, g.replace(/^\.\//, "")) || (staticPrefix(g).endsWith("/") && f.startsWith(staticPrefix(g))));
}

// Literal part of a glob up to the first wildcard, e.g. "src/app/supplier/**" → "src/app/supplier/".
const staticPrefix = (glob: string) => glob.replace(/^\.\//, "").split(/[*?[{]/)[0];

export function globsOverlap(a: string, b: string): boolean {
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

export interface Claim {
  id: number;
  repo: string;
  paths: string[];
}

// Rows with no claimed paths are unknown, so they overlap everything in their repo.
export function claimsOverlap(a: Claim, b: Claim): boolean {
  if (a.repo !== b.repo) return false;
  if (!a.paths.length || !b.paths.length) return true;
  return a.paths.some((pa) => b.paths.some((pb) => globsOverlap(pa, pb)));
}

export function overlappingPairs(claims: Claim[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < claims.length; i++)
    for (let j = i + 1; j < claims.length; j++) if (claimsOverlap(claims[i], claims[j])) out.push([claims[i].id, claims[j].id]);
  return out;
}
