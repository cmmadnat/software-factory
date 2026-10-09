// TargetCatalog backed by factory.config.json. Adding a target updates the in-memory config that the git,
// gate and MR adapters already read from, then rewrites the file, keeping every other setting as it was.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { TargetCatalog } from "../../application/ports/targets.ts";
import type { TargetSpec } from "../../domain/target.ts";
import type { FactoryConfig } from "./file-config.ts";

// Store paths under the home dir as ~/… so the file stays portable between machines.
const tildify = (p: string) => (p.startsWith(homedir() + "/") ? `~${p.slice(homedir().length)}` : p);

export class FileTargetCatalog implements TargetCatalog {
  constructor(
    private readonly config: FactoryConfig,
    private readonly path: string,
  ) {}

  list(): TargetSpec[] {
    return Object.entries(this.config.targets).map(([name, t]) => ({ name, repo: t.repo, host: t.host, baseBranch: t.baseBranch, setup: t.setup, gate: t.gate }));
  }

  add({ name, ...t }: TargetSpec): void {
    const raw = JSON.parse(readFileSync(this.path, "utf8"));
    raw.targets = { ...raw.targets, [name]: { ...t, repo: tildify(t.repo) } };
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n");
    renameSync(tmp, this.path); // atomic: a crash never leaves a half-written config
    this.config.targets[name] = { ...t };
  }
}
