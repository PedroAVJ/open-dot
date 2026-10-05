import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AppServer } from "../rpc.ts";
import { ClaudeCode } from "../claude.ts";
import { Sessions, type Audio } from "../session.ts";
import { type VoiceProcessor, TONE_MODEL, parseTone } from "../voice.ts";
import { httpHandler } from "../server.ts";
import { audioUpload, audioDownload } from "../audio.ts";
import { imageUpload, imagePath, readImage } from "../images.ts";
import { Notifications } from "../notifications.ts";
import type { PushNotice } from "../apns.ts";

const pixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const pixelJpeg = Buffer.from("/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+L6KKK/lM/38P//Z", "base64");
function imageRequest(metadata: unknown, bytes = pixelPng, mimeType = "image/png", login = "owner@test") {
  const body = new FormData(); body.set("image", new File([new Uint8Array(bytes)], mimeType === "image/png" ? "photo.png" : "photo.jpg", { type: mimeType }));
  body.set("metadata", JSON.stringify(metadata));
  return new Request("https://mini.tail.test:9453/api/image", { method: "POST", headers: { Origin: "https://mini.tail.test:9453", "Tailscale-User-Login": login }, body });
}

const owned: { rpc: AppServer; root: string; claude?: ClaudeCode }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) { item.rpc.close(); item.claude?.close(); await Bun.sleep(50); rmSync(item.root, { recursive: true, force: true }); }
});
async function fixture(mode = "complete", existingRoot?: string, timeoutMs = 2_000, claudeMode?: string, voiceProcessor: VoiceProcessor = async () => ({ transcript: "Hello from voice", tone: { model: TONE_MODEL, summary: "Even, measured delivery.", segments: [] } })) {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), "dot-harness-test-"));
  const rpc = new AppServer([process.execPath, join(import.meta.dir, "mock-app-server.ts"), join(root, "official.json"), mode], root, timeoutMs);
  const claude = claudeMode ? new ClaudeCode([process.execPath, join(import.meta.dir, "mock-claude.ts"), join(root, "claude.json"), claudeMode], root) : undefined;
  owned.push({ rpc, root, claude });
  const sessions = new Sessions(rpc, join(root, "session.json"), root, claude, voiceProcessor);
  await sessions.ready;
  const official = () => JSON.parse(readFileSync(join(root, "official.json"), "utf8"));
  return { root, rpc, sessions, official, claude };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Timed out waiting for test event"); await Bun.sleep(10); }
}
const selected = (sessions: Sessions) => {
  const snapshot = sessions.snapshot(); return snapshot.threads.find((t) => t.id === snapshot.selectedThreadId)!;
};

test("saved provider completion emits one notification without exposing reply content", async () => {
  const f = await fixture("complete");
  const delivered: PushNotice[] = [];
  const notices = new Notifications(join(f.root, "notifications.json"), {
    async send(_device, notice) { delivered.push(notice); return "sent"; }, close() {},
  });
  try {
    notices.register({ deviceId: "86d9e0a8-0b81-49e0-b3d4-1b06a7e7909c", enabled: true,
      token: "a".repeat(64), environment: "development", language: "en" });
    f.sessions.observeNotifications((observation) => notices.observe(observation));
    f.sessions.submit({ requestId: "notification-turn", text: "Private user text" });
    await until(() => selected(f.sessions).status === "idle");
    await notices.flush();
    expect(delivered).toHaveLength(1); expect(delivered[0].kind).toBe("completed");
    expect(JSON.stringify(delivered)).not.toContain("Private user text");
    expect(JSON.stringify(delivered)).not.toContain("Hello world");
  } finally { notices.close(); }
});

test("measured inline overflow reaches Codex starts and follow-ups without changing stored user text", async () => {
  const f = await fixture("hold");
  f.sessions.observeDisplay(new URLSearchParams({ inlineLines: "4", messageWidth: "212", assistantLines: "9" }));
  f.sessions.submit({ requestId: "display-first", text: "First question" });
  await until(() => !!f.official().calls.find((call: any) => call.method === "turn/start"));
  f.sessions.submit({ requestId: "display-followup", text: "Second question" });
  await until(() => !!f.official().calls.find((call: any) => call.method === "turn/steer"));
  for (const method of ["turn/start", "turn/steer"]) {
    const text = f.official().calls.find((call: any) => call.method === method).params.input[0].text;
    expect(text).toContain("up to 4 rendered lines at 212px");
    expect(text).toContain("9 rendered lines and exceeds that limit");
    expect(text).toEndWith(method === "turn/start" ? "First question" : "Second question");
  }
  expect(selected(f.sessions).messages.filter(message => message.role === "user").map(message => message.text)).toEqual(["First question", "Second question"]);
});

test("session polls validate display feedback and carry its budget into Claude", async () => {
  const f = await fixture("complete", undefined, 2_000, "complete");
  const handler = httpHandler(f.sessions, { allowedLogin: "", publicHost: "localhost" });
  expect((await handler(new Request("http://localhost/api/session?inlineLines=4&messageWidth=212&assistantLines=3"))).status).toBe(200);
  expect((await handler(new Request("http://localhost/api/session?inlineLines=4&messageWidth=NaN&assistantLines=9"))).status).toBe(400);
  expect((await handler(new Request("http://localhost/api/session?inlineLines=4&messageWidth=212&assistantLines=-1"))).status).toBe(400);
  f.sessions.setProvider({ provider: "claude" });
  f.sessions.submit({ requestId: "display-claude", text: "Latest question" });
  await until(() => selected(f.sessions).status === "idle");
  const text = JSON.parse(readFileSync(join(f.root, "claude.json"), "utf8")).calls[0].input.message.content;
  expect(text).toContain("up to 4 rendered lines at 212px");
  expect(text).toContain("3 rendered lines and fits that limit");
  expect(text).toEndWith("Latest question");
});

