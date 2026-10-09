// GateRunner over shell commands from factory.config.json. Exit codes plus failure signatures parsed from
// the output; the application compares them with the baseline.
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import type { GateRunner } from "../../application/ports/gate.ts";
import { failureSignatures, type GateRun } from "../../domain/gate.ts";
import { gateCommands, type FactoryConfig } from "../config/file-config.ts";

const TIMEOUT_MS = 15 * 60_000;
const OUTPUT_KEEP = 16_000;

// Scope the quick gate to what the row touched: pytest files it changed, karma specs of the folders it changed.
export function scopeFromChanged(changed: string[]) {
  const tests = changed.filter((f) => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(f));
  const specDirs = [...new Set(changed.filter((f) => /^src\/.*\.ts$/.test(f)).map((f) => dirname(f)))];
  return { tests, specs: specDirs.map((d) => `${d}/**/*.spec.ts`) };
}

export class ShellGate implements GateRunner {
  constructor(private readonly config: FactoryConfig) {}

  async run(target: string, worktree: string, level: "quick" | "full", changed: string[]): Promise<GateRun> {
    const t = this.config.targets[target];
    if (!t) throw new Error(`unknown target ${target}`);
    let exitOk = true;
    let output = "";
    for (const cmd of gateCommands(t, level, scopeFromChanged(changed))) {
      const r = await sh(cmd, worktree);
      output += `$ ${cmd}\n${r.output.trimEnd()}\n[exit ${r.code}]\n`;
      if (r.code !== 0) exitOk = false;
    }
    return { exitOk, failures: failureSignatures(output), output: output.slice(-OUTPUT_KEEP) };
  }
}

function sh(cmd: string, cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", cmd], { cwd, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
    let out = "";
    const keep = (d: Buffer) => {
      out = (out + d.toString()).slice(-4 * OUTPUT_KEEP);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: out });
    });
  });
}
