// Turns an image into text, because the classifier and the board take text only.
import type { Usage } from "../../domain/usage.ts";

export interface Vision {
  describe(image: { base64: string; mimeType: string }, context?: string): Promise<{ text: string; usage: Usage }>;
}
