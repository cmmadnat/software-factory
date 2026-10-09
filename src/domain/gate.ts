// The one hard gate on code: no NEW failures compared with the base commit. Staging already fails tests,
// so "suite is green" would block every agent on someone else's debt.

export interface GateRun {
  exitOk: boolean;
  failures: string[]; // stable failure signatures: test node ids, or normalised error lines
  output: string; // tail of the combined output, sent back to the agent when red
}

export interface GateVerdict {
  green: boolean;
  newFailures: string[];
  fixed: string[]; // baseline failures that no longer fail — reported, never required
}

export function judge(baseline: GateRun, current: GateRun): GateVerdict {
  const before = new Set(baseline.failures);
  const after = new Set(current.failures);
  const newFailures = [...after].filter((f) => !before.has(f));
  const fixed = [...before].filter((f) => !after.has(f));
  // A red exit with no recognisable signatures (crash, syntax error, collection error) is red
  // unless the baseline crashed the same way.
  const unexplainedCrash = !current.exitOk && current.failures.length === 0 && baseline.exitOk;
  return { green: newFailures.length === 0 && !unexplainedCrash, newFailures, fixed };
}

// Failure signatures from common tool output. Unknown formats fall back to exit code only.
export function failureSignatures(output: string): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/^(?:FAILED|ERROR) (\S+::\S+|\S+\.py)/gm)) out.add(`pytest:${m[1]}`); // pytest -rfE summary
  for (const m of output.matchAll(/^(?:Error: )?(\S+\.tsx?)[:(]\d+[:,]\d+\)?:? - error (TS\d+)/gm)) out.add(`tsc:${m[1]}:${m[2]}`); // ng build / tsc
  for (const m of output.matchAll(/^\s*(?:✘|✖|FAILED) (.+?) FAILED$/gm)) out.add(`karma:${m[1].trim()}`);
  for (const m of output.matchAll(/^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/gm)) out.add(`tap:${m[1].trim()}`); // node --test, other TAP
  return [...out].sort();
}