test("Claude and Codex share one durable conversation, hand off context and pin deduplicated provider receipts", async () => {
  const f = await fixture("complete", undefined, 2_000, "complete");
  f.sessions.submit({ requestId: "first-codex", text: "Hello" });
  await until(() => selected(f.sessions).status === "idle");
  const id = selected(f.sessions).id;
  f.sessions.setProvider({ provider: "claude" });
  const input = { requestId: "first-claude", text: "Continue this", provider: "claude" };
  const acknowledgment = f.sessions.submit(input);
  expect(acknowledgment.provider).toBe("claude");
  expect(acknowledgment.acceptedRequestIds).toEqual(["first-codex", "first-claude"]);
  expect(() => f.sessions.setProvider({ provider: "codex" })).toThrow("current turn");
  f.sessions.submit(input);
  await until(() => selected(f.sessions).status === "idle");
  expect(f.sessions.snapshot().threads).toHaveLength(1);
  expect(selected(f.sessions).id).toBe(id);
  expect(selected(f.sessions).messages).toMatchObject([
    { role: "user", text: "Hello" }, { role: "assistant", text: "Hello world" },
    { role: "user", text: "Continue this" }, { role: "assistant", text: "Claude reply" },
  ]);
  const state = JSON.parse(readFileSync(join(f.root, "claude.json"), "utf8"));
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0].input.message.content).toContain("Hello world");
  expect(state.calls[0].args).toContain("auto");
  expect(state.calls[0].args).toContain("none");
  expect(state.calls[0].args).not.toContain("--dangerously-skip-permissions");
  f.sessions.setProvider({ provider: "codex" });
  f.sessions.submit(input); // retry acknowledges its pinned original provider
  expect(() => f.sessions.submit({ ...input, provider: "codex" })).toThrow("another provider");
  f.sessions.submit({ requestId: "codex-after-claude", text: "Keep going", provider: "codex" });
  await until(() => selected(f.sessions).status === "idle");
  expect(f.official().calls.filter((call: any) => call.method === "turn/start").at(-1).params.input[0].text).toContain("Claude reply");
  f.sessions.setProvider({ provider: "claude" });
  f.sessions.submit({ requestId: "claude-resume", text: "Continue again" });
  await until(() => selected(f.sessions).status === "idle");
  const later = JSON.parse(readFileSync(join(f.root, "claude.json"), "utf8"));
  expect(later.calls[1].resume).toBe(true);
  expect(later.calls[1].sessionId).toBe(later.calls[0].sessionId);
  expect(later.calls[1].input.message.content).toContain("Keep going");
  expect(f.sessions.health().providers.claude.model).toBe("claude-test-model");
});

test("Claude cancellation, process failure and restart preserve acknowledgments without replay", async () => {
  const f = await fixture("complete", undefined, 2_000, "hold");
  f.sessions.setProvider({ provider: "claude" });
  f.sessions.submit({ requestId: "claude-stop", text: "Wait", provider: "claude" });
  await until(() => existsSync(join(f.root, "claude.json")));
  await f.sessions.stop({ threadId: selected(f.sessions).id });
  await until(() => selected(f.sessions).status === "idle");
  expect(selected(f.sessions).error).toBe("Turn stopped.");
  f.rpc.close(); f.claude?.close(); owned.pop(); await Bun.sleep(50);
  const resumed = await fixture("complete", f.root, 2_000, "exit");
  expect(resumed.sessions.snapshot().provider).toBe("claude");
  resumed.sessions.submit({ requestId: "claude-stop", text: "Wait", provider: "claude" });
  expect(JSON.parse(readFileSync(join(f.root, "claude.json"), "utf8")).calls).toHaveLength(1);
  resumed.sessions.submit({ requestId: "claude-exit", text: "Continue" });
  await until(() => selected(resumed.sessions).status === "failed");
  expect(selected(resumed.sessions).error).toContain("not resent");
  resumed.sessions.submit({ requestId: "claude-exit", text: "Continue" });
  expect(JSON.parse(readFileSync(join(f.root, "claude.json"), "utf8")).calls).toHaveLength(2);
});

test("Claude authentication failure leaves Codex usable and the mobile API exposes no provider selector", async () => {
  const f = await fixture("complete", undefined, 2_000, "unauthenticated");
  expect(() => f.sessions.setProvider({ provider: "claude" })).toThrow("not authenticated");
  expect(f.sessions.snapshot().provider).toBe("codex");
  f.sessions.submit({ requestId: "codex-still-works", text: "Hello" });
  await until(() => selected(f.sessions).status === "idle");
  const handler = httpHandler(f.sessions, { allowedLogin: "", publicHost: "" });
  const request = (provider: string) => handler(new Request("http://localhost:19453/api/provider", {
    method: "POST", headers: { Origin: "http://localhost:19453", "Content-Type": "application/json" }, body: JSON.stringify({ provider }),
  }));
  for (const provider of ["other", "codex", "claude"]) expect((await request(provider)).status).toBe(404);
});

test("voice messages retain private M4A bytes, deduplicate uploads and route recognized context once", async () => {
  const f = await fixture();
  const handler = httpHandler(f.sessions, { allowedLogin: "owner@test", publicHost: "mini.tail.test:9453" });
  const bytes = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 77, 52, 65, 32, 0, 0, 0, 0, 109, 112, 52, 50]);
  const upload = (metadata: any, login = "owner@test", payload = bytes) => {
    const body = new FormData(); body.set("audio", new File([payload], "clip.m4a", { type: "audio/mp4" })); body.set("metadata", JSON.stringify(metadata));
    return handler(new Request("https://mini.tail.test:9453/api/audio", { method: "POST", headers: { Origin: "https://mini.tail.test:9453", "Tailscale-User-Login": login }, body }));
  };
  const metadata = { requestId: "voice-1", clipId: "owned-clip", threadId: selected(f.sessions).id, durationMs: 1200, provider: "codex" };
  expect((await upload(metadata, "other@test")).status).toBe(403);
  const saved = await upload(metadata);
  expect(saved.status).toBe(202);
  const snapshot = await saved.json() as any;
  const audio = snapshot.threads[0].messages[0].audio;
  expect(audio).toMatchObject({ durationMs: 1200, mimeType: "audio/mp4", transcriptionStatus: "processing" });
  expect(snapshot.acceptedRequestIds).toEqual(["voice-1"]);
  expect(snapshot.threads[0].status).toBe("working");
  expect(f.official().calls.filter((call: any) => call.method === "turn/start")).toHaveLength(0);
  const artifact = join(f.sessions.audioDirectory(), `${audio.id}.m4a`);
  expect(new Uint8Array(readFileSync(artifact))).toEqual(bytes);
  expect(statSync(artifact).mode & 0o777).toBe(0o600);
  const download = (headers: HeadersInit = {}) => handler(new Request(`https://mini.tail.test:9453${audio.url}`, { headers }));
  expect((await download()).status).toBe(403);
  const playback = await download({ "Tailscale-User-Login": "owner@test" });
  expect(playback.headers.get("Content-Type")).toBe("audio/mp4");
  expect(new Uint8Array(await playback.arrayBuffer())).toEqual(bytes);
  const range = await download({ "Tailscale-User-Login": "owner@test", Range: "bytes=4-7" });
  expect(range.status).toBe(206); expect(await range.text()).toBe("ftyp");
  expect((await upload({ ...metadata, transcript: "FORGED client transcript" })).status).toBe(202);
  await until(() => selected(f.sessions).status === "idle");
  expect(selected(f.sessions).messages[0].audio).toMatchObject({ transcriptionStatus: "ready", transcriptionModel: "scribe_v2", transcript: "Hello from voice", tone: { model: TONE_MODEL } });
  const prompt = f.official().calls.find((call: any) => call.method === "turn/start").params.input[0].text;
  expect(prompt).toContain("Hello from voice"); expect(prompt).toContain("Even, measured delivery.");
  expect(prompt).not.toContain("FORGED"); expect(prompt).toContain(artifact);
  expect(f.official().calls.filter((call: any) => call.method === "turn/start")).toHaveLength(1);
  expect((await upload({ ...metadata, transcript: "Hello from voice" })).status).toBe(202);
  expect(f.official().calls.filter((call: any) => call.method === "turn/start")).toHaveLength(1);
  expect((await upload(metadata, "owner@test", new Uint8Array([...bytes, 1]))).status).toBe(409);
  expect((await upload({ ...metadata, requestId: "bad-transcript", transcript: 2 })).status).toBe(400);
  expect((await upload({ ...metadata, requestId: "too-long", durationMs: 900_001 })).status).toBe(400);
});

