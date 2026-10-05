import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const path = process.argv[2], mode = process.argv[3];
const args = process.argv.slice(4);
const emit = (message: any) => process.stdout.write(JSON.stringify(message) + "\n");
const state: any = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { calls: [], sessions: {} };
const projectsDirectory = mode === "no-projects-directory" && process.env.CLAUDE_CONFIG_DIR
  ? join(process.env.CLAUDE_CONFIG_DIR, "projects") : join(dirname(path), "claude-projects");
mkdirSync(join(projectsDirectory, "project"), { recursive: true });
if (args[0] === "auth") { emit({ loggedIn: mode !== "unauthenticated", ...(mode === "no-projects-directory" ? {} : { projectsDirectory }) }); process.exit(mode === "unauthenticated" ? 1 : 0); }
const resume = args.includes("--resume");
const sessionId = args[args.indexOf(resume ? "--resume" : "--session-id") + 1];
if (resume && !state.sessions[sessionId]) process.exit(3);
state.sessions[sessionId] ??= [];
createInterface({ input: process.stdin }).on("line", (line) => {
  const row = JSON.parse(line), messageId = `msg-${state.calls.length + 1}`;
  state.calls.push({ args, input: row, resume, sessionId });
  state.sessions[sessionId].push({ type: "user", sessionId, uuid: row.uuid, message: row.message });
  const save = () => {
    writeFileSync(path, JSON.stringify(state));
    writeFileSync(join(projectsDirectory, "project", `${sessionId}.jsonl`), state.sessions[sessionId].map((item: any) => JSON.stringify(item)).join("\n") + "\n");
  };
  const send = (message: any) => emit({ session_id: sessionId, parent_tool_use_id: null, ...message });
  save();
  send({ type: "system", subtype: "init", model: "claude-test-model" });
  send({ type: "user", uuid: row.uuid, message: row.message });
  if (mode === "hold") { setInterval(() => {}, 10_000); return; }
  if (mode === "exit") process.exit(2);
  if (mode === "fail") { send({ type: "result", subtype: "error_during_execution", is_error: true }); return; }
  if (mode.startsWith("reply-")) {
    const draft = "This is the first part of the reply.\nThis is the second part of the reply.\nThis is the third part of the reply.\nThis is the fourth part of the reply.\nThe necessary final detail remains intact.";
    const review = args.includes("--json-schema");
    if (review && mode === "reply-review-hold") { setInterval(() => {}, 10_000); return; }
    setTimeout(() => {
      const decision = mode === "reply-requested" ? "requested" : mode === "reply-necessary" ? "necessary" : "brief";
      const structured = { decision, reason: decision === "requested" ? "The user requested the full explanation." : decision === "necessary" ? "The final detail is indispensable to an accurate answer." : "Routine answer.",
        text: decision !== "brief" ? "" : mode === "reply-repeat-overflow" ? draft : "Done; the requested change is installed." };
      const reply = review ? JSON.stringify(structured) : draft;
      const message = { id: messageId, content: [{ type: "text", text: reply }] };
      state.sessions[sessionId].push({ type: "assistant", sessionId, message }); save();
      send({ type: "stream_event", event: { type: "message_start", message: { id: messageId } } });
      send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: reply } } });
      send({ type: "assistant", message });
      send({ type: "result", subtype: "success", is_error: false, result: reply, ...(review ? { structured_output: structured } : {}), permission_denials: [] });
    }, 25);
    return;
  }
  setTimeout(() => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: messageId } } });
    send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Claude " } } });
    send({ type: "assistant", message: { id: "child", content: [{ type: "text", text: "Do not display subagent" }] }, parent_tool_use_id: "tool-child" });
  }, 10);
  setTimeout(() => {
    const message = { id: messageId, content: [{ type: "text", text: "Claude reply" }] };
    state.sessions[sessionId].push({ type: "assistant", sessionId, message }); save();
    send({ type: "assistant", message });
    send({ type: "result", subtype: "success", is_error: false, result: "Claude reply", permission_denials: [] });
  }, 25);
});
