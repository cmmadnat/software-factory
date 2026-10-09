// The set of repos the factory may work in, and a way to read a local checkout to suggest a new one.
import type { TargetSpec } from "../../domain/target.ts";

export interface TargetCatalog {
  list(): TargetSpec[];
  add(target: TargetSpec): void; // persisted and visible to every adapter immediately
}

export interface RepoInspection {
  repo: string; // the checkout's top-level directory
  name: string; // suggested target name
  remoteUrl: string | null;
  host: "gitlab" | "github" | "local" | null; // local when there is no origin remote
  branches: string[]; // branches on origin
  localBranches: string[];
  baseBranch: string | null; // suggested
  setup: string[];
  gate: { quick: string[]; full: string[] };
  notes: string[]; // what the suggestion was based on, or what's missing
}

export interface RepoInspector {
  inspect(path: string): Promise<RepoInspection>;
}
