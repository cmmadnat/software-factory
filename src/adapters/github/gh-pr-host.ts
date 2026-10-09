// MergeRequestHost on GitHub via the gh CLI. Opens a pull request; never merges.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MergeRequest, MergeRequestHost } from "../../application/ports/merge-request-host.ts";
import type { FactoryConfig } from "../config/file-config.ts";

const run = promisify(execFile);

export function ghArgs(mr: MergeRequest): string[] {
  return ["pr", "create", "--head", mr.sourceBranch, "--base", mr.targetBranch, "--title", mr.title, "--body", mr.description];
}

export class GhPullRequestHost implements MergeRequestHost {
  constructor(private readonly config: FactoryConfig) {}

  async open(mr: MergeRequest): Promise<string> {
    const t = this.config.targets[mr.target];
    if (!t) throw new Error(`unknown target ${mr.target}`);
    const { stdout, stderr } = await run("gh", ghArgs(mr), { cwd: t.repo });
    const url = `${stdout}\n${stderr}`.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0];
    if (!url) throw new Error(`gh did not return a PR URL: ${(stdout + stderr).slice(0, 300)}`);
    return url;
  }
}

// Picks the host per target, so GitLab and GitHub repos can sit in one batch.
export class HostRouter implements MergeRequestHost {
  constructor(
    private readonly config: FactoryConfig,
    private readonly hosts: Record<"gitlab" | "github", MergeRequestHost>,
  ) {}

  open(mr: MergeRequest): Promise<string> {
    const t = this.config.targets[mr.target];
    if (!t) throw new Error(`unknown target ${mr.target}`);
    if (t.host === "local") throw new Error(`${mr.target} has no remote; there is nowhere to open a merge request`);
    return this.hosts[t.host].open(mr);
  }
}
