// M4 live smoke: mixed paste (Jira key + text + screenshot + vague text) → NormalizeIntake → PlanBatch → rows.
// Run from an interactive shell so ATLASSIAN_* (in ~/.zshrc) are loaded: zsh -lic 'npm run smoke:intake -- <png>'
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitPaste, type RawEntry } from "../src/domain/intake.ts";
import { createApp } from "../src/main.ts";

const png = process.argv[2];
const app = await createApp(join(mkdtempSync(join(tmpdir(), "sf-m4-")), "state.db"));
const entries: RawEntry[] = [
  ...splitPaste("ACME-1040"),
  ...splitPaste("Supplier list page in acme-app: the Export button is cut off on screens under 1280px."),
  ...(png ? [{ kind: "image" as const, mimeType: "image/png", base64: readFileSync(png).toString("base64"), name: "risk-tab.png" }] : []),
  ...splitPaste("make it faster"),
];

let t = Date.now();
const norm = await app.normalizeIntake.execute(entries);
console.log(`normalize: ${norm.items.length}/${entries.length} items in ${Date.now() - t}ms, $${norm.usage.costUsd.toFixed(4)}`);
for (const w of norm.warnings) console.log(`  warning: ${w}`);
for (const i of norm.items) console.log(`  [${i.kind} ${i.ref}] ${i.body.replace(/\s+/g, " ").slice(0, 220)}`);

t = Date.now();
const plan = await app.planBatch.execute("smoke-m4", norm.items);
console.log(`plan: ${plan.items.length} rows in ${Date.now() - t}ms`);
for (const i of plan.items)
  console.log(`  #${i.id} run=${i.run} ${i.type.padEnd(8)} ${i.target_repo.padEnd(9)} c${i.complexity} ${i.model.padEnd(17)} deps=${i.depends_on} | ${i.title}`);
for (const q of plan.questions) console.log(`  question for #${q.itemId}: ${q.question}`);
await app.close();
