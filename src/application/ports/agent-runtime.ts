// The backend-neutral seam. Copilot implements it first; OpenRouter later for models Copilot lacks.
import type { ZodType } from "zod";
import type { Usage } from "../../domain/usage.ts";

export interface AgentEvent {
  kind: string;
  data: unknown;
}

export interface TurnResult {
  reply: string | undefined;
  usage: Usage;
  // 'budget' = the runner's per-turn ceiling tripped and the turn was aborted mid-flight.
  outcome: "idle" | "aborted" | "budget" | "error" | "timeout";
  error?: string;
}

export interface AgentOptions {
  model: string;
  workingDirectory: string;
  // Globs (relative to workingDirectory) the agent may write; empty = anywhere inside the worktree.
  writablePaths?: string[];
  // Planner and reviewer: no file writes and no mutating shell commands.
  readOnly?: boolean;
  instructions?: string;
  // Called on every model call; return false to abort the turn (per-turn budget).
  onUsage?: (turnSoFar: Usage) => boolean;
  onEvent?: (e: AgentEvent) => void;
}

export interface AgentSession {
  readonly id: string;
  send(prompt: string, timeoutMs?: number): Promise<TurnResult>;
  abort(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentRuntime {
  readonly backend: "copilot" | "openrouter";
  start(): Promise<void>;
  models(): Promise<string[]>;
  startAgent(opts: AgentOptions): Promise<AgentSession>;
  // Reattach to a session after the process died; the transcript and any finished tool work are kept.
  resumeAgent(sessionId: string, opts: AgentOptions): Promise<AgentSession>;
  // One-shot structured output with no tools — the classifier path.
  structured<T>(prompt: string, schema: ZodType<T>, model: string): Promise<{ value: T; usage: Usage }>;
  stop(): Promise<void>;
}
