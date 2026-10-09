// Dependency rule: every import points inward. domain ← application ← adapters/ui ← main.
// A violation fails `npm test`, so layering can't erode one convenient import at a time.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";

const SRC = resolve(import.meta.dirname, "../src");
type Layer = "domain" | "application" | "adapters" | "ui" | "main";

const layerOf = (file: string): Layer => {
  const top = relative(SRC, file).split("/")[0];
  return top === "main.ts" ? "main" : (top as Layer);
};

// Which layers each layer may import, and which bare (package / node:) specifiers it may use.
const RULES: Record<Layer, { layers: Layer[]; bare: (spec: string) => boolean }> = {
  domain: { layers: ["domain"], bare: (s) => s === "node:path" },
  application: { layers: ["domain", "application"], bare: (s) => s === "zod" },
  adapters: { layers: ["domain", "application", "adapters"], bare: () => true },
  ui: { layers: ["domain", "application", "ui"], bare: () => true }, // outermost driving adapter: may use node:http etc., never adapters
  main: { layers: ["domain", "application", "adapters", "ui", "main"], bare: () => true },
};

export function violation(fromFile: string, spec: string): string | null {
  const from = layerOf(fromFile);
  const rule = RULES[from];
  if (!spec.startsWith(".")) return rule.bare(spec) ? null : `${from} may not import package "${spec}"`;
  const target = resolve(dirname(fromFile), spec);
  if (!target.startsWith(SRC + "/")) return `${from} imports outside src: ${spec}`;
  const to = layerOf(target);
  return rule.layers.includes(to) ? null : `${from} → ${to} (${spec})`;
}

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );

const imports = (src: string) => [...src.matchAll(/^\s*(?:import|export)[^'"]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm)].map((m) => m[1] ?? m[2]);

test("architecture: every import in src/ points inward", () => {
  const found = files(SRC).flatMap((f) =>
    imports(readFileSync(f, "utf8"))
      .map((spec) => violation(f, spec))
      .filter((v): v is string => v !== null)
      .map((v) => `${relative(SRC, f)}: ${v}`),
  );
  assert.deepEqual(found, []);
});

test("architecture: the rule actually catches outward imports", () => {
  const d = join(SRC, "domain/x.ts");
  const a = join(SRC, "application/x.ts");
  assert.match(violation(d, "../application/ports/batch-repo.ts")!, /domain → application/);
  assert.match(violation(d, "node:fs")!, /package "node:fs"/);
  assert.match(violation(a, "../adapters/sqlite/batch-repo.ts")!, /application → adapters/);
  assert.match(violation(a, "@github/copilot-sdk")!, /package/);
  assert.match(violation(join(SRC, "ui/x.ts"), "../adapters/copilot/runtime.ts")!, /ui → adapters/);
  assert.equal(violation(join(SRC, "adapters/x/y.ts"), "../../domain/usage.ts"), null);
});
