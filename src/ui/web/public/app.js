// Kanban page: one card per session. Plain DOM; every action goes straight to the API and the page re-renders
// from the server's board, so what you see is what the runner did. Live updates arrive over one SSE stream.
const $ = (sel) => document.querySelector(sel);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
};

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

function toast(msg, kind = "error") {
  // An open <dialog> sits in the top layer above toasts, so show its errors inside it.
  if ($("#repos").open && kind === "error") {
    $("#repo-error").textContent = msg;
    $("#repo-error").hidden = false;
    return;
  }
  const t = h("div", { class: `alert alert-${kind} text-sm max-w-md` }, msg);
  $("#toast").append(t);
  setTimeout(() => t.remove(), 6000);
}

// Run an action, report its error, and refresh what it changed.
async function act(fn, okMsg, clearEl) {
  try {
    await fn();
    if (clearEl) clearEl.value = ""; // a sent draft must not be restored by the re-render
    if (okMsg) toast(okMsg, "success");
  } catch (e) {
    toast(e.message);
  }
  await refreshAll();
}

let meta = { targets: [], models: [] };
const entries = []; // intake: { kind: "paste", text } | { kind: "image", mimeType, base64, name, url }
// Under a cent reads "<$0.01", never "$0.00": that run was cheap, not free.
const money = (n) => (n > 0 && n < 0.005 ? "<$0.01" : `$${n.toFixed(2)}`);

// ---------- intake ----------
function renderEntries() {
  $("#entries").replaceChildren(
    ...entries.map((e, i) =>
      h("li", { class: "list-row py-2 items-center" },
        h("span", { class: "badge badge-sm" }, e.kind === "image" ? "image" : /^\s*([A-Z][A-Z0-9]+-\d+[\s,;]*)+$/.test(e.text) ? "jira" : "text"),
        e.kind === "image" ? h("div", { class: "flex gap-2 items-center" }, h("img", { class: "thumb", src: e.url, alt: e.name }), h("span", { class: "text-xs opacity-70" }, e.name))
          : h("div", { class: "text-sm whitespace-pre-wrap line-clamp-3" }, e.text),
        h("button", { class: "btn btn-ghost btn-xs", "aria-label": "Remove", onclick: () => { entries.splice(i, 1); renderEntries(); } }, "✕"),
      )),
  );
  $("#plan").disabled = !entries.length && !$("#paste-text").value.trim();
}

function addText() {
  const text = $("#paste-text").value.trim();
  if (!text) return;
  entries.push({ kind: "paste", text });
  $("#paste-text").value = "";
  renderEntries();
}

async function addImage(file) {
  const base64 = await new Promise((ok) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1]);
    r.readAsDataURL(file);
  });
  entries.push({ kind: "image", mimeType: file.type, base64, name: file.name && file.name !== "image.png" ? file.name : `screenshot-${entries.length + 1}.png`, url: URL.createObjectURL(file) });
  $("#intake").open = true;
  renderEntries();
}

document.addEventListener("paste", (ev) => {
  const files = [...(ev.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  if (files.length) {
    ev.preventDefault();
    files.forEach(addImage);
  }
});
$("#dropzone").addEventListener("dragover", (ev) => ev.preventDefault());
$("#dropzone").addEventListener("drop", (ev) => {
  ev.preventDefault();
  [...ev.dataTransfer.files].filter((f) => f.type.startsWith("image/")).forEach(addImage);
});
$("#add-text").addEventListener("click", addText);
$("#paste-text").addEventListener("input", renderEntries);
const mentionBox = $("#paste-text");
const mentionMenu = $("#mention-menu");
let mentionMatches = [];
let mentionIdx = 0;
const mentionOpen = () => !mentionMenu.classList.contains("hidden");
function closeMention() { mentionMenu.classList.add("hidden"); mentionMatches = []; }
function renderMention() {
  mentionMenu.replaceChildren(...mentionMatches.map((name, i) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.textContent = "@" + name;
    if (i === mentionIdx) a.classList.add("active");
    a.addEventListener("mousedown", (ev) => { ev.preventDefault(); pickMention(name); });
    li.append(a);
    return li;
  }));
  mentionMenu.style.top = mentionBox.offsetTop + mentionBox.offsetHeight + "px";
  mentionMenu.classList.remove("hidden");
}
function updateMention() {
  const before = mentionBox.value.slice(0, mentionBox.selectionStart);
  const m = /(^|\s)@([\w.-]*)$/.exec(before);
  if (!m) return closeMention();
  const q = m[2].toLowerCase();
  mentionMatches = meta.targets.filter((t) => t.toLowerCase().includes(q))
    .sort((a, b) => Number(b.toLowerCase().startsWith(q)) - Number(a.toLowerCase().startsWith(q)));
  mentionIdx = 0;
  if (!mentionMatches.length) return closeMention();
  renderMention();
}
function pickMention(name) {
  const pos = mentionBox.selectionStart;
  const before = mentionBox.value.slice(0, pos).replace(/@[\w.-]*$/, "@" + name + " ");
  mentionBox.value = before + mentionBox.value.slice(pos);
  mentionBox.setSelectionRange(before.length, before.length);
  closeMention();
  mentionBox.focus();
  renderEntries();
}
mentionBox.addEventListener("input", updateMention);
mentionBox.addEventListener("click", updateMention);
mentionBox.addEventListener("blur", closeMention);
mentionBox.addEventListener("keydown", (ev) => {
  if (mentionOpen() && !ev.metaKey && !ev.ctrlKey) {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      mentionIdx = (mentionIdx + (ev.key === "ArrowDown" ? 1 : -1) + mentionMatches.length) % mentionMatches.length;
      return renderMention();
    }
    if (ev.key === "Enter" || ev.key === "Tab") { ev.preventDefault(); return pickMention(mentionMatches[mentionIdx]); }
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); return closeMention(); }
  }
  if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) addText();
});

$("#plan").addEventListener("click", async () => {
  addText();
  $("#plan").disabled = true;
  const started = Date.now();
  const tick = setInterval(() => ($("#plan-status").textContent = `Reading tickets and screenshots, then classifying… ${Math.round((Date.now() - started) / 1000)}s`), 500);
  try {
    const out = await api("POST", "/api/intake", { entries: entries.map(({ url, ...e }) => e) });
    $("#warnings").replaceChildren(...out.warnings.map((w) => h("div", { role: "alert", class: "alert alert-info alert-soft py-2 text-sm" }, w)));
    entries.length = 0;
    renderEntries();
    toast(`${out.view.items.length} card(s) added to Intake · ${money(out.costUsd)}`, "success");
    await refreshAll();
  } catch (e) {
    toast(e.message);
    $("#plan").disabled = false;
  } finally {
    clearInterval(tick);
    $("#plan-status").textContent = "";
  }
});