test("search filters the ongoing saved conversation without changing provider or hidden histories", async () => {
  const f = await fixture("complete", undefined, 2_000, "complete");
  f.sessions.submit({ requestId: "search-one", text: "Needle in the first message" });
  await until(() => selected(f.sessions).status === "idle");
  f.sessions.setProvider({ provider: "claude" });
  f.sessions.submit({ requestId: "search-two", text: "Another message" });
  await until(() => selected(f.sessions).status === "idle");
  const before = readFileSync(join(f.root, "session.json"), "utf8");
  const handler = httpHandler(f.sessions, { allowedLogin: "", publicHost: "" });
  const response = await handler(new Request("http://localhost:19453/api/search?q=NEEDLE"));
  const result = await response.json() as any;
  expect(result.threads).toHaveLength(1);
  expect(result.threads[0].messages).toMatchObject([{ role: "user", text: "Needle in the first message" }]);
  expect(result.provider).toBe("claude");
  expect(result.acceptedRequestIds).toEqual(["search-one", "search-two"]);
  expect(readFileSync(join(f.root, "session.json"), "utf8")).toBe(before);
  expect((await handler(new Request(`http://localhost:19453/api/search?q=${"x".repeat(201)}`))).status).toBe(400);
});

test("search pages only matching long-message chunks including boundary spans and literal JSON query characters", async () => {
  const root = mkdtempSync(join(tmpdir(), "dot-harness-test-"));
  const beginning = "UNIQUE_START_MATCH&/#/+/%", middle = "UNIQUE_MIDDLE_MATCH&/#/+/%", ending = "UNIQUE_END_MATCH&/#/+/%", boundary = "UNIQUE_BOUNDARY_MATCH&/#/+/%";
  const chars = Array(30_100).fill("x");
  for (const [offset, marker] of [[0, beginning], [5994, boundary], [12_040, middle], [30_050, ending]] as const) chars.splice(offset, marker.length, ...marker);
  const source = chars.join("");
  writeFileSync(join(root, "session.json"), JSON.stringify({ version: 1, selectedThreadId: "long-search", requests: [], threads: [
    { id: "long-search", title: "Search", status: "idle", messages: [{ id: "long", role: "assistant", text: source }] },
    { id: "archived", title: "Hidden", status: "idle", messages: [{ id: "hidden", role: "assistant", text: beginning }] },
  ] }));
  const f = await fixture("complete", root), handler = httpHandler(f.sessions, { allowedLogin: "", publicHost: "" });
  const saved = readFileSync(join(root, "session.json"), "utf8");
  for (const [marker, chunk] of [[beginning, 0], [middle, 2], [ending, 5], [boundary, 0]] as const) {
    const response = await handler(new Request("http://localhost:19453/api/search", { method: "POST", headers: { Origin: "http://localhost:19453", "Content-Type": "application/json" }, body: JSON.stringify({ query: marker.toLowerCase() }) }));
    expect(response.status).toBe(200);
    const snapshot = await response.json() as any;
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.threads[0].messages).toHaveLength(1);
    expect(snapshot.threads[0].messages[0].id).toBe(`long:${chunk}`);
    expect(snapshot.threads[0].messages[0].text).toContain(marker);
    expect(snapshot.threads[0].messages[0].text.length).toBeLessThanOrEqual(6000);
  }
  expect(f.sessions.snapshot(undefined, "ABSENT&/#/+/%").threads[0].messages).toEqual([]);
  expect(readFileSync(join(root, "session.json"), "utf8")).toBe(saved);
});

test("latest assistant keeps the complete reply and distinguishes identical answers by stored id", async () => {
  const f = await fixture();
  f.sessions.submit({ requestId: "same-first", text: "Hello" });
  await until(() => selected(f.sessions).status === "idle");
  const first = f.sessions.snapshot(undefined, undefined, true).threads[0].latestAssistant!;
  expect(first).toEqual({ id: "assistant-1", text: "Hello world" });
  expect(selected(f.sessions).messages.at(-1)?.id).toBe(`${first.id}:0`);
  await Bun.sleep(10);
  f.sessions.submit({ requestId: "same-second", text: "Hello again" });
  await until(() => selected(f.sessions).status === "idle");
  const second = f.sessions.snapshot(undefined, undefined, true).threads[0].latestAssistant!;
  expect(second.text).toBe(first.text);
  expect(second.id).not.toBe(first.id);
  expect(f.sessions.snapshot(undefined, "Hello").threads[0].latestAssistant).toEqual({ id: second.id });
  expect(selected(f.sessions).latestAssistant).toEqual({ id: second.id });
  const handler = httpHandler(f.sessions, { allowedLogin: "", publicHost: "" });
  const call = await handler(new Request("http://localhost:19453/api/session?call=1"));
  expect((await call.json() as any).threads[0].latestAssistant).toEqual(second);
});

test("Claude transcript recovery preserves valid rows around corrupt lines and reports the skipped rows", async () => {
  const f = await fixture("complete", undefined, 2_000, "complete");
  const sessionId = "8e6cd1b1-5cb3-4b2a-b9a0-c3f8da27e62b";
  const transcript = join(f.root, "claude-projects", "project", `${sessionId}.jsonl`);
  const row = (id: string, text: string, overrides = {}) => JSON.stringify({ type: "assistant", sessionId, message: { id, content: [{ type: "text", text }] }, ...overrides });
  writeFileSync(transcript, `${row("one", "Saved first")}\n{"type":"assistant","message":`);
  expect(f.claude!.recoveredMessages(sessionId)).toEqual([{ id: "one", role: "assistant", text: "Saved first" }]);
  expect(f.claude!.recoveryWarnings[0]).toContain("incomplete final transcript row at line 2");
  expect(f.sessions.health().providers.claude.recoveryWarnings).toEqual(f.claude!.recoveryWarnings);
  writeFileSync(transcript, `${row("one", "Saved first")}\nBROKEN\n${row("two", "Saved second")}\n${row("side", "Hidden subagent", { isSidechain: true })}\n${row("other", "Other session", { sessionId: "different" })}\nnull\n`);
  expect(f.claude!.recoveredMessages(sessionId)).toEqual([
    { id: "one", role: "assistant", text: "Saved first" }, { id: "two", role: "assistant", text: "Saved second" },
  ]);
  expect(f.claude!.recoveryWarnings).toHaveLength(2);
  expect(f.claude!.recoveryWarnings[0]).toContain("invalid transcript row at line 2");
  expect(f.claude!.recoveryWarnings[1]).toContain("invalid transcript row at line 6");
  writeFileSync(transcript, `${row("one", "Saved first")}\n`);
  expect(f.claude!.recoveredMessages(sessionId)).toHaveLength(1);
  expect(f.claude!.recoveryWarnings).toEqual([]);
});

