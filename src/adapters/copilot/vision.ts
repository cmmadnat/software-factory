// Vision on the Copilot subscription: a no-tools one-shot with the image as a blob attachment.
import type { Vision } from "../../application/ports/vision.ts";
import type { CopilotRuntime } from "./runtime.ts";

const PROMPT = (context?: string) =>
  [
    context ?? "An image attached to a software work item.",
    "Describe it for a developer who cannot see it, in at most 4 sentences: which screen or document it is,",
    "the visible problem or requirement, and any exact labels, error text, or numbers that matter.",
  ].join(" ");

export class CopilotVision implements Vision {
  constructor(
    private readonly runtime: CopilotRuntime,
    private readonly model: string,
  ) {}

  async describe(image: { base64: string; mimeType: string }, context?: string) {
    const { value, usage } = await this.runtime.oneShot({
      model: this.model,
      prompt: PROMPT(context),
      attachments: [{ type: "blob", data: image.base64, mimeType: image.mimeType }],
    });
    return { text: value.trim(), usage };
  }
}
