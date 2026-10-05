import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCode } from "../claude.ts";
import { Sessions } from "../session.ts";
import { detachedWorker, frontOptions, prepareFrontState } from "../claude-front.ts";
import { renderedReplyLines } from "../reply-policy.ts";
import { Notifications } from "../notifications.ts";
import type { PushNotice } from "../apns.ts";

const owned: { root: string; claude: ClaudeCode[]; notices?: Notifications }[] = [];
afterEach(async () => { for (const item of owned.splice(0)) { item.notices?.close(); item.claude.forEach(c => c.close()); await Bun.sleep(50); rmSync(item.root, { recursive: true, force: true }); } });
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await Bun.sleep(20); } throw Error("Test timed out"); }
async function fixture(mode: string) {
  const root = mkdtempSync(join(tmpdir(), "dot-reply-gate-")), workerFile = join(root, "worker.json"), frontFile = join(root, "front.json"), log = join(root, "claude.json");
  writeFileSync(workerFile, JSON.stringify({ version: 1, selectedThreadId: "one", threads: [{ id: "one", title: "Test", status: "idle", provider: "codex", messages: [] }], requests: [] }));
  prepareFrontState(workerFile, frontFile);
  const owner = { root, claude: [] as ClaudeCode[], notices: undefined as Notifications | undefined }; owned.push(owner);
  const config = { root, workerFile, frontFile, origin: "http://127.0.0.1:19453", login: "test" };
  async function start() {
    const claude = new ClaudeCode([process.execPath, join(import.meta.dir, "mock-claude.ts"), log, mode], root); owner.claude.push(claude);
    const session = new Sessions(detachedWorker(), frontFile, root, claude, undefined, frontOptions(config)); await session.ready;
    return session;
  }
  const session = await start(), notices: PushNotice[] = [];
  owner.notices = new Notifications(join(root, "notifications.json"), { async send(_device, notice) { notices.push(notice); return "sent"; }, close() {} });
  owner.notices.register({ deviceId: "86d9e0a8-0b81-49e0-b3d4-1b06a7e7909c", enabled: true, token: "a".repeat(64), environment: "development", language: "en" });
  session.observeNotifications(o => owner.notices!.observe(o));
  return { session, start, notices, flush: () => owner.notices!.flush(),
    state: () => JSON.parse(readFileSync(frontFile, "utf8")), calls: () => { try { return JSON.parse(readFileSync(log, "utf8")).calls; } catch { return []; } } };
}

test("overflow is revised by tool-disabled Claude and published only after actual Bend measurement", async () => {
  expect(await renderedReplyLines("one\ntwo\nthree\nfour", 238)).toBe(4);
  expect(await renderedReplyLines("one\ntwo\nthree\nfour\nfive", 238)).toBe(5);
  const f = await fixture("reply-compact"); f.session.submit({ requestId: "brief", text: "Is the change installed?" });
  await until(() => f.session.snapshot().threads[0].status !== "working"); await f.flush();
  const state = f.state(), receipt = state.requests[0], messages = state.threads[0].messages.filter((m: any) => m.role === "assistant");
  expect(messages).toHaveLength(1); expect(messages[0].text).toBe("Done; the requested change is installed.");
  expect(await renderedReplyLines(messages[0].text, 238)).toBeLessThanOrEqual(4);
  expect(receipt.reply.status).toBe("published"); expect(receipt.reply.drafts[0].text).toContain("necessary final detail");
  expect(receipt.reply.acceptedId).toBe(messages[0].id); expect(receipt.phase).toBe("completed");
  expect(f.notices.map(n => n.kind)).toEqual(["completed"]);
  const call = f.calls()[1]; expect(call.args).toContain("--no-session-persistence");
  expect(call.args[call.args.indexOf("--tools") + 1]).toBe("");
  expect(JSON.parse(call.args[call.args.indexOf("--mcp-config") + 1])).toEqual({ mcpServers: {} });
  expect(call.args).not.toContain("--resume");
  expect(f.calls()[0].args).toContain("--system-prompt-snapshot");
  f.session.submit({ requestId: "followup", text: "What did you just tell me?" });
  await until(() => f.calls().length >= 3);
  expect(f.calls()[2].input.message.content).toContain("latest reply actually shown to the user");
  expect(f.calls()[2].input.message.content).toContain('"text":"Done; the requested change is installed."');
  await until(() => f.session.snapshot().threads[0].status !== "working");
});

test("a pending review exposes no draft and sends no premature completion notification", async () => {
  const f = await fixture("reply-review-hold"); f.session.submit({ requestId: "held", text: "Is it installed?" });
  await until(() => f.calls().length === 2); await f.flush();
  expect(f.session.snapshot().threads[0].messages.filter(m => m.role === "assistant")).toHaveLength(0);
  expect(f.state().requests[0].phase).toBe("submitted"); expect(f.state().requests[0].reply.status).toBe("reviewing"); expect(f.notices).toHaveLength(0);
  await f.session.stop({ threadId: "one" }); await until(() => f.session.snapshot().threads[0].status === "idle");
  const restarted = await f.start();
  expect(restarted.snapshot().threads[0].messages.filter(m => m.role === "assistant")).toHaveLength(0);
  expect(f.state().requests[0].reply.drafts[0].text).toContain("necessary final detail");
  expect(f.notices).toHaveLength(0);
});

test("two overflowing revisions fail without publishing, and recovery cannot resurrect their raw drafts", async () => {
  const f = await fixture("reply-repeat-overflow"); f.session.submit({ requestId: "too-long", text: "Just the result." });
  await until(() => f.session.snapshot().threads[0].status === "failed"); await f.flush();
  expect(f.calls()).toHaveLength(3); expect(f.state().requests[0].reply.reviews).toHaveLength(2);
  expect(f.state().requests[0].phase).toBe("failed"); expect(f.state().requests[0].reply.status).toBe("failed");
  expect(f.notices.some(n => n.kind === "completed")).toBe(false);
  expect(f.session.snapshot().threads[0].messages.filter(m => m.role === "assistant")).toHaveLength(0);
  const restarted = await f.start();
  expect(restarted.snapshot().threads[0].messages.filter(m => m.role === "assistant")).toHaveLength(0);
  expect(f.state().requests[0].reply.drafts[0].text).toContain("necessary final detail");
  const schema = JSON.parse(f.calls()[2].args[f.calls()[2].args.indexOf("--json-schema") + 1]);
  expect(schema.properties.decision.enum).toEqual(["brief"]);
});

for (const mode of ["requested", "necessary"] as const) test(`an explicit ${mode} long-answer exemption preserves every original line`, async () => {
  const f = await fixture(`reply-${mode}`); f.session.submit({ requestId: mode, text: mode === "requested" ? "Give the full explanation." : "Give an accurate answer including the essential qualification." });
  await until(() => f.session.snapshot().threads[0].status === "idle");
  const state = f.state(), receipt = state.requests[0], message = state.threads[0].messages.at(-1);
  expect(receipt.reply.mode).toBe(mode); expect(receipt.reply.reason.length).toBeGreaterThan(0);
  expect(message.text).toBe(receipt.reply.drafts[0].text); expect(await renderedReplyLines(message.text, 238)).toBeGreaterThan(4);
  const restarted = await f.start();
  expect(restarted.snapshot().threads[0].messages.filter(m => m.role === "assistant")).toHaveLength(1);
  expect(f.state().threads[0].messages.at(-1).text).toBe(message.text);
});