test("Claude recovery uses the configured projects directory when real auth status omits it", async () => {
  const root = mkdtempSync(join(tmpdir(), "dot-harness-test-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, "isolated-claude-config");
  try {
    const f = await fixture("complete", root, 2_000, "no-projects-directory");
    f.sessions.setProvider({ provider: "claude" });
    f.sessions.submit({ requestId: "recover-with-config", text: "Hello" });
    await until(() => selected(f.sessions).status === "idle");
    const state = JSON.parse(readFileSync(join(root, "claude.json"), "utf8"));
    const sessionId = state.calls[0].sessionId;
    expect(existsSync(join(process.env.CLAUDE_CONFIG_DIR!, "projects", "project", `${sessionId}.jsonl`))).toBe(true);
    expect(f.claude!.recoveredMessages(sessionId)).toMatchObject([
      { role: "user", text: "Hello" }, { role: "assistant", text: "Claude reply" },
    ]);
    expect(f.claude!.recoveryWarnings).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test("audio publication deduplicates complete artifacts and rejects partial, corrupt and symlinked saved bytes", async () => {
  const f = await fixture();
  const directory = f.sessions.audioDirectory();
  const bytes = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 77, 52, 65, 32, 0, 0, 0, 0, 109, 112, 52, 50]);
  const id = createHash("sha256").update(bytes).digest("hex");
  const path = join(directory, `${id}.m4a`);
  const upload = () => {
    const body = new FormData(); body.set("audio", new File([bytes], "clip.m4a", { type: "audio/mp4" }));
    body.set("metadata", JSON.stringify({ durationMs: 1200 }));
    return audioUpload(new Request("http://localhost/api/audio", { method: "POST", body }), directory);
  };
  const results = await Promise.all([upload(), upload()]);
  expect(results.map(({ audio }) => audio.id)).toEqual([id, id]);
  expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const fs = await import("node:fs");
  expect(fs.readdirSync(directory)).toEqual([`${id}.m4a`]);
  for (const damaged of [bytes.subarray(0, 10), new Uint8Array([...bytes.subarray(0, bytes.length - 1), 0])]) {
    writeFileSync(path, damaged);
    await expect(upload()).rejects.toThrow("saved voice message is damaged");
    expect(new Uint8Array(readFileSync(path))).toEqual(damaged);
    expect(() => audioDownload(directory, id, new Request("http://localhost/api/audio"))).toThrow("Voice message not found");
    expect(fs.readdirSync(directory)).toEqual([`${id}.m4a`]);
  }
  rmSync(path);
  const target = join(f.root, "outside.m4a"); writeFileSync(target, bytes); symlinkSync(target, path);
  await expect(upload()).rejects.toThrow("saved voice message is damaged");
  expect(new Uint8Array(readFileSync(target))).toEqual(bytes);
  expect(fs.readdirSync(directory)).toEqual([`${id}.m4a`]);
});

test("photos retain exact bytes/caption, privately download and send actual Codex image inputs once", async () => {
  const f = await fixture();
  const handler = httpHandler(f.sessions, { allowedLogin: "owner@test", publicHost: "mini.tail.test:9453" });
  const metadata = { requestId: "photo-one", threadId: selected(f.sessions).id, imageId: "picked-one", text: "  Read this picture  ", width: 1, height: 1 };
  expect((await handler(imageRequest(metadata, pixelPng, "image/png", "other@test"))).status).toBe(403);
  const response = await handler(imageRequest(metadata)); expect(response.status).toBe(202);
  const snapshot = await response.json() as any, message = snapshot.threads[0].messages[0], image = message.image;
  expect(message.text).toBe(metadata.text);
  expect(image).toMatchObject({ width: 1, height: 1, mimeType: "image/png", id: createHash("sha256").update(pixelPng).digest("hex") });
  const file = imagePath(f.sessions.imageDirectory(), image);
  expect(readFileSync(file)).toEqual(pixelPng); expect(statSync(file).mode & 0o777).toBe(0o600);
  const download = (method = "GET", extra: HeadersInit = {}, login = "owner@test") => handler(new Request(`https://mini.tail.test:9453${image.url}`, { method, headers: { "Tailscale-User-Login": login, ...extra } }));
  expect((await download("GET", {}, "other@test")).status).toBe(403);
  const got = await download(); expect(got.headers.get("Content-Type")).toBe("image/png"); expect(Buffer.from(await got.arrayBuffer())).toEqual(pixelPng);
  const head = await download("HEAD"); expect(head.headers.get("Content-Length")).toBe(String(pixelPng.length)); expect((await head.arrayBuffer()).byteLength).toBe(0);
  const range = await download("GET", { Range: "bytes=0-7" }); expect(range.status).toBe(206); expect(Buffer.from(await range.arrayBuffer())).toEqual(pixelPng.subarray(0, 8));
  expect((await download("GET", { Range: "bytes=0-9999" })).status).toBe(416);
  await until(() => selected(f.sessions).status === "idle");
  const inputs = f.official().calls.find((call: any) => call.method === "turn/start").params.input;
  expect(inputs).toEqual([{ type: "text", text: metadata.text, text_elements: [] }, { type: "localImage", path: file }]);
  expect((await handler(imageRequest(metadata))).status).toBe(202);
  expect((await handler(imageRequest({ ...metadata, text: "Changed caption" }))).status).toBe(409);
  expect(f.official().calls.filter((call: any) => call.method === "turn/start")).toHaveLength(1);
  expect(selected(f.sessions).messages.find((item) => item.role === "user")?.image).toEqual(image);
  expect((await handler(new Request(`https://mini.tail.test:9453/api/image/${"0".repeat(64)}`, { headers: { "Tailscale-User-Login": "owner@test" } }))).status).toBe(404);
});

test("image-only Claude turns use real base64 blocks and provider handoffs retain the actual photo", async () => {
  const f = await fixture("complete", undefined, 2_000, "complete");
  f.sessions.setProvider({ provider: "claude" });
  const handler = httpHandler(f.sessions, { allowedLogin: "owner@test", publicHost: "mini.tail.test:9453" });
  const metadata = { requestId: "claude-photo", threadId: selected(f.sessions).id, imageId: "photo-claude", text: "", width: 1, height: 1 };
  expect((await handler(imageRequest(metadata))).status).toBe(202);
  await until(() => selected(f.sessions).status === "idle");
  const state = JSON.parse(readFileSync(join(f.root, "claude.json"), "utf8"));
  expect(state.calls[0].input.message.content).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: pixelPng.toString("base64") } }]);
  expect(selected(f.sessions).messages[0].text).toBe("");
  f.sessions.setProvider({ provider: "codex" });
  f.sessions.submit({ requestId: "codex-photo-followup", text: "Explain the previous photo" });
  await until(() => selected(f.sessions).status === "idle");
  const input = f.official().calls.find((call: any) => call.method === "turn/start").params.input;
  expect(input[0].text).toContain('"image"');
  expect(input[1].type).toBe("localImage"); expect(readFileSync(input[1].path)).toEqual(pixelPng);
});

