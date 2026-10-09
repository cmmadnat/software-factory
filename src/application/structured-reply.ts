// Read-only roles answer in prose and end with a JSON object; this pulls that object out and validates it.
// The last ```json fence wins, then the last bare {...} block, so an agent may think out loud first.
import { z, type ZodType } from "zod";
import type { Plan, Review } from "../domain/pipeline.ts";

export const PlanSchema: ZodType<Plan> = z.object({
  rootCause: z.string(),
  approach: z.string(),
  files: z.array(z.string()),
  testFiles: z.array(z.string()),
  testPlan: z.string(),
  risks: z.string(),
  subtasks: z.array(z.object({ id: z.string(), title: z.string(), files: z.array(z.string()), dependsOn: z.array(z.string()) })).optional(),
});

export const ReviewSchema: ZodType<Review> = z.object({
  verdict: z.enum(["approve", "changes_requested"]),
  comments: z.string(),
});

export const ResolveSchema = z.object({
  status: z.enum(["resolved", "question"]),
  summary: z.string(),
  question: z.string().optional(),
});
export type ResolveReply = z.infer<typeof ResolveSchema>;

export function parseReply<T>(reply: string | undefined, schema: ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  const text = reply ?? "";
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = [...fenced.reverse(), text.slice(text.lastIndexOf("\n{") + 1), text.slice(text.indexOf("{"))];
  let error = "no JSON object found in the reply";
  for (const c of candidates) {
    const end = c.lastIndexOf("}");
    if (end < 0) continue;
    try {
      const r = schema.safeParse(JSON.parse(c.slice(0, end + 1)));
      if (r.success) return { ok: true, value: r.data };
      error = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    } catch (e) {
      error = `invalid JSON: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { ok: false, error };
}