// ---------- my jira ----------
let jiraLoading = false;
async function loadJira() {
  if (jiraLoading) return;
  jiraLoading = true;
  $("#jira-refresh").disabled = true;
  $("#jira-status").textContent = "Loading assigned issues… this can take a minute.";
  try {
    renderJira(await api("GET", "/api/jira/assigned"));
    $("#jira-status").textContent = "";
  } catch (e) {
    $("#jira-status").textContent = "";
    toast(e.message);
  } finally {
    jiraLoading = false;
    $("#jira-refresh").disabled = false;
  }
}

function renderJira(rows) {
  $("#jira-status").textContent = rows.length ? `${rows.length} open` : "Nothing assigned to you.";
  $("#jira-list").replaceChildren(...rows.map((r) => {
    const box = h("div", { class: "hidden w-full flex gap-2 mt-2" });
    const text = h("textarea", { class: "textarea textarea-sm flex-1", rows: "2", placeholder: `Comment on ${r.key}` });
    const send = h("button", { class: "btn btn-primary btn-sm" }, "Send");
    send.onclick = async () => {
      if (!text.value.trim()) return toast("a comment needs text");
      send.disabled = true;
      try {
        await api("POST", `/api/jira/${encodeURIComponent(r.key)}/comment`, { body: text.value });
        toast(`Commented on ${r.key}`, "success");
        text.value = "";
        box.classList.add("hidden");
      } catch (e) {
        toast(e.message);
      }
      send.disabled = false;
    };
    box.append(text, send);
    const add = h("button", { class: "btn btn-xs btn-primary", disabled: r.onBoard }, r.onBoard ? "On board" : "Add to board");
    add.onclick = async () => {
      add.disabled = true;
      try {
        await api("POST", "/api/intake", { entries: [{ kind: "paste", text: r.key }] });
        toast(`${r.key} added to Intake`, "success");
        await refreshAll();
        renderJira(rows.map((x) => (x.key === r.key ? { ...x, onBoard: true } : x)));
      } catch (e) {
        toast(e.message);
        add.disabled = false;
      }
    };
    const dismiss = h("button", { class: "btn btn-xs btn-ghost", onclick: async () => {
      try {
        await api("POST", `/api/jira/${encodeURIComponent(r.key)}/dismiss`);
        renderJira(rows.filter((x) => x.key !== r.key));
      } catch (e) {
        toast(e.message);
      }
    } }, "Dismiss");
    const comment = h("button", { class: "btn btn-xs btn-ghost", onclick: () => box.classList.toggle("hidden") }, "Comment");
    return h("li", { class: "list-row flex-wrap py-2 items-center" },
      h("span", { class: "badge badge-sm" }, r.key),
      h("div", { class: "text-sm flex-1 min-w-0" }, r.summary, h("span", { class: "ml-2 text-xs opacity-60" }, r.status)),
      add, comment, dismiss, box);
  }));
}
$("#jira-refresh").addEventListener("click", loadJira);
$("#jira").addEventListener("toggle", () => { if ($("#jira").open && !$("#jira-list").children.length) loadJira(); });

// ---------- kanban ----------
const COLUMN_TITLES = { intake: "Intake", plan: "Plan · approve", running: "Running", review: "Review", shipped: "Shipped", merged: "Merged" };
const STAGE_DOT = {
  draft: "bg-base-content/40", "awaiting plan approval": "bg-warning", queued: "bg-base-content/40", planning: "bg-info", coding: "bg-info", testing: "bg-info",
  reviewing: "bg-info", "needs you": "bg-warning", "ready to review": "bg-success", shipped: "bg-success", merged: "bg-primary", killed: "bg-error", dropped: "bg-base-content/40",
};
let board = null;
let intakeSized = false;
let openId = null;

const chip = (text, cls = "") => h("span", { class: `badge badge-xs ${cls}` }, text);
const sourceLabel = (c) => (c.source.kind === "jira" ? c.source.ref : c.source.kind);
const stop = (fn) => (ev) => { ev.stopPropagation(); fn(); };
// GitLab …/merge_requests/418 → "MR !418"; GitHub …/pull/12 → "PR #12".
const mrLabel = (url) => {
  const gl = url.match(/merge_requests\/(\d+)/);
  const gh = url.match(/\/pull\/(\d+)/);
  return gl ? `MR !${gl[1]}` : gh ? `PR #${gh[1]}` : "MR ↗";
};

// A Ship or Merge running for the card: the button shows it and can't be pressed again.
const busyLabel = (c) => (c.busy === "merge" ? "Merging…" : c.busy === "resolve" ? "Resolving…" : "Shipping…");
const blockedByDirtyCheckout = (c) => /^merge blocked/i.test(c.pauseReason ?? "") && /uncommitted/i.test(c.pauseReason ?? "");
const resolveBtn = (c, size) => (blockedByDirtyCheckout(c) ? [actionBtn(c, "Resolve", () => resolveCheckout(c.id), "btn-warning", size)] : []);
function actionBtn(c, label, fn, cls, size = "btn-xs") {
  return h("button", { class: `btn ${size} ${cls}`, disabled: !!c.busy, onclick: stop(fn) }, ...(c.busy ? [h("span", { class: "loading loading-spinner loading-xs" }), busyLabel(c)] : [label]));
}

// A planned item has a reviewed plan that dropping discards, so ask first.
const dropPlanned = (id) => {
  if (window.confirm(`Drop #${id}? Its plan will be discarded.`)) act(() => api("POST", `/api/items/${id}/drop`));
};