test("photo container/dimension checks and atomic publication reject corrupt saved files", async () => {
  const f = await fixture(); const directory = f.sessions.imageDirectory();
  const metadata = { imageId: "photo", text: "Caption", width: 1, height: 1 };
  const saved = await imageUpload(imageRequest(metadata, pixelJpeg, "image/jpeg"), directory);
  expect(saved.image).toMatchObject({ mimeType: "image/jpeg", width: 1, height: 1 });
  expect(readImage(directory, saved.image)).toEqual(pixelJpeg);
  await expect(imageUpload(imageRequest({ ...metadata, width: 2 }, pixelJpeg, "image/jpeg"), directory)).rejects.toThrow("dimensions");
  await expect(imageUpload(imageRequest(metadata, pixelPng, "image/jpeg"), directory)).rejects.toThrow("type does not match");
  const badCrc = Buffer.from(pixelPng); badCrc[badCrc.length - 1] ^= 1;
  await expect(imageUpload(imageRequest(metadata, badCrc), directory)).rejects.toThrow("Invalid PNG");
  await expect(imageUpload(imageRequest(metadata, pixelJpeg.subarray(0, pixelJpeg.length - 2), "image/jpeg"), directory)).rejects.toThrow("Invalid photo container");
  const path = imagePath(directory, saved.image); writeFileSync(path, pixelJpeg.subarray(0, 40));
  await expect(imageUpload(imageRequest(metadata, pixelJpeg, "image/jpeg"), directory)).rejects.toThrow("saved photo is damaged");
  rmSync(path); const target = join(f.root, "outside.jpg"); writeFileSync(target, pixelJpeg); symlinkSync(target, path);
  await expect(imageUpload(imageRequest(metadata, pixelJpeg, "image/jpeg"), directory)).rejects.toThrow("saved photo is damaged");
  expect(readFileSync(target)).toEqual(pixelJpeg);
  const fs = await import("node:fs"); expect(fs.readdirSync(directory)).toEqual([`${saved.image.id}.jpg`]);
});

test("acknowledges immediately, streams real items, deduplicates and resumes official history", async () => {
  const f = await fixture(); const id = selected(f.sessions).id;
  const input = { threadId: id, requestId: "phone-1", text: "Hello" };
  const accepted = f.sessions.submit(input);
  expect(accepted.acceptedRequestIds).toEqual(["phone-1"]);
  expect(accepted.threads[0].status).toBe("working");
  expect(accepted.threads[0].messages).toMatchObject([{ role: "user", text: "Hello" }]);
  f.sessions.submit(input);
  await until(() => selected(f.sessions).status === "idle");
  expect(selected(f.sessions).messages).toMatchObject([{ role: "user", text: "Hello" }, { role: "assistant", text: "Hello world" }]);
  expect(f.official().calls.filter((x: any) => x.method === "turn/start")).toHaveLength(1);
  const params = f.official().calls.find((x: any) => x.method === "thread/start").params;
  expect(params).toMatchObject({ sandbox: "danger-full-access", approvalPolicy: "never", approvalsReviewer: "user" });
  expect(f.official().calls.find((x: any) => x.method === "turn/start").params).toMatchObject({ sandboxPolicy: { type: "dangerFullAccess" }, approvalPolicy: "never", approvalsReviewer: "user" });
  expect(params.model).toBe("canonical-test-model");
  expect(f.official().calls.find((x: any) => x.method === "turn/start").params.model).toBe("canonical-test-model");
  expect(f.sessions.health().model).toBe("canonical-test-model");
  f.rpc.close(); owned.pop(); await Bun.sleep(50);
  const resumed = await fixture("complete", f.root);
  expect(selected(resumed.sessions).messages).toHaveLength(2);
  resumed.sessions.submit(input);
  expect(resumed.official().calls.filter((x: any) => x.method === "turn/start")).toHaveLength(1);
  expect(resumed.official().calls.map((x: any) => x.method)).toContain("thread/resume");
  expect(resumed.official().calls.find((x: any) => x.method === "thread/resume").params.sandbox).toBe("danger-full-access");
  expect(resumed.official().calls.map((x: any) => x.method)).toContain("thread/read");
  expect(() => resumed.sessions.submit({ ...input, text: "Different" })).toThrow("different message");
});

test("follow-ups reach the running task once and stop interrupts only this session", async () => {
  const f = await fixture("hold"); const id = selected(f.sessions).id;
  f.sessions.submit({ threadId: id, requestId: "hold-1", text: "Wait" });
  await until(() => f.official().calls.some((x: any) => x.method === "turn/start"));
  const followup = { threadId: id, requestId: "hold-2", text: "Second" };
  expect(f.sessions.submit(followup).acceptedRequestIds).toEqual(["hold-1", "hold-2"]);
  await until(() => f.official().calls.some((x: any) => x.method === "turn/steer"));
  f.sessions.submit(followup);
  await Bun.sleep(30);
  expect(f.official().calls.filter((x: any) => x.method === "turn/start")).toHaveLength(1);
  expect(f.official().calls.filter((x: any) => x.method === "turn/steer")).toHaveLength(1);
  expect(f.official().calls.find((x: any) => x.method === "turn/steer").params).toMatchObject({ expectedTurnId: "turn-1", clientUserMessageId: "hold-2", input: [{ type: "text", text: "Second" }] });
  await f.sessions.stop({ threadId: id });
  await until(() => selected(f.sessions).status === "idle");
  expect(selected(f.sessions).error).toBe("Turn stopped.");
  expect(f.official().calls.find((x: any) => x.method === "turn/interrupt").params).toEqual({ threadId: "codex-1", turnId: "turn-1" });
});

test("queued stop never starts a turn; restarting never replays an uncertain submission", async () => {
  const f = await fixture("hold"); const id = selected(f.sessions).id;
  f.sessions.submit({ threadId: id, requestId: "queue-stop", text: "Cancel me" });
  await f.sessions.stop({ threadId: id });
  await until(() => selected(f.sessions).status === "idle");
  expect(f.official().calls.filter((x: any) => x.method === "turn/start")).toHaveLength(0);
  await Bun.sleep(10);
  f.sessions.submit({ threadId: id, requestId: "uncertain", text: "Hold" });
  await until(() => f.official().calls.some((x: any) => x.method === "turn/start"));
  f.rpc.close(); owned.pop(); await Bun.sleep(50);
  const resumed = await fixture("hold", f.root);
  expect(selected(resumed.sessions).status).toBe("idle");
  expect(selected(resumed.sessions).error).toContain("not resent");
  resumed.sessions.submit({ threadId: id, requestId: "uncertain", text: "Hold" });
  expect(resumed.official().calls.filter((x: any) => x.method === "turn/start")).toHaveLength(1);
});

