// IssueTracker over the Atlassian remote MCP (one browser OAuth login; the grant persists in the Copilot runtime).
// The session may only call the read tools below — editJiraIssue/transitionJiraIssue exist on the server and
// must stay unreachable: the factory never moves a card.
import { z } from "zod";
import type { AssignedIssue, AssignedIssues } from "../../application/ports/assigned-issues.ts";
import type { Issue, IssueTracker } from "../../application/ports/issue-tracker.ts";
import type { CopilotRuntime } from "../copilot/runtime.ts";

export const READ_TOOLS = ["mcp:atlassian-getAccessibleAtlassianResources", "mcp:atlassian-getJiraIssue"];
// The single write tool ever exposed, and only to the comment call.
export const COMMENT_TOOLS = ["mcp:atlassian-getAccessibleAtlassianResources", "mcp:atlassian-addCommentToJiraIssue"];

// Read-only search for the triage inbox; still no edit/transition tool.
export const SEARCH_TOOLS = ["mcp:atlassian-getAccessibleAtlassianResources", "mcp:atlassian-searchJiraIssuesUsingJql"];
const ASSIGNED_LIMIT = 50;

const IssueSchema = z.object({
  key: z.string(),
  summary: z.string(),
  status: z.string(),
  description: z.string(),
  comments: z.array(z.object({ author: z.string(), body: z.string() })),
  attachments: z.array(
    z.object({ id: z.string(), filename: z.string(), mimeType: z.string(), size: z.number().nullable() }),
  ),
});

export class AtlassianMcpIssueTracker implements IssueTracker, AssignedIssues {
  constructor(
    private readonly runtime: CopilotRuntime,
    private readonly model: string,
    private readonly mcpUrl: string,
  ) {}

  async getIssue(key: string): Promise<Issue> {
    const { value } = await this.runtime.oneShot({
      model: this.model,
      mcpServers: { atlassian: { type: "http", url: this.mcpUrl, tools: ["*"] } },
      allowTools: READ_TOOLS,
      prompt: [
        `Fetch Jira issue ${key} with the Atlassian tools, including every comment and the attachment metadata.`,
        "Return description and comment bodies as plain text, verbatim (do not summarise or translate).",
        "Attachment id is the numeric id; size is in bytes, or null if unknown.",
      ].join(" "),
      schema: IssueSchema,
      timeoutMs: 240_000,
    });
    if (value.key.toUpperCase() !== key.toUpperCase()) throw new Error(`asked for ${key}, got ${value.key}`);
    return value;
  }

  async listAssigned(): Promise<AssignedIssue[]> {
    const { value } = await this.runtime.oneShot({
      model: this.model,
      mcpServers: { atlassian: { type: "http", url: this.mcpUrl, tools: ["*"] } },
      allowTools: SEARCH_TOOLS,
      prompt: [
        "Search Jira with the Atlassian tools using exactly this JQL:",
        "`assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC`.",
        `Return at most ${ASSIGNED_LIMIT} issues, in the order returned, each with its key, summary and status name.`,
      ].join(" "),
      schema: z.object({ issues: z.array(z.object({ key: z.string(), summary: z.string(), status: z.string() })) }),
      timeoutMs: 240_000,
    });
    return value.issues.slice(0, ASSIGNED_LIMIT);
  }

  async comment(key: string, body: string): Promise<void> {
    const { value } = await this.runtime.oneShot({
      model: this.model,
      mcpServers: { atlassian: { type: "http", url: this.mcpUrl, tools: ["*"] } },
      allowTools: COMMENT_TOOLS,
      prompt: `Add exactly this comment to Jira issue ${key}, verbatim, and nothing else:\n\n${body}`,
      schema: z.object({ commented: z.boolean(), error: z.string().nullable() }),
      timeoutMs: 180_000,
    });
    if (!value.commented) throw new Error(`could not comment on ${key}: ${value.error ?? "unknown"}`);
  }
}