function cardActions(c) {
  const btn = (label, fn, cls = "btn-ghost") => h("button", { class: `btn btn-xs ${cls}`, onclick: stop(fn) }, label);
  switch (c.column) {
    case "intake":
      return [btn("Start", () => act(() => api("POST", `/api/items/${c.id}/start`)), "btn-primary"), btn("Drop", () => act(() => api("POST", `/api/items/${c.id}/drop`)))];
    case "plan":
      return [btn("Approve", () => act(() => api("POST", `/api/items/${c.id}/plan/approve`, {}), `Plan for #${c.id} approved`), "btn-warning"), btn("Edit", () => openCard(c.id)), btn("Drop", () => dropPlanned(c.id))];
    case "running":
      return c.stage === "needs you"
        ? [btn("Continue +$0.50", () => act(() => api("POST", `/api/items/${c.id}/continue`, { extraUsd: 0.5 })), "btn-warning"), btn("Kill", () => act(() => api("POST", `/api/items/${c.id}/kill`)))]
        : c.stage === "queued"
          ? [btn("Start now", () => act(() => api("POST", `/api/items/${c.id}/nudge`), `#${c.id} nudged`), "btn-primary")]
          : [];
    case "review":
      return [actionBtn(c, "Ship", () => ship(c.id), "btn-success"), btn("Comment", () => openCard(c.id, true))];
    case "shipped":
      return c.mrUrl
        ? [h("a", { class: "link text-xs", href: c.mrUrl, target: "_blank", onclick: (ev) => ev.stopPropagation() }, mrLabel(c.mrUrl))]
        : [h("span", { class: "branch-label text-xs opacity-70 font-mono", title: c.branch }, c.branch), ...resolveBtn(c), actionBtn(c, "Merge", () => merge(c.id), "btn-primary")];
    case "merged":
      return [chip("merged", "badge-primary")];
  }
  return [];
}

function cardEl(c) {
  const busy = ["planning", "coding", "testing", "reviewing"].includes(c.stage);
  return h("button", { class: `kc space-y-1 ${c.stage === "needs you" ? "needs" : ""} ${openId === c.id ? "open" : ""}`, onclick: () => openCard(c.id), "aria-label": `Card ${c.id}: ${c.title}` },
    h("div", { class: "font-medium line-clamp-2" }, c.title),
    h("div", { class: "flex flex-wrap gap-1" }, chip(c.repo, c.repo === "unknown" ? "badge-error" : ""), chip(c.type, "badge-ghost"), chip(sourceLabel(c), "badge-outline")),
    h("div", { class: "flex items-center gap-1.5 opacity-80" },
      h("span", { class: `inline-block w-2 h-2 rounded-full ${STAGE_DOT[c.stage] ?? ""}` }),
      c.stage, c.activeAgents > 1 ? ` · ${c.activeAgents} agents` : "", c.sessionTurn > 1 ? ` · turn ${c.sessionTurn}` : "",
      c.column === "review" || c.column === "shipped" || c.column === "merged"
        ? `${c.lastVerdict ? ` · ${c.lastVerdict === "approve" ? "✓" : "✗"} reviewer` : ""}${c.lastGate ? ` · gate ${c.lastGate === "green" ? "✓" : "✗"}` : ""}`
        : ""),
    c.column === "plan" && c.plan
      ? h("div", { class: "space-y-1 min-w-0" },
          h("div", { class: "flex flex-wrap gap-1" }, chip(`📄 ${c.plan.files} file${c.plan.files === 1 ? "" : "s"}`, "badge-outline")),
          h("div", { class: "opacity-80 truncate" }, c.plan.approach))
      : null,
    c.stage === "queued" && c.waitingFor ? h("div", { class: "opacity-70 text-xs" }, c.waitingFor) : null,
    busy ? h("progress", { class: "progress progress-info w-full h-1" }) : null,
    c.question ? h("div", { class: "text-warning line-clamp-2" }, `? ${c.question}`) : null,
    c.pauseReason && (c.stage === "needs you" || c.column === "review" || c.column === "shipped") ? h("div", { class: "text-warning line-clamp-3" }, c.pauseReason) : null,
    h("div", { class: "flex items-center justify-between gap-1 pt-1" }, h("span", { class: "opacity-60" }, `#${c.id} · ${money(c.spentUsd)}`), h("span", { class: "flex gap-1" }, ...cardActions(c))),
  );
}

function renderBoard() {
  $("#kanban").replaceChildren(...Object.entries(board.columns).map(([col, cards]) =>
    h("div", { class: "col space-y-2", "data-column": col },
      h("div", { class: "font-semibold text-xs opacity-70 uppercase tracking-wide flex justify-between" }, COLUMN_TITLES[col], h("span", {}, cards.length)),
      ...cards.map(cardEl),
      col === "review" && cards.filter((c) => !c.busy).length > 1 ? h("button", { class: "btn btn-xs btn-success btn-outline w-full", onclick: () => shipAll(cards.filter((c) => !c.busy)) }, `Ship all ${cards.filter((c) => !c.busy).length}`) : null,
    )));
  $("#total-spend").textContent = `spent ${money(board.spentUsd)}`;
  // Intake opens by itself only on an empty board; afterwards it stays as Nat left it.
  if (!intakeSized) {
    intakeSized = true;
    $("#intake").open = Object.values(board.columns).every((cards) => !cards.length);
  }
  $("#closed-box").hidden = !board.closed.length;
  $("#closed-box summary").textContent = `${board.closed.length} closed (killed or dropped)`;
  $("#closed").replaceChildren(...board.closed.map((c) => h("li", {}, h("a", { class: "link", href: `/c/${c.id}`, onclick: (ev) => { ev.preventDefault(); openCard(c.id); } }, `#${c.id} ${c.title}`), ` — ${c.stage}`)));
}

