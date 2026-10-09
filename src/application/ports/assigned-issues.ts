// The Jira issues currently assigned to the user. Separate from IssueTracker: it is a read-only listing.
export interface AssignedIssue {
  key: string;
  summary: string;
  status: string;
}

export interface AssignedIssues {
  listAssigned(): Promise<AssignedIssue[]>;
}
