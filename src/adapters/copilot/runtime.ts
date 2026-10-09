// AgentRuntime on the Copilot SDK, billed to the Copilot subscription via the logged-in CLI user.
import { CopilotClient, approveAll, type CopilotSession } from "@github/copilot-sdk";
import type { ZodType } from "zod";
import type { AgentOptions, AgentRuntime, AgentSession, TurnResult } from "../../application/ports/agent-runtime.ts";
import { checkTool, withGateGitEnv } from "../../domain/tool-policy.ts";
import { addUsage, usdFromNanoAiu, zeroUsage, type Usage } from "../../domain/usage.ts";

type UsageEventData = {
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  copilotUsage?: { totalNanoAiu?: number };
};

export function usageFromEvent(d: UsageEventData, usdPerAiu: number): Usage {
  const nanoAiu = d.copilotUsage?.totalNanoAiu ?? 0;
  return {
    tokensIn: d.inputTokens ?? 0,
    tokensOut: d.outputTokens ?? 0,
    premiumRequests: d.cost ?? 0,
    nanoAiu,
    costUsd: usdFromNanoAiu(nanoAiu, usdPerAiu),
  };
}

export interface OneShotOptions {
  model: string;
  prompt: string;
  attachments?: { type: "blob"; data: string; mimeType: string; displayName?: string }[];
  mcpServers?: Record<string, { type: "http"; url: string; tools: string[] }>;
  allowTools?: string[];
  timeoutMs?: number;
}

class CopilotAgent implements AgentSession {
  private turnUsage = zeroUsage();
  private budgetTripped = false;

  constructor(
    private readonly session: CopilotSession,
    private readonly opts: AgentOptions,
    usdPerAiu: number,
  ) {
    session.on((event: { type: string; data?: unknown }) => {
      opts.onEvent?.({ kind: event.type, data: event.data });
      if (event.type !== "assistant.usage") return;
      this.turnUsage = addUsage(this.turnUsage, usageFromEvent(event.data as UsageEventData, usdPerAiu));
      if (opts.onUsage && !opts.onUsage(this.turnUsage) && !this.budgetTripped) {
        this.budgetTripped = true;
        void session.abort();
      }
    });
  }

  get id() {
    return this.session.sessionId;
  }

  async send(prompt: string, timeoutMs = 30 * 60_000): Promise<TurnResult> {
    this.turnUsage = zeroUsage();
    this.budgetTripped = false;
    try {
      const reply = await this.session.sendAndWait({ prompt }, timeoutMs);
      const outcome = this.budgetTripped ? "budget" : "idle";
      return { reply: reply?.data?.content, usage: this.turnUsage, outcome };
    } catch (e) {
      const msg = String(e);
      const outcome = this.budgetTripped ? "budget" : /timeout/i.test(msg) ? "timeout" : /abort/i.test(msg) ? "aborted" : "error";
      return { reply: undefined, usage: this.turnUsage, outcome, error: msg };
    }
  }

  abort() {
    return this.session.abort();
  }

  close() {
    return this.session.disconnect();
  }
}

export class CopilotRuntime implements AgentRuntime {
  readonly backend = "copilot" as const;
  private readonly client = new CopilotClient({
    env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !e[0].startsWith("GIT_CONFIG_"))),
  });

  constructor(private readonly usdPerAiu: number) {}

  start() {
    return this.client.start();
  }

  async models(): Promise<string[]> {
    return (await this.client.listModels()).map((m) => m.id);
  }

  async startAgent(opts: AgentOptions): Promise<AgentSession> {
    return new CopilotAgent(await this.client.createSession(this.sessionConfig(opts)), opts, this.usdPerAiu);
  }

  async resumeAgent(sessionId: string, opts: AgentOptions): Promise<AgentSession> {
    return new CopilotAgent(await this.client.resumeSession(sessionId, this.sessionConfig(opts)), opts, this.usdPerAiu);
  }

  private sessionConfig(opts: AgentOptions) {
    return {
      model: opts.model,
      workingDirectory: opts.workingDirectory,
      systemMessage: opts.instructions ? { mode: "append" as const, content: opts.instructions } : undefined,
      // Approval is delegated to the allowlist hook below, which runs first and can deny.
      onPermissionRequest: approveAll,
      hooks: {
        onPreToolUse: (input: { toolName: string; toolArgs: unknown }) => {
          const d = checkTool(input.toolName, input.toolArgs, opts.workingDirectory, opts.writablePaths, opts.readOnly);
          if (d.allow) {
            const modifiedArgs = withGateGitEnv(input.toolArgs);
            return modifiedArgs === input.toolArgs ? undefined : { modifiedArgs };
          }
          opts.onEvent?.({ kind: "policy.denied", data: { tool: input.toolName, reason: d.reason } });
          return { permissionDecision: "deny" as const, permissionDecisionReason: d.reason };
        },
      },
    };
  }

  structured<T>(prompt: string, schema: ZodType<T>, model: string): Promise<{ value: T; usage: Usage }> {
    return this.oneShot({ model, prompt, schema });
  }

  // Adapter-internal: one throwaway session, one prompt, usage summed. Vision and the Jira MCP adapter build on it.
  // Tools are off unless allowlisted, so a one-shot can never wander into bash or file edits.
  async oneShot<T>(opts: OneShotOptions & { schema: ZodType<T> }): Promise<{ value: T; usage: Usage }>;
  async oneShot(opts: OneShotOptions): Promise<{ value: string; usage: Usage }>;
  async oneShot<T>(opts: OneShotOptions & { schema?: ZodType<T> }): Promise<{ value: T | string; usage: Usage }> {
    let usage = zeroUsage();
    const session = await this.client.createSession({
      model: opts.model,
      availableTools: opts.allowTools ?? [],
      mcpServers: opts.mcpServers,
      onPermissionRequest: approveAll,
    });
    session.on((event: { type: string; data?: unknown }) => {
      if (event.type === "assistant.usage") usage = addUsage(usage, usageFromEvent(event.data as UsageEventData, this.usdPerAiu));
    });
    const message = { prompt: opts.prompt, attachments: opts.attachments };
    const timeout = opts.timeoutMs ?? 120_000;
    try {
      if (opts.schema) return { value: await session.sendAndWait(message, opts.schema, timeout), usage };
      const reply = await session.sendAndWait(message, timeout);
      return { value: reply?.data?.content ?? "", usage };
    } finally {
      await session.disconnect();
    }
  }

  async stop() {
    await this.client.stop();
  }
}
