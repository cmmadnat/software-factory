// Branch names for published rows: fix/<KEY>-<slug> (Nat's convention), feat/… for features.
import type { Item } from "./batch.ts";

const PREFIX: Record<Item["type"], string> = { bug: "fix", feature: "feat", refactor: "refactor", spike: "spike" };

export const slug = (s: string, max = 40) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "") || "change";

export function branchName(item: Item, taken: Set<string> = new Set()): string {
  const key = item.source_kind === "jira" ? `${item.source_ref}-` : "";
  const base = `${PREFIX[item.type]}/${key}${slug(item.title)}`;
  // Two rows from one ticket can slug alike, or the name can already exist: suffix the row id (then -2, -3 …).
  if (!taken.has(base)) return base;
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}-r${item.id}` : `${base}-r${item.id}-${n}`;
    if (!taken.has(name)) return name;
  }
}

// Rows whose commits must come first on this row's branch: its dependencies, transitively, in board order.
export function stackFor(item: Item, all: Item[]): Item[] {
  const byId = new Map(all.map((i) => [i.id, i]));
  const seen = new Set<number>();
  const visit = (i: Item) => {
    for (const d of JSON.parse(i.depends_on) as number[]) {
      const dep = byId.get(d);
      if (dep && !seen.has(d)) {
        seen.add(d);
        visit(dep);
      }
    }
  };
  visit(item);
  return all.filter((i) => seen.has(i.id)).sort((a, b) => a.position - b.position);
}
