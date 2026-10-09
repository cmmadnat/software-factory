// MergeRequestHost on GitLab via the glab CLI (already authenticated on this machine; spike R9).
// Runs in the target's main checkout so glab resolves the project from its remote.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MergeRequest, MergeRequestHost } from "../../application/ports/merge-request-host.ts";
import type { FactoryConfig } from "../config/file-config.ts";

const run = promisify(execFile);

export function glabArgs(mr: MergeRequest): string[] {
  return ["mr", "create", "--source-branch", mr.sourceBranch, "--target-branch", mr.targetBranch, "--title", mr.title, "--description", mr.description, "--yes"];
}

export class GlabMergeRequestHost implements MergeRequestHost {
  constructor(private readonly config: FactoryConfig) {}

  async open(mr: MergeRequest): Promise<string> {
    const t = this.config.targets[mr.target];
    if (!t) throw new Error(`unknown target ${mr.target}`);
    const { stdout, stderr } = await run("glab", glabArgs(mr), { cwd: t.repo });
    const url = `${stdout}\n${stderr}`.match(/https?:\/\/\S+\/merge_requests\/\d+/)?.[0];
    if (!url) throw new Error(`glab did not return an MR URL: ${(stdout + stderr).slice(0, 300)}`);
    return url;
  }
}