async function ship(id) {
  if (!confirm(`Ship card #${id}? Its commits are replayed onto the latest base and the full gate runs; if that passes, the branch is pushed and a merge request opened (or a local branch kept for a repo without a remote).`)) return;
  toast(`#${id}: running the full gate before pushing…`, "info");
  await act(async () => {
    const r = await api("POST", `/api/items/${id}/ship`);
    if (r.error) throw new Error(`#${id}: ${r.error}`);
    if (r.warning) toast(r.warning, "warning");
    toast(r.mrUrl ? `MR opened: ${r.mrUrl}` : `Local branch ready: ${r.branch}`, "success");
  });
}
async function merge(id) {
  if (!confirm(`Merge card #${id} into the base branch of your main checkout? The full gate runs on the merged result first; the base branch only moves if it passes. Refused if the checkout has uncommitted changes or is on another branch.`)) return;
  toast(`#${id}: merging — the full gate runs before the base branch moves…`, "info");
  await act(async () => {
    const r = await api("POST", `/api/items/${id}/merge`);
    if (r.error) throw new Error(`#${id}: ${r.error}`);
    toast(`#${id} merged (${r.fastForward ? "fast-forward" : "merge commit"}) · ${String(r.sha).slice(0, 8)}`, "success");
  });
}
async function resolveCheckout(id) {
  if (!confirm(`Resolve the uncommitted changes in your main checkout for card #${id}? An agent inspects them and commits what belongs on the base branch or stashes the rest; it never discards work and asks you when unsure.`)) return;
  toast(`#${id}: an agent is resolving the uncommitted changes…`, "info");
  await act(async () => {
    const r = await api("POST", `/api/items/${id}/resolve`);
    if (r.error) throw new Error(`#${id}: ${r.error}`);
    if (r.resolved) toast(`#${id}: checkout is clean — press Merge`, "success");
    else if (r.question) toast(`#${id}: the agent has a question — open the card to answer, then Resolve again`, "warning");
    else toast(`#${id}: the checkout is still not clean`, "warning");
  });
}
async function shipAll(cards) {
  if (!confirm(`Ship ${cards.length} cards? Each pushes its branch and opens a merge request.`)) return;
  for (const c of cards) {
    const r = await api("POST", `/api/items/${c.id}/ship`).catch((e) => ({ error: e.message }));
    if (r.error) toast(`#${c.id}: ${r.error}`);
  }
  await refreshAll();
}

// ---------- card panel ----------
let detail = null;
let focusComment = false;

function describe(e) {
  const d = e.payload ?? e.data ?? {};
  switch (e.kind) {
    case "agent.tool": return `tool ${d.tool}`;
    case "agent.message": return d.text;
    case "agent.denied": return `denied: ${d.reason}`;
    case "item.started": return `${d.role ?? "agent"}${d.subtask && d.subtask !== "main" ? ` (${d.subtask})` : ""} ${d.resumed ? "resumed" : "started"} (turn ${d.sessionTurn ?? "?"})`;
    case "plan.ready": return "plan ready for approval";
    case "plan.commented": return "plan commented, re-planning";
    case "plan.approved": return `plan approved${d.edited ? " (edited)" : ""}`;
    case "wave.started": return `${d.subtasks.length} coders in parallel: ${d.subtasks.join(", ")}`;
    case "role.done": return `${d.role}${d.subtask && d.subtask !== "main" ? ` (${d.subtask})` : ""} done${d.sha ? ` · ${String(d.sha).slice(0, 8)}` : ""}${d.files?.length ? ` · ${d.files.length} files` : ""}`;
    case "review.verdict": return `reviewer: ${d.verdict === "approve" ? "approve" : "changes requested"} — ${d.comments}`;
    case "gate.green": return `gate ✓ ${d.role ?? ""}`;
    case "gate.red": return `gate ✗ ${(d.newFailures ?? []).slice(0, 3).join(", ") || "command failed"} → sent back`;
    case "item.paused": return `paused: ${d.reason}`;
    case "item.done": return "ready to review";
    case "session.turn": return `turn ${d.n} opened: ${d.comment}`;
    case "item.published": return d.mrUrl ? `MR opened: ${d.mrUrl}` : `local branch ready: ${d.branch}`;
    case "item.publish_failed": return `ship failed: ${d.error}`;
    case "baseline.started": return `measuring baseline for ${d.target}…`;
    case "baseline.done": return `baseline ${d.target}: ${d.failures} pre-existing failures`;
    case "card.started": return "started";
    case "item.ship_started": return `ship started: ${d.branch}`;
    case "item.merge_started": return `merge started: ${d.branch}`;
    case "item.merged": return `merged ${d.branch} (${d.fastForward ? "fast-forward" : "merge commit"}) · ${String(d.sha).slice(0, 8)}`;
    case "item.merge_failed": return `merge failed: ${d.error}`;
    case "item.resolve_started": return "resolving uncommitted changes in the main checkout";
    case "item.resolved": return "main checkout resolved";
    case "item.resolve_failed": return `resolve failed: ${d.error}`;
    case "ship.gate": return d.phase === "baseline" ? `gate: measuring the full-gate baseline on ${d.baseSha}…` : `gate: full gate on the candidate tree (${d.files} files)…`;
    case "ship.gate_green": return "gate: full gate ✓ — no new failures";
    case "ship.gate_red": return `gate: full gate ✗ ${(d.newFailures ?? []).slice(0, 3).join(", ")}`;
    default: return e.kind;
  }
}

async function openCard(id, comment = false) {
  openId = id;
  focusComment = comment;
  if (location.pathname !== `/c/${id}`) history.pushState({}, "", `/c/${id}`);
  await loadCard();
  if (board) renderBoard();
}
function closeCard() {
  openId = null;
  detail = null;
  lastDetailJson = null;
  $("#panel").dataset.card = "";
  $("#panel").hidden = true;
  if (location.pathname !== "/") history.pushState({}, "", "/");
  if (board) renderBoard();
}
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && openId && !$("#repos").open && !$("#file-diff").open) closeCard(); });

async function loadCard() {
  if (!openId) return;
  try {
    detail = await api("GET", `/api/items/${openId}`);
  } catch (e) {
    toast(e.message);
    return closeCard();
  }
  const next = JSON.stringify(detail);
  if (next === lastDetailJson && lastRenderedId === openId) return; // nothing changed: keep the DOM (and any typed text)
  lastDetailJson = next;
  lastRenderedId = openId;
  renderPanel();
}
let lastDetailJson = null;
let lastRenderedId = null;

// Typed-but-unsent text survives panel rebuilds (SSE refreshes), keyed by data-draft.
function captureDrafts(root) {
  const drafts = new Map();
  for (const el of root.querySelectorAll("[data-draft]")) if (el.value !== el.defaultValue) drafts.set(el.dataset.draft, el.value);
  const a = document.activeElement;
  const focus = a && root.contains(a) && a.dataset?.draft ? { key: a.dataset.draft, start: a.selectionStart, end: a.selectionEnd } : null;
  return { drafts, focus };
}
function restoreDrafts(root, { drafts, focus }) {
  for (const el of root.querySelectorAll("[data-draft]")) if (drafts.has(el.dataset.draft)) el.value = drafts.get(el.dataset.draft);
  if (!focus) return;
  const el = [...root.querySelectorAll("[data-draft]")].find((x) => x.dataset.draft === focus.key);
  if (!el) return;
  el.focus();
  try { el.setSelectionRange(focus.start, focus.end); } catch { /* not a text control */ }
}

