// What Nat pastes, before it is normalised to text for the classifier.

export type RawEntry =
  | { kind: "text"; text: string }
  | { kind: "jira"; key: string }
  | { kind: "image"; mimeType: string; base64: string; name?: string };

const JIRA_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g;

// A paste made only of Jira keys (comma, space or newline separated) becomes one entry per key.
// Anything else is free text — a pasted conversation that merely mentions a key stays text.
export function splitPaste(text: string): RawEntry[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const keys = trimmed.match(JIRA_KEY) ?? [];
  const leftover = trimmed.replace(JIRA_KEY, "").replace(/[\s,;]+/g, "");
  if (keys.length && !leftover) return [...new Set(keys)].map((key) => ({ kind: "jira", key }));
  return [{ kind: "text", text: trimmed }];
}

export const isImageMime = (mime: string) => /^image\/(png|jpe?g|gif|webp)$/i.test(mime);

// Vision is cheap but not free: cap per Jira issue and skip huge files.
export const MAX_IMAGES_PER_ISSUE = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