test("surfaces provider failure and completes tool requests with affirmative protocol responses", async () => {
  const failed = await fixture("fail");
  failed.sessions.submit({ requestId: "failed-1", text: "Hello" });
  await until(() => selected(failed.sessions).status === "failed");
  expect(selected(failed.sessions).error).toBe("Provider unavailable");
  const approval = await fixture("approval");
  approval.sessions.submit({ requestId: "approval-1", text: "Hello" });
  await until(() => selected(approval.sessions).status === "idle");
  expect(approval.official().replies).toEqual([
    { id: "approval-1", result: { decision: "accept" } },
    { id: "file-1", result: { decision: "accept" } },
    { id: "permissions-1", result: { permissions: { network: { enabled: true }, fileSystem: { write: ["/tmp/dot-protocol-only"] } }, scope: "turn" } },
    { id: "photos-1", result: { action: "accept", content: {}, _meta: null } },
    { id: "boolean-1", result: { action: "accept", content: { approved: true }, _meta: null } },
    { id: "legacy-command-1", result: { decision: "approved" } },
    { id: "legacy-file-1", result: { decision: "approved" } },
  ]);
  expect(selected(approval.sessions).error).toBeUndefined();
  expect(selected(approval.sessions).messages.at(-1)?.text).toBe("Hello world");
});

test("a missing turn acknowledgement permits follow-ups without another start or replay", async () => {
  const f = await fixture("timeout", undefined, 80); const id = selected(f.sessions).id;
  const input = { threadId: id, requestId: "timeout-1", text: "Hold" };
  f.sessions.submit(input);
  await until(() => !!selected(f.sessions).error);
  expect(selected(f.sessions).status).toBe("working");
  expect(selected(f.sessions).error).toContain("unknown");
  f.sessions.submit(input);
  f.sessions.submit({ ...input, requestId: "timeout-2", text: "Follow up" });
  await until(() => f.official().calls.some((x: any) => x.method === "turn/steer"));
  await f.sessions.stop({ threadId: id });
  await until(() => selected(f.sessions).status === "idle");
  expect(f.official().calls.filter((x: any) => x.method === "turn/start")).toHaveLength(1);
});

test("a turn ending before steering starts the follow-up once in the same conversation", async () => {
  const f = await fixture("steer-end-race");
  f.sessions.submit({ requestId: "race-first", text: "First" });
  await until(() => f.official().calls.some((x: any) => x.method === "turn/start"));
  f.sessions.submit({ requestId: "race-next", text: "Next" });
  await until(() => selected(f.sessions).status === "idle");
  const turns = Object.values(f.official().threads) as any[];
  expect(turns).toHaveLength(1);
  expect(turns[0].turns).toHaveLength(2);
  expect(turns[0].turns.flatMap((t: any) => t.items).filter((i: any) => i.clientId === "race-next")).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(f.root, "session.json"), "utf8")).requests.map((r: any) => r.phase)).toEqual(["completed", "completed"]);
});

test("completion before a steering acknowledgement clears both accepted receipts", async () => {
  const f = await fixture("steer-complete-before-ack");
  f.sessions.submit({ requestId: "early-first", text: "First" });
  await until(() => f.official().calls.some((x: any) => x.method === "turn/start"));
  f.sessions.submit({ requestId: "early-next", text: "Next" });
  await until(() => selected(f.sessions).status === "idle");
  await Bun.sleep(100);
  expect(selected(f.sessions).status).toBe("idle");
  expect(JSON.parse(readFileSync(join(f.root, "session.json"), "utf8")).requests.map((r: any) => r.phase)).toEqual(["completed", "completed"]);
});

test("an unacknowledged steer is not replayed by retrying its receipt", async () => {
  const f = await fixture("steer-timeout", undefined, 80);
  f.sessions.submit({ requestId: "unknown-first", text: "First" });
  await until(() => f.official().calls.some((x: any) => x.method === "turn/start"));
  const followup = { requestId: "unknown-steer", text: "Next" };
  f.sessions.submit(followup);
  await until(() => !!selected(f.sessions).error);
  f.sessions.submit(followup);
  await Bun.sleep(30);
  expect(f.official().calls.filter((x: any) => x.method === "turn/steer")).toHaveLength(1);
  expect(selected(f.sessions).messages.filter((m) => m.role === "user")).toHaveLength(2);
  await f.sessions.stop({ threadId: selected(f.sessions).id });
});

test("voice and typed messages are accepted and delivered during a running task", async () => {
  const f = await fixture("hold");
  f.sessions.submit({ requestId: "voice-busy-first", text: "Work" });
  await until(() => f.official().calls.some((x: any) => x.method === "turn/start"));
  f.sessions.submitAudio({ requestId: "voice-busy", clipId: "busy-clip" }, testAudio);
  f.sessions.submit({ requestId: "typed-after-voice", text: "And this" });
  await until(() => f.official().calls.filter((x: any) => x.method === "turn/steer").length === 2);
  const steers = f.official().calls.filter((x: any) => x.method === "turn/steer");
  expect(steers.map((x: any) => x.params.clientUserMessageId)).toEqual(["voice-busy", "typed-after-voice"]);
  expect(steers[0].params.input[0].text).toContain("Voice message attached:");
  expect(steers[0].params.input[0].text).toContain("Hello from voice");
  expect(steers[1].params.input[0].text).toBe("And this");
  await f.sessions.stop({ threadId: selected(f.sessions).id });
});

test("completed notification wins over a later missing acknowledgement timeout", async () => {
  const f = await fixture("complete-no-ack", undefined, 80);
  f.sessions.submit({ requestId: "complete-no-ack-1", text: "Hello" });
  await until(() => selected(f.sessions).status === "idle");
  await Bun.sleep(80);
  expect(selected(f.sessions).status).toBe("idle");
  expect(selected(f.sessions).error).toBeUndefined();
  expect(selected(f.sessions).messages.at(-1)?.text).toBe("Hello world");
});