const field = (legend, control) => h("label", { class: "fieldset" }, h("span", { class: "fieldset-legend" }, legend), control);
const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);

function answerForm(item) {
  return item.question
    ? h("div", { class: "space-y-1 min-w-0" },
        h("p", { class: "text-sm font-semibold min-w-0 whitespace-pre-wrap break-words" }, item.question),
        h("form", { class: "join w-full", onsubmit: (ev) => { ev.preventDefault(); act(() => api("POST", `/api/items/${item.id}/answer`, { answer: ev.target.answer.value }), undefined, ev.target.answer); } },
          h("input", { name: "answer", "data-draft": `answer:${item.id}`, class: "input input-sm join-item w-full min-w-0", placeholder: "Your answer", "aria-label": item.question }), h("button", { class: "btn btn-sm join-item" }, "Answer")))
    : null;
}

function intakeEditor(d) {
  const { item } = d;
  const patch = (body) => act(() => api("PATCH", `/api/items/${item.id}`, body));
  const sel = (value, options, onchange) => h("select", { class: "select select-sm w-full", onchange }, ...options.map((o) => h("option", { value: o, selected: o === value }, o)));
  const repo = sel(item.target_repo, ["unknown", ...meta.targets, "+ Add repo…"], (ev) => (ev.target.value === "+ Add repo…" ? openRepos(item.id) : patch({ target_repo: ev.target.value })));
  const deps = JSON.parse(item.depends_on);
  return h("div", { class: "space-y-2" },
    field("title", h("input", { "data-draft": `title:${item.id}`, class: "input input-sm w-full", value: item.title, onchange: (ev) => patch({ title: ev.target.value }) })),
    h("div", { class: "grid grid-cols-3 gap-2" },
      field("type", sel(item.type, ["bug", "feature", "refactor", "spike"], (ev) => patch({ type: ev.target.value }))),
      field("repo", repo),
      field("model", sel(item.model, meta.models, (ev) => patch({ model: ev.target.value })))),
    d.siblings.length
      ? field("depends on (same intake)", h("div", { class: "flex flex-wrap gap-3" }, ...d.siblings.map((s) =>
          h("label", { class: "flex gap-1 items-center text-sm" },
            h("input", { type: "checkbox", class: "checkbox checkbox-xs", checked: deps.includes(s.id), onchange: (ev) => patch({ depends_on: ev.target.checked ? [...deps, s.id] : deps.filter((x) => x !== s.id) }) }),
            `#${s.id} ${s.title.slice(0, 40)}`))))
      : null,
    answerForm(item),
    d.startBlockers.length ? h("ul", { class: "text-sm text-warning list-disc pl-5" }, ...d.startBlockers.map((b) => h("li", {}, b))) : null,
    h("div", { class: "flex gap-2" },
      h("button", { class: "btn btn-primary btn-sm", disabled: d.startBlockers.length > 0, onclick: () => act(() => api("POST", `/api/items/${item.id}/start`)) }, "Start → planner"),
      h("button", { class: "btn btn-ghost btn-sm", onclick: () => act(() => api("POST", `/api/items/${item.id}/drop`)) }, "Drop")),
  );
}

// Subtasks as editable lines: "id | title | files, … | depends on, …".
const subtaskLines = (plan) => (plan.subtasks ?? []).map((t) => `${t.id} | ${t.title} | ${t.files.join(", ")} | ${t.dependsOn.join(", ")}`).join("\n");
const parseSubtasks = (text) =>
  lines(text).map((l) => {
    const [id = "", title = "", files = "", deps = ""] = l.split("|").map((x) => x.trim());
    const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
    return { id, title: title || id, files: list(files), dependsOn: list(deps) };
  });
// Waves: which subtasks start together (each wave waits for the one before).
function waves(subtasks) {
  const done = new Set();
  const out = [];
  let left = [...subtasks];
  while (left.length) {
    const ready = left.filter((t) => t.dependsOn.every((d) => done.has(d)));
    if (!ready.length) return [...out, left];
    out.push(ready);
    ready.forEach((t) => done.add(t.id));
    left = left.filter((t) => !ready.includes(t));
  }
  return out;
}
// A plan file badge: clicking it opens that file's diff on the session branch for the open card.
const fileBadge = (label, cls = "", full = label) => h("span", { role: "button", tabindex: "0", class: `badge badge-sm badge-ghost font-mono max-w-full h-auto break-all text-left cursor-pointer hover:badge-primary ${cls}`, title: full, onclick: (ev) => { ev.stopPropagation(); openFileDiff(full); }, onkeydown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); openFileDiff(full); } } }, label);
let diffSeq = 0;
async function openFileDiff(file) {
  if (!openId) return;
  const seq = ++diffSeq;
  const body = $("#file-diff-body");
  $("#file-diff-title").textContent = file;
  body.replaceChildren(h("span", { class: "opacity-60" }, "Loading…"));
  $("#file-diff").showModal();
  try {
    const { diff } = await api("GET", `/api/items/${openId}/diff/${encodeURIComponent(file)}`);
    if (seq !== diffSeq) return;
    body.replaceChildren(...(diff ? diff.split("\n").map((l) => h("div", { class: diffLineClass(l) }, l || " ")) : [h("span", { class: "opacity-60" }, "No changes on the session branch yet.")]));
  } catch (e) {
    if (seq !== diffSeq) return;
    body.replaceChildren(h("span", { class: "text-error" }, e.message));
  }
}
function diffLineClass(l) {
  if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ")) return "font-semibold opacity-70";
  if (l.startsWith("@@")) return "text-info";
  if (l.startsWith("+")) return "text-success";
  if (l.startsWith("-")) return "text-error";
  return "";
}
function groupByDir(paths) {
  const m = new Map();
  for (const p of paths) {
    const i = p.lastIndexOf("/");
    const dir = i < 0 ? "." : p.slice(0, i);
    if (!m.has(dir)) m.set(dir, []);
    m.get(dir).push(i < 0 ? p : p.slice(i + 1));
  }
  return m;
}
function chipList(paths, orphans = new Set()) {
  if (!paths.length) return h("div", { class: "text-sm opacity-60" }, "—");
  return h("div", { class: "space-y-1 min-w-0" }, ...[...groupByDir(paths)].map(([dir, names]) =>
    h("div", { class: "flex flex-wrap items-center gap-1 min-w-0" },
      h("span", { class: "text-xs opacity-60 font-mono break-all" }, `${dir}/`),
      ...names.map((n) => {
        const full = dir === "." ? n : `${dir}/${n}`;
        return orphans.has(full) ? fileBadge(`⚠ ${n}`, "badge-warning", full) : fileBadge(n, "", full);
      }))));
}
const statChip = (n, label) => h("span", { class: "badge badge-outline badge-sm" }, h("b", {}, n), ` ${label}`);
const section = (title, body, cls = "") => h("div", { class: `min-w-0 ${cls}` }, h("div", { class: "text-xs uppercase tracking-wide opacity-60 mb-1" }, title), body);

