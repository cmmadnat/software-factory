// AttachmentSource over Jira REST with an API token — the MCP can't return binary content.
// Credentials come from the process environment only (ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN).
import type { AttachmentSource, IssueAttachment } from "../../application/ports/issue-tracker.ts";

export class JiraRestAttachments implements AttachmentSource {
  private constructor(
    private readonly site: string,
    private readonly auth: string,
  ) {}

  // Null when the token isn't configured: intake still works, it just lists attachment names.
  static fromEnv(site: string, env: NodeJS.ProcessEnv = process.env): JiraRestAttachments | null {
    const email = env.ATLASSIAN_EMAIL;
    const token = env.ATLASSIAN_API_TOKEN;
    if (!email || !token) return null;
    return new JiraRestAttachments(site, Buffer.from(`${email}:${token}`).toString("base64"));
  }

  async download(a: IssueAttachment) {
    const res = await fetch(`https://${this.site}/rest/api/3/attachment/content/${encodeURIComponent(a.id)}`, {
      headers: { Authorization: `Basic ${this.auth}`, Accept: "*/*" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`attachment ${a.id} (${a.filename}): HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    return { base64: bytes.toString("base64"), mimeType: res.headers.get("content-type")?.split(";")[0] || a.mimeType };
  }
}
