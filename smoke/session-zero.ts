// Session zero: prove the two model backends work before any factory code.
// Prints a plain works / doesn't-work list. Run: npm run smoke
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { OpenRouter } from "@openrouter/sdk";

type Check = { name: string; ok: boolean; detail: string };
const results: Check[] = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name} — ${detail}`);
};

async function copilot() {
  const client = new CopilotClient();
  try {
    await client.start();
    record("copilot: start runtime (logged-in user)", true, "started");
  } catch (e) {
    record("copilot: start runtime (logged-in user)", false, String(e));
    return;
  }

  let model: string | undefined;
  try {
    const models = await client.listModels();
    const ids = models.map((m: { id: string }) => m.id);
    model = ids.find((id) => /haiku/i.test(id)) ?? ids.find((id) => /mini|small/i.test(id)) ?? ids[0];
    record("copilot: listModels", ids.length > 0, `${ids.length} models; picked ${model}; all: ${ids.join(", ")}`);
  } catch (e) {
    record("copilot: listModels", false, String(e));
  }

  // Headless trivial task in a throwaway git repo.
  const dir = mkdtempSync(join(tmpdir(), "sf-smoke-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const eventKinds = new Map<string, number>();
  const usageSamples: unknown[] = [];
  try {
    const session = await client.createSession({
      model,
      workingDirectory: dir,
      onPermissionRequest: approveAll,
    });
    session.on((event: { type: string; data?: unknown }) => {
      eventKinds.set(event.type, (eventKinds.get(event.type) ?? 0) + 1);
      if (event.type === "assistant.usage" && usageSamples.length < 1) usageSamples.push(event.data);
    });
    const started = Date.now();
    const reply = await session.sendAndWait(
      { prompt: "Create a file hello.txt in the current directory containing exactly: factory ok. Then reply DONE." },
      180_000,
    );
    const file = join(dir, "hello.txt");
    const content = existsSync(file) ? readFileSync(file, "utf8").trim() : "(missing)";
    record(
      "copilot: headless session edits a file",
      content === "factory ok",
      `${Date.now() - started}ms; hello.txt=${JSON.stringify(content)}; reply=${JSON.stringify(reply?.data?.content?.slice(0, 80))}`,
    );

    // Structured output — the classifier path.
    const { z } = await import("zod");
    const row = await session.sendAndWait(
      "Classify this ticket: 'Login button misaligned on mobile Safari in acme-app'.",
      z.object({ type: z.enum(["bug", "feature", "refactor", "spike"]), repo: z.string(), complexity: z.enum(["1", "2", "3", "4", "5"]) }),
    );
    record("copilot: structured output (classifier path)", !!row, JSON.stringify(row));
    await session.disconnect();
  } catch (e) {
    record("copilot: headless session", false, String(e));
  }
  record("copilot: event kinds seen", eventKinds.size > 0, [...eventKinds].map(([k, n]) => `${k}×${n}`).join(", "));
  record(
    "copilot: per-turn usage data",
    usageSamples.length > 0,
    usageSamples.length ? JSON.stringify(usageSamples) : "no usage/quota/cost events observed",
  );
  await client.stop();
}

async function openrouter() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    record("openrouter: chat call", false, "OPENROUTER_API_KEY not set — skipped");
    return;
  }
  try {
    const res = await new OpenRouter({ apiKey }).chat.send({
      chatRequest: {
        model: "anthropic/claude-haiku-4.5",
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
        stream: false,
      },
    });
    if (!("choices" in res)) throw new Error("expected a non-streaming ChatResult");
    record("openrouter: chat call", true, `reply=${JSON.stringify(res.choices?.[0]?.message?.content)}; usage=${JSON.stringify(res.usage)}`);
  } catch (e) {
    record("openrouter: chat call", false, String(e));
  }
}

await copilot();
await openrouter();
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