function subtaskGraph(plan) {
  const subs = plan.subtasks ?? [];
  if (subs.length < 2) return h("div", { class: "text-sm opacity-70" }, "One coder (no split).");
  return h("div", { class: "space-y-2" },
    ...waves(subs).map((wave, i) =>
      h("div", { class: "flex flex-wrap items-start gap-2" },
        h("span", { class: "badge badge-sm badge-primary shrink-0" }, `wave ${i + 1}`),
        wave.length > 1 ? h("span", { class: "badge badge-sm badge-info badge-outline shrink-0" }, `⇉ ${wave.length} parallel`) : null,
        ...wave.map((t) => h("div", { class: "border border-base-300 rounded-box px-2 py-1 text-xs min-w-0 space-y-1" },
          h("div", {}, h("span", { class: "font-semibold" }, `${t.id}`), ` ${t.title}`),
          h("div", { class: "flex flex-wrap gap-1" }, ...t.files.map((f) => fileBadge(f))))))));
}

function planView(plan) {
  const files = plan.files ?? [], testFiles = plan.testFiles ?? [];
  const subs = plan.subtasks ?? [];
  const covered = new Set(subs.flatMap((t) => t.files));
  const orphans = new Set(subs.length > 1 ? files.filter((f) => !covered.has(f)) : []);
  const risks = (plan.risks ?? "").trim();
  const hasRisk = risks && !/^(none\.?|n\/a|-|—)$/i.test(risks);
  const approach = plan.approach || "—";
  const long = approach.length > 280;
  const approachEl = h("div", { class: `text-sm whitespace-pre-wrap ${long ? "line-clamp-4" : ""}` }, approach);
  const more = long ? h("button", { type: "button", class: "link text-xs", onclick: (ev) => {
      const open = approachEl.classList.toggle("line-clamp-4");
      ev.target.textContent = open ? "show more" : "show less";
    } }, "show more") : null;
  const testPlan = (plan.testPlan ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return h("div", { class: "space-y-3 min-w-0" },
    h("div", { class: "flex flex-wrap gap-1" },
      statChip(Math.max(1, subs.length), subs.length > 1 ? "coders" : "coder"), statChip(waves(subs).length || 1, "waves"),
      statChip(files.length, "files"), statChip(testFiles.length, "test files"),
      hasRisk ? h("span", { class: "badge badge-warning badge-sm" }, "⚠ risks") : null),
    h("div", { class: "border-l-4 border-error pl-3 bg-base-200 rounded-r-box py-1" }, section("Root cause", h("div", { class: "text-sm whitespace-pre-wrap" }, plan.rootCause || "—"))),
    h("div", { class: "border-l-4 border-primary pl-3 bg-base-200 rounded-r-box py-1" }, section("Approach", h("div", {}, approachEl, more))),
    section("Coders", subtaskGraph(plan)),
    section(`Files (${files.length})`, chipList(files, orphans)),
    section(`Test files (${testFiles.length})`, chipList(testFiles)),
    section("Test plan", testPlan.length
      ? h("ul", { class: "text-sm space-y-0.5" }, ...testPlan.map((l) => h("li", { class: "flex gap-2" }, h("span", { class: "opacity-60" }, "☐"), h("span", { class: "min-w-0 break-words" }, l.replace(/^[-*]\s+/, "")))))
      : h("div", { class: "text-sm opacity-60" }, "—")),
    hasRisk ? h("div", { role: "alert", class: "alert alert-warning alert-soft text-sm whitespace-pre-wrap block" }, h("b", {}, "Risks: "), risks) : null);
}

function planEditor(item, plan) {
  const ta = (name, value, rows = 3) => h("textarea", { name, rows, class: "textarea textarea-sm w-full" }, value);
  return h("form", { class: "space-y-2", onsubmit: (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const edited = { rootCause: f.rootCause.value, approach: f.approach.value, files: lines(f.files.value), testFiles: lines(f.testFiles.value), testPlan: f.testPlan.value, risks: f.risks.value };
      const subtasks = parseSubtasks(f.subtasks.value);
      if (subtasks.length || plan.subtasks) edited.subtasks = subtasks;
      const changed = JSON.stringify(edited) !== JSON.stringify(plan);
      act(() => api("POST", `/api/items/${item.id}/plan/approve`, changed ? { plan: edited } : {}), changed ? "Edited plan approved" : "Plan approved");
    } },
    field("Root cause", ta("rootCause", plan.rootCause)), field("Approach", ta("approach", plan.approach, 4)),
    h("div", { class: "space-y-1" }, h("div", { class: "text-xs opacity-60" }, "Coders, as the planner split them"), subtaskGraph(plan)),
    field("Subtasks — one per line: id | title | files, … | depends on, …  (no lines = one coder)", ta("subtasks", subtaskLines(plan), Math.max(2, (plan.subtasks ?? []).length + 1))),
    h("div", { class: "grid grid-cols-2 gap-2" }, field("Files (one per line; the coder may write only these)", ta("files", plan.files.join("\n"))), field("Test files", ta("testFiles", plan.testFiles.join("\n")))),
    field("Test plan", ta("testPlan", plan.testPlan, 2)), field("Risks", ta("risks", plan.risks, 2)),
    h("div", { class: "flex gap-2" }, h("button", { class: "btn btn-warning btn-sm", type: "submit" }, "Approve plan → run"), h("span", { class: "text-xs opacity-60 self-center" }, "Edits are saved with the approval.")),
  );
}

const ROLE_ICON = { planner: "🧭", coder: "⌨️", tester: "🧪", reviewer: "🔍" };
function runsTable(runs) {
  if (!runs.length) return h("p", { class: "text-sm opacity-60" }, "No agent has run in this turn yet.");
  return h("div", { class: "space-y-1" }, ...runs.map((r) =>
    h("details", { class: "bg-base-200 rounded-box px-3 py-1.5" },
      h("summary", { class: "cursor-pointer text-sm flex flex-wrap gap-x-3 gap-y-1 items-center" },
        h("span", { class: "font-medium" }, `${ROLE_ICON[r.role] ?? ""} ${r.role}`, r.subtask && r.subtask !== "main" ? h("span", { class: "font-normal opacity-70" }, ` · ${r.subtask}`) : null),
        chip(r.status, r.status === "done" ? "badge-success" : r.status === "running" ? "badge-info" : r.status === "paused" ? "badge-warning" : "badge-error"),
        r.verdict ? chip(r.verdict === "approve" ? "approve" : "changes requested", r.verdict === "approve" ? "badge-success badge-outline" : "badge-warning badge-outline") : null,
        r.gates.length ? h("span", { class: "font-mono text-xs" }, r.gates.map((g) => (g === "green" ? "✓" : "✗")).join("")) : null,
        h("span", { class: "text-xs opacity-60 ml-auto" }, `${r.model} · ${r.modelTurns} turn${r.modelTurns === 1 ? "" : "s"} · ${money(r.spentUsd)}`)),
      h("pre", { class: "summary opacity-85 pt-1" }, r.summary || "(no summary yet)"))));
}

function renderPanel() {
  const d = detail;
  const { card, item } = d;
  const p = $("#panel");
  p.hidden = false;
  const latest = d.turns.at(-1);
  const saved = lastRenderedId === openId && p.dataset.card === String(openId) ? captureDrafts(p) : { drafts: new Map(), focus: null };
  p.dataset.card = String(openId);
  p.replaceChildren(...[
    h("div", { class: "flex items-start gap-2" },
      h("div", { class: "flex-1 min-w-0 space-y-1" },
        h("h2", { class: "text-lg font-semibold min-w-0 break-words" }, `#${card.id} ${card.title}`),
        h("div", { class: "flex flex-wrap gap-1 items-center text-sm" }, chip(card.repo), chip(card.type, "badge-ghost"), chip(sourceLabel(card), "badge-outline"),
          h("span", { class: "opacity-70" }, `· ${card.stage} · ${money(card.spentUsd)}`))),
      h("button", { class: "btn btn-sm btn-circle btn-ghost", "aria-label": "Close", onclick: closeCard }, "✕")),
    card.column === "review" && item.pause_reason
      ? h("div", { role: "alert", class: "alert alert-warning alert-soft text-sm" }, h("span", { class: "min-w-0 break-words whitespace-pre-wrap" }, item.pause_reason, " — comment for another turn, or Ship again once the base is fixed."))
      : null,
    card.column === "shipped" && item.pause_reason
      ? h("div", { role: "alert", class: "alert alert-warning alert-soft text-sm" }, h("span", { class: "min-w-0 break-words whitespace-pre-wrap" }, item.pause_reason))
      : null,
    card.stage === "needs you"
      ? h("div", { role: "alert", class: "alert alert-warning alert-soft text-sm flex flex-wrap" }, h("span", { class: "flex-1 min-w-0 break-words whitespace-pre-wrap" }, item.pause_reason),
          h("button", { class: "btn btn-xs btn-warning", onclick: () => act(() => api("POST", `/api/items/${item.id}/continue`, { extraUsd: 0.5 })) }, "Continue +$0.50"),
          h("button", { class: "btn btn-xs", onclick: () => act(() => api("POST", `/api/items/${item.id}/kill`)) }, "Kill"))
      : null,
    card.column === "intake" ? intakeEditor(d) : null,
    h("details", { class: "collapse collapse-arrow bg-base-200", open: card.column === "intake" },
      h("summary", { class: "collapse-title text-sm font-semibold py-2 min-h-0" }, "Source"),
      h("div", { class: "collapse-content min-w-0 break-words" }, h("pre", { class: "summary" }, item.brief || item.source_ref), item.notes ? h("pre", { class: "summary text-info" }, item.notes) : null)),
    ...d.turns.map((t) =>
      h("section", { class: "space-y-2" },
        h("h3", { class: "font-semibold text-sm" }, `Turn ${t.turn.n}`, t.turn.comment ? h("span", { class: "font-normal opacity-80" }, ` — your comment: “${t.turn.comment}”`) : h("span", { class: "font-normal opacity-60" }, " — from intake")),
        t.plan
          ? h("div", { class: "border border-base-300 rounded-box p-3 space-y-2" },
              h("div", { class: "flex items-center gap-2 text-sm font-semibold" }, "Plan", chip(t.turn.plan_status, t.turn.plan_status === "approved" ? "badge-success" : "badge-warning")),
              t === latest && card.column === "plan"
                ? [planView(t.plan),
                   h("div", { class: "sticky bottom-0 bg-base-100 pt-2 flex items-center gap-2 border-t border-base-300" },
                     h("button", { class: "btn btn-warning btn-sm", type: "button", onclick: () => act(() => api("POST", `/api/items/${item.id}/plan/approve`, {}), "Plan approved") }, "Approve plan → run"),
                     h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => dropPlanned(item.id) }, "Drop"),
                     h("span", { class: "text-xs opacity-60" }, "or edit below, then approve")),
                   h("form", { class: "space-y-2", onsubmit: (ev) => {
                       ev.preventDefault();
                       act(() => api("POST", `/api/items/${item.id}/plan/comment`, { comment: ev.target.comment.value }), "Comment sent, re-planning", ev.target.comment);
                     } },
                     h("textarea", { name: "comment", id: "plan-comment", "data-draft": `plan-comment:${item.id}`, rows: 3, class: "textarea textarea-sm w-full", placeholder: "Comment on this plan in plain text. The planner will revise it." }),
                     h("button", { class: "btn btn-sm", type: "submit" }, "Send comment → re-plan")),
                   h("details", { class: "collapse collapse-arrow bg-base-200" },
                     h("summary", { class: "collapse-title text-sm font-semibold py-2 min-h-0" }, "Edit plan"),
                     h("div", { class: "collapse-content" }, planEditor(item, t.plan)))]
                : planView(t.plan))
          : null,
        runsTable(t.runs))),
    card.column === "review"
      ? h("section", { class: "space-y-2 border-t border-base-300 pt-3" },
          h("h3", { class: "font-semibold text-sm" }, "Your review"),
          h("form", { class: "space-y-2", onsubmit: (ev) => {
              ev.preventDefault();
              act(() => api("POST", `/api/items/${item.id}/turn`, { comment: ev.target.comment.value }), "Another turn started", ev.target.comment);
            } },
            h("textarea", { name: "comment", id: "review-comment", "data-draft": `review-comment:${item.id}`, rows: 3, class: "textarea textarea-sm w-full", placeholder: "What should change? This starts another turn: planner → your approval → coder → tester → reviewer." }),
            h("div", { class: "flex gap-2" }, h("button", { class: "btn btn-sm", type: "submit" }, "Another turn"), actionBtn(card, "Ship", () => ship(item.id), "btn-success", "btn-sm"))))
      : null,
    card.column === "shipped"
      ? h("div", { class: "space-y-2" },
          h("div", { class: "flex items-center gap-2 text-sm" },
            card.mrUrl ? h("a", { class: "link", href: card.mrUrl, target: "_blank" }, card.mrUrl) : h("span", {}, `Local branch: ${card.branch}`),
            ...(card.mrUrl ? [] : resolveBtn(card, "btn-sm")),
            card.mrUrl ? null : actionBtn(card, "Merge", () => merge(item.id), "btn-primary", "btn-sm")),
          answerForm(item))
      : null,
    card.column === "merged" ? h("p", { class: "text-sm" }, `Merged into the base branch (${card.branch}) on ${card.mergedAt ?? "?"}`) : null,
    h("details", { class: "collapse collapse-arrow bg-base-200", open: ["planning", "coding", "testing", "reviewing"].includes(card.stage) },
      h("summary", { class: "collapse-title text-sm font-semibold py-2 min-h-0" }, `Activity (${d.events.length})`),
      h("div", { class: "collapse-content" }, h("ol", { id: "activity", class: "text-xs font-mono space-y-1 max-h-80 overflow-y-auto" },
        ...d.events.slice().reverse().map((e) => h("li", {}, `${String(e.ts).slice(11, 19)}  ${describe(e)}`))))),
  ].filter(Boolean)); // replaceChildren would print a null as text
  restoreDrafts(p, saved);
  if (focusComment) {
    focusComment = false;
    $("#review-comment")?.focus();
  }
}

