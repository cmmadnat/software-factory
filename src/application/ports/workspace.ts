// A session's git worktree: one per (item, target repo), on its own session branch. The session's agents share
// it across every turn; separate items never share one.

export interface Workspace {
  // Create (or reopen, after a crash or for a later turn) the session's worktree and run the target's setup
  // commands. A new worktree starts off the target's base branch, or off session `from`'s branch on the same
  // target when this item depends on it, so the dependency's commits are already there.
  prepare(itemId: number, target: string, from?: number): Promise<string>;
  // Uncommitted changed paths in the worktree, repo-relative.
  changedFiles(worktree: string): Promise<string[]>;
  // Commit exactly these paths with a `Factory-Item: <itemId>` trailer. Serialised per worktree; returns the
  // commit sha, or null when none of the paths had changes.
  commit(worktree: string, itemId: number, message: string, paths: string[]): Promise<string | null>;
  // The session's committed change against its target's base branch (what the reviewer reads).
  sessionDiff(itemId: number, target: string): Promise<string>;
  // The session's committed change to one repo-relative file against the base branch; '' when the session
  // branch does not exist yet or the file is unchanged.
  fileDiff(itemId: number, target: string, path: string): Promise<string>;
  // Cut `branch` off the target's freshly fetched base branch, cherry-pick every commit of the item's session
  // branch (which includes stacked dependencies' commits) — in effect a rebase — and push it when the target
  // has a remote. With `verify`, the target's setup runs in the new tree and verify is awaited before the push;
  // if it throws, nothing is pushed. Throws PublishConflict on a conflict. A failure leaves nothing behind.
  // Branch names starting with `prefix` that already exist in the target's repo or on its origin.
  branchesLike(target: string, prefix: string): Promise<Set<string>>;
  publishBranch(itemId: number, target: string, branch: string, verify?: ShipCheck): Promise<{ pushed: boolean }>;
  // A throwaway worktree (setup done) detached at `sha` on the target, for measuring a baseline there.
  snapshot(target: string, sha: string): Promise<{ worktree: string; dispose(): Promise<void> }>;
}

// Landing a local card's branch on the base branch (kept apart from Workspace: only the Merge action needs it).
export interface BranchMerger {
  // Land `branch` on the target's base branch in the main checkout: fast-forward when possible, otherwise a
  // merge commit. The merge is built and `verify`-ed in a throwaway worktree; the base branch moves (always
  // with --ff-only, to that already-checked commit) only if verify passes. Throws MergeRefused when the main
  // checkout has uncommitted changes, is not on the base branch, or the merge conflicts. Local targets only.
  mergeBranch(target: string, branch: string, verify?: ShipCheck): Promise<{ sha: string; fastForward: boolean }>;
  // The main checkout's path of a local target, and its uncommitted changed paths (git status --porcelain lines).
  checkoutPath(target: string): string;
  checkoutChanges(target: string): Promise<string[]>;
}

// The check before a push: the rebased tree, the base commit it sits on, and the files it changes.
export type ShipCheck = (worktree: string, ctx: { baseSha: string; changed: string[] }) => Promise<void>;

export class PublishConflict extends Error {}
export class MergeRefused extends Error {}
// commit() refuses (after unstaging) when a committed file has conflict markers; publishBranch and mergeBranch
// refuse a tree that has them before the gate runs. The message names file:line.
export class ConflictMarkerFound extends Error {}