test("HTTP authenticates remote requests, enforces origin/body limits and removes chat switching and static routes", async () => {
  const f = await fixture();
  const host = "mini.tail.test:9453";
  const handler = httpHandler(f.sessions, { allowedLogin: "owner@test", publicHost: host });
  const request = (path: string, init: RequestInit = {}, remote = false) => {
    const headers = new Headers(init.headers);
    if (!remote) headers.set("Tailscale-User-Login", "owner@test");
    return handler(new Request(`${remote ? `https://${host}` : "http://127.0.0.1:19453"}${path}`, { ...init, headers }));
  };
  expect((await handler(new Request("http://localhost:19453/api/session"))).status).toBe(403);
  expect((await handler(new Request(`https://${host}/api/session`, { headers: { Host: "127.0.0.1:19453" } }))).status).toBe(403);
  expect((await request("/api/session", {}, true)).status).toBe(403);
  expect((await request("/api/session", { headers: { "Tailscale-User-Login": "other@test" } }, true)).status).toBe(403);
  expect((await request("/health", { headers: { "Tailscale-User-Login": "owner@test" } }, true)).status).toBe(200);
  expect((await request("/api/turn", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.test" }, body: "{}" })).status).toBe(403);
  const headers = { "content-type": "application/json", origin: "http://127.0.0.1:19453" };
  expect((await request("/api/turn", { method: "POST", headers, body: "{" })).status).toBe(400);
  expect((await request("/api/turn", { method: "POST", headers, body: JSON.stringify({ text: "x".repeat(128_001) }) })).status).toBe(413);
  for (const path of ["/api/new", "/api/select"]) {
    expect((await request(path, { method: "POST", headers, body: "{}" })).status).toBe(404);
  }
  expect(f.sessions.snapshot().threads).toHaveLength(1);
  const response = await request("/api/stop", { method: "POST", headers, body: JSON.stringify({ threadId: selected(f.sessions).id }) });
  expect(response.status).toBe(200);
  for (const path of ["/", "/index.html", "/worker.js"]) expect((await request(path)).status).toBe(404);
  expect((await request("/%2e%2e%2foutside.txt")).status).toBe(403);
});

test("IPA download authenticates GET and HEAD and returns only the configured binary", async () => {
  const f = await fixture();
  const artifactRoot = join(f.root, "ios-device"); mkdirSync(artifactRoot);
  const iosArtifact = join(artifactRoot, "Dot.ipa");
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0xff, 0x80, 0x42]);
  writeFileSync(iosArtifact, bytes);
  const host = "mini.tail.test:9453";
  const options = { allowedLogin: "owner@test", publicHost: host, iosArtifact };
  const handler = httpHandler(f.sessions, options);
  const request = (path = "/downloads/Dot.ipa", method = "GET", login?: string) => handler(new Request(`https://${host}${path}`, {
    method, headers: login ? { "Tailscale-User-Login": login } : {},
  }));
  for (const method of ["GET", "HEAD"]) {
    expect((await request(undefined, method)).status).toBe(403);
    expect((await request(undefined, method, "other@test")).status).toBe(403);
  }
  expect((await handler(new Request("http://localhost:19453/downloads/Dot.ipa"))).status).toBe(403);
  const response = await request(undefined, "GET", "owner@test");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
  expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="Dot.ipa"');
  expect(response.headers.get("Content-Length")).toBe(String(bytes.length));
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  const head = await request(undefined, "HEAD", "owner@test");
  expect(head.status).toBe(200);
  expect([...head.headers]).toEqual([...response.headers]);
  expect((await head.arrayBuffer()).byteLength).toBe(0);
  for (const path of ["/downloads", "/downloads/", "/downloads/other.ipa", "/downloads/Dot.ipa/extra", "/downloads%2fother.ipa", "/downloads/%44ot.ipa"]) {
    expect((await request(path, "GET", "owner@test")).status).toBe(404);
  }
  expect((await request("/downloads/%2e%2e%2foutside.ipa", "GET", "owner@test")).status).toBe(403);
  const disabled = httpHandler(f.sessions, { ...options, iosArtifact: undefined });
  expect((await disabled(new Request(`https://${host}/downloads/Dot.ipa`, { headers: { "Tailscale-User-Login": "owner@test" } }))).status).toBe(404);
});

test("IPA download rejects missing files, directories and symlinks to private files", async () => {
  const f = await fixture();
  const outside = join(f.root, "private.ipa"); writeFileSync(outside, "private artifact");
  const link = join(f.root, "Dot.ipa"); symlinkSync(outside, link);
  const outsideDirectory = join(f.root, "private-directory"); mkdirSync(outsideDirectory);
  writeFileSync(join(outsideDirectory, "Dot.ipa"), "private artifact");
  const directoryLink = join(f.root, "ios-device"); symlinkSync(outsideDirectory, directoryLink);
  for (const iosArtifact of [join(f.root, "missing.ipa"), f.root, link, join(directoryLink, "Dot.ipa")]) {
    const handler = httpHandler(f.sessions, {
      allowedLogin: "owner@test", publicHost: "mini.tail.test:9453", iosArtifact,
    });
    for (const method of ["GET", "HEAD"]) {
      const response = await handler(new Request("https://mini.tail.test:9453/downloads/Dot.ipa", {
        method, headers: { "Tailscale-User-Login": "owner@test" },
      }));
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("private artifact");
    }
  }
});

test("the ongoing conversation's full history can be paged without exposing or changing saved conversations", async () => {
  const root = mkdtempSync(join(tmpdir(), "dot-harness-test-"));
  const source = "START🧩" + "x".repeat(1_048_576) + "END🧩";
  const archived = { id: "empty", title: "Saved conversation", codexId: "archived-codex", status: "idle", messages: [{ id: "saved", role: "user", text: "Keep this saved history" }] };
  writeFileSync(join(root, "session.json"), JSON.stringify({
    version: 1, selectedThreadId: "large", requests: [
      { id: "old-receipt", hash: "test", threadId: "large", phase: "completed" },
      { id: "other-receipt", hash: createHash("sha256").update(JSON.stringify([null, "Do not switch"])).digest("hex"), threadId: "empty", phase: "completed" },
    ], threads: [
      { id: "large", title: "Long conversation", status: "idle", messages: [{ id: "message", role: "assistant", text: source }] },
      archived,
    ],
  }));
  const f = await fixture("complete", root);
  const handler = httpHandler(f.sessions, { allowedLogin: "", publicHost: "" });
  const response = await handler(new Request("http://localhost:19453/api/session"));
  expect(response.status).toBe(200);
  const initial = await response.json() as any;
  expect(initial.threads).toHaveLength(1);
  expect(initial.threads[0].id).toBe("large");
  expect(initial.acceptedRequestIds).toEqual(["old-receipt"]);
  expect(initial.threads[0].latestAssistant).toEqual({ id: "message" });
  expect(f.sessions.snapshot(undefined, undefined, true).threads[0].latestAssistant).toEqual({ id: "message", text: source });
  const largeCall = await handler(new Request("http://localhost:19453/api/session?call=1"));
  expect(largeCall.status).toBe(413);
  expect((await largeCall.json() as any).error).toContain("response limit");
  const saved = JSON.parse(readFileSync(join(root, "session.json"), "utf8"));
  expect(saved.threads[1]).toEqual(archived);
  expect(f.official().calls.some((call: any) => call.method === "thread/resume" && call.params.threadId === "archived-codex")).toBe(false);
  expect(() => f.sessions.submit({ threadId: "empty", requestId: "hidden-send", text: "Do not send" })).toThrow("Only the ongoing conversation");
  expect(() => f.sessions.submit({ threadId: "empty", requestId: "other-receipt", text: "Do not switch" })).toThrow("Only the ongoing conversation");
  expect(() => f.sessions.submit({ requestId: "other-receipt", text: "Do not switch" })).toThrow("belongs to another saved conversation");
  await expect(f.sessions.stop({ threadId: "empty" })).rejects.toThrow("Only the ongoing conversation");
  expect(JSON.parse(readFileSync(join(root, "session.json"), "utf8"))).toEqual(saved);
  const restored: string[] = []; let before: string | undefined;
  do {
    const page = await handler(new Request(`http://localhost:19453/api/session${before ? `?before=${before}` : ""}`));
    expect(page.status).toBe(200);
    const encoded = await page.text(); expect(encoded.length).toBeLessThan(30_000);
    const snapshot = JSON.parse(encoded);
    expect(snapshot.acceptedRequestIds).toEqual(["old-receipt"]);
    const selected = snapshot.threads.find((t: any) => t.id === "large");
    expect(selected.messages.length).toBeLessThanOrEqual(4);
    expect(selected.messages.every((m: any) => m.role === "assistant" && m.text.length <= 6000)).toBe(true);
    restored.unshift(...selected.messages.map((m: any) => m.text));
    before = selected.historyBefore;
    expect(selected.historyHasMore).toBe(before !== undefined);
  } while (before !== undefined);
  expect(restored.join("")).toBe(source);
  expect(JSON.parse(readFileSync(join(root, "session.json"), "utf8")).threads[0].messages[0].text).toBe(source);
  expect(JSON.parse(readFileSync(join(root, "session.json"), "utf8")).threads[1]).toEqual(saved.threads[1]);
  expect((await handler(new Request("http://localhost:19453/api/session?before=-1"))).status).toBe(400);
});


const testAudio: Audio = { id: "a".repeat(64), url: "/api/audio/" + "a".repeat(64), mimeType: "audio/mp4", durationMs: 2000, transcriptionStatus: "missing" };

test("voice enrichment failure retains audio and retries the same receipt once", async () => {
  let calls = 0;
  const f = await fixture("complete", undefined, 2000, undefined, async () => {
    if (++calls === 1) throw new Error("Transcription service unavailable");
    return { transcript: "Recovered words", toneError: "Tone service unavailable" };
  });
  const input = { requestId: "retry-voice", clipId: "clip" };
  f.sessions.submitAudio(input, testAudio);
  await until(() => selected(f.sessions).status === "failed");
  expect(selected(f.sessions).messages[0].audio?.transcriptionStatus).toBe("failed");
  expect(f.official().calls.filter((call: any) => call.method === "turn/start")).toHaveLength(0);
  const handler = httpHandler(f.sessions, { allowedLogin: "", publicHost: "" });
  const retry = () => handler(new Request("http://localhost/api/audio/retry", { method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json" }, body: JSON.stringify({ requestId: input.requestId }) }));
  expect((await retry()).status).toBe(202);
  expect((await retry()).status).toBe(202);
  await until(() => selected(f.sessions).status === "idle");
  expect(calls).toBe(2);
  expect(selected(f.sessions).messages.filter((m) => m.role === "user")).toHaveLength(1);
  expect(selected(f.sessions).messages[0].audio?.toneError).toBe("Tone service unavailable");
  expect(f.official().calls.filter((call: any) => call.method === "turn/start")).toHaveLength(1);
  expect((await retry()).status).toBe(202);
  expect(calls).toBe(2);
});

test("stopping voice enrichment aborts processing and never sends a provider turn", async () => {
  let started = false, aborted = false;
  const f = await fixture("complete", undefined, 2000, undefined, async (_path, _id, _duration, signal) => {
    started = true;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true }));
  });
  f.sessions.submitAudio({ requestId: "stop-voice", clipId: "clip" }, testAudio);
  await until(() => started);
  await f.sessions.stop({ threadId: selected(f.sessions).id });
  await until(() => aborted);
  await Bun.sleep(20);
  expect(selected(f.sessions).status).toBe("idle");
  expect(selected(f.sessions).messages[0].audio?.transcriptionStatus).toBe("failed");
  expect(JSON.parse(readFileSync(join(f.root, "session.json"), "utf8")).requests[0].phase).toBe("awaiting-transcript");
  expect(f.official().calls.filter((call: any) => call.method === "turn/start")).toHaveLength(0);
});

test("restart resumes audio enrichment but does not replay acknowledged agent turns", async () => {
  const root = mkdtempSync(join(tmpdir(), "dot-audio-recover-"));
  writeFileSync(join(root, "session.json"), JSON.stringify({ version: 1, selectedThreadId: "voice-thread", requests: [
    { id: "recover-voice", hash: "saved", threadId: "voice-thread", provider: "codex", phase: "processing-audio" },
  ], threads: [{ id: "voice-thread", title: "Voice", status: "working", messages: [
    { id: "client:recover-voice", clientId: "recover-voice", role: "user", text: "", provider: "codex", audio: { ...testAudio, transcriptionStatus: "processing" } },
  ] }] }));
  let calls = 0;
  const f = await fixture("complete", root, 2000, undefined, async () => { calls++; return { transcript: "Recovered after restart" }; });
  await until(() => selected(f.sessions).status === "idle");
  expect(calls).toBe(1);
  expect(f.official().calls.filter((call: any) => call.method === "turn/start")).toHaveLength(1);
  f.rpc.close(); await Bun.sleep(30);
  const second = await fixture("complete", root, 2000, undefined, async () => { throw new Error("must not reprocess"); });
  expect(selected(second.sessions).messages[0].audio?.transcriptionStatus).toBe("ready");
  expect(second.official().calls.filter((call: any) => call.method === "turn/start")).toHaveLength(1);
});

test("voice caption and audio-derived tone reach Claude and survive provider handoff", async () => {
  const f = await fixture("complete", undefined, 2000, "complete");
  f.sessions.setProvider({ provider: "claude" });
  f.sessions.submitAudio({ requestId: "claude-voice", clipId: "clip", text: "A caption" }, testAudio);
  await until(() => selected(f.sessions).status === "idle");
  const saved = JSON.parse(readFileSync(join(f.root, "claude.json"), "utf8"));
  expect(JSON.stringify(saved)).toContain("A caption");
  expect(JSON.stringify(saved)).toContain(TONE_MODEL);
  f.sessions.setProvider({ provider: "codex" });
  f.sessions.submit({ requestId: "voice-handoff", text: "Continue" });
  await until(() => selected(f.sessions).status === "idle");
  const prompt = f.official().calls.find((call: any) => call.method === "turn/start").params.input[0].text;
  expect(prompt).toContain("Even, measured delivery.");
});

test("tone annotation validation rejects invented timestamps and malformed model output", () => {
  expect(() => parseTone({ summary: "Fast delivery", segments: [{ startSeconds: 0, endSeconds: 30, delivery: "Fast" }] }, 2000)).toThrow();
  expect(() => parseTone({ summary: 4, segments: [] }, 2000)).toThrow();
  expect(parseTone({ summary: "Unclear", segments: [] }, 2000)).toEqual({ model: TONE_MODEL, summary: "Unclear", segments: [] });
});


test("stop before voice processing starts keeps the recording retryable without running enrichment", async () => {
  let calls = 0;
  const f = await fixture("complete", undefined, 2000, undefined, async () => { calls++; return { transcript: "Unexpected" }; });
  f.sessions.submitAudio({ requestId: "queued-voice-stop", clipId: "clip" }, testAudio);
  await f.sessions.stop({ threadId: selected(f.sessions).id });
  await Bun.sleep(20);
  expect(calls).toBe(0);
  expect(selected(f.sessions).messages[0].audio?.transcriptionStatus).toBe("failed");
  expect(JSON.parse(readFileSync(join(f.root, "session.json"), "utf8")).requests[0].phase).toBe("awaiting-transcript");
  expect(f.official().calls.filter((call: any) => call.method === "turn/start")).toHaveLength(0);
});