// ---------- live updates ----------
let refreshTimer = null;
async function refreshAll() {
  try {
    board = await api("GET", "/api/board");
    renderBoard();
    if (openId) await loadCard();
  } catch (e) {
    toast(e.message);
  }
}
function watch() {
  const source = new EventSource("/api/events");
  source.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    // Tool calls and messages only touch the open card's activity log; everything else may move cards.
    if (openId && e.itemId === openId && ["agent.tool", "agent.message"].includes(e.kind)) {
      $("#activity")?.prepend(h("li", {}, `${e.ts.slice(11, 19)}  ${describe(e)}`));
      return;
    }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshAll, 300);
  };
}

// ---------- repos ----------
let repoForCard = null; // when opened from a card, the new repo is applied to it

async function openRepos(cardId = null) {
  repoForCard = cardId;
  const list = await api("GET", "/api/targets");
  $("#repo-rows").replaceChildren(...list.map((t) =>
    h("tr", {}, h("td", { class: "font-semibold" }, t.name), h("td", { class: "font-mono" }, t.repo), h("td", {}, t.baseBranch), h("td", {}, t.host), h("td", { class: "font-mono" }, t.gate.quick.join(" && ")))));
  $("#repo-form").hidden = true;
  $("#repo-error").hidden = true;
  $("#repo-path").value = "";
  $("#repos").showModal();
  $("#repo-path").focus();
}
$("#open-repos").addEventListener("click", () => openRepos());

