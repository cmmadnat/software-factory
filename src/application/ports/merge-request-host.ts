// Opens a merge request for a pushed branch. Never merges: merging is Nat's checkpoint.

export interface MergeRequest {
  target: string; // factory target (which repo)
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}

export interface MergeRequestHost {
  open(mr: MergeRequest): Promise<string>; // the MR URL
}
