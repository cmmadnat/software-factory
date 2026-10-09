// Read a ticket (and later, comment the MR link). Never transitions: QA owns status.

export interface IssueAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number | null;
}

export interface Issue {
  key: string;
  summary: string;
  status: string;
  description: string;
  comments: { author: string; body: string }[];
  attachments: IssueAttachment[];
}

export interface IssueTracker {
  getIssue(key: string): Promise<Issue>;
  // The only write the factory makes to Jira: a comment (e.g. the MR link). It never transitions a card.
  comment(key: string, body: string): Promise<void>;
}

// Separate port: the MCP can't return binary content, so attachments come from a different adapter.
export interface AttachmentSource {
  download(attachment: IssueAttachment): Promise<{ base64: string; mimeType: string }>;
}