$("#repo-inspect").addEventListener("click", async () => {
  $("#repo-error").hidden = true;
  try {
    const r = await api("POST", "/api/targets/inspect", { path: $("#repo-path").value });
    const f = $("#repo-form");
    f.name.value = r.name;
    f.repo.value = r.repo;
    inspected = r;
    f.host.value = r.host ?? "gitlab";
    fillBranches(r.baseBranch);
    f.setup.value = r.setup.join("\n");
    f.quick.value = r.gate.quick.join("\n");
    f.full.value = r.gate.full.join("\n");
    $("#repo-notes").replaceChildren(...r.notes.map((n) => h("li", {}, n)), ...(r.remoteUrl ? [h("li", {}, `origin: ${r.remoteUrl}`)] : []));
    f.hidden = false;
  } catch (e) {
    toast(e.message);
  }
});
// A local-only repo (no remote) picks its base from local branches; otherwise from origin's.
let inspected = null;
function fillBranches(selected) {
  const f = $("#repo-form");
  const pool = f.host.value === "local" ? inspected.localBranches : inspected.branches;
  f.baseBranch.replaceChildren(...pool.map((b) => h("option", { value: b, selected: b === selected }, b)));
}
$("#repo-form").host.addEventListener("change", () => inspected && fillBranches($("#repo-form").baseBranch.value));
$("#repo-path").addEventListener("keydown", (ev) => { if (ev.key === "Enter") $("#repo-inspect").click(); });

$("#repo-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  try {
    const t = await api("POST", "/api/targets", {
      name: f.name.value, repo: f.repo.value, host: f.host.value, baseBranch: f.baseBranch.value,
      setup: lines(f.setup.value), gate: { quick: lines(f.quick.value), full: lines(f.full.value) },
    });
    meta = await api("GET", "/api/meta");
    $("#repos").close();
    toast(`Added ${t.name}`, "success");
    if (repoForCard) await act(() => api("PATCH", `/api/items/${repoForCard}`, { target_repo: t.name }));
  } catch (e) {
    toast(e.message);
  }
});

// ---------- routing ----------
async function route() {
  const id = Number(location.pathname.match(/^\/c\/(\d+)$/)?.[1]);
  if (id) await openCard(id);
  else closeCard();
}
window.addEventListener("popstate", route);

meta = await api("GET", "/api/meta");
renderEntries();
await refreshAll();
watch();
await route();
// Deep link: /#repos opens the Repos dialog; /#repos=<path> also reads that checkout.
const deep = location.hash.match(/^#repos(?:=(.+))?$/);
if (deep) {
  await openRepos();
  if (deep[1]) {
    $("#repo-path").value = decodeURIComponent(deep[1]);
    $("#repo-inspect").click();
  }
}
