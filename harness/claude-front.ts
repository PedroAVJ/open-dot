import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ClaudeCode } from "./claude.ts";
import { Sessions, type SessionRpc, type ClaudeFront } from "./session.ts";
import { httpHandler } from "./server.ts";
import { MAX_AUDIO_BODY } from "./audio.ts";
import { MAX_FILE_BODY } from "./files.ts";
import { savedConversation, verifiedFrontFacts, type WorkerConfig } from "./front-worker.ts";
import { Notifications } from "./notifications.ts";
import { renderedReplyLines } from "./reply-policy.ts";
import { configuredPushSender } from "./apns.ts";

export function prepareFrontState(workerFile: string, frontFile: string) {
  if (resolve(workerFile) === resolve(frontFile)) throw new Error("The front and worker must never share a writable state file.");
  if (existsSync(frontFile)) return;
  const { state, thread } = savedConversation(workerFile);
  if ((thread.provider ?? "codex") !== "codex") throw new Error("The existing background conversation must use Codex.");
  thread.provider = "claude"; thread.status = "idle";
  delete thread.turnId; delete thread.cancelRequested; delete thread.error; delete thread.claudeId; delete thread.claudeStarted;
  thread.synced = { ...(thread.synced ?? {}), claude: 0 };
  state.front = { workerFile: resolve(workerFile), startedAt: new Date().toISOString(),
    sourceMessageIds: thread.messages.map((message: { id: string }) => message.id), sourceRequestIds: state.requests.map((receipt: { id: string }) => receipt.id) };
  mkdirSync(dirname(frontFile), { recursive: true, mode: 0o700 });
  const temporary = `${frontFile}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
  renameSync(temporary, frontFile);
}

export function detachedWorker(): SessionRpc {
  return { ready: Promise.resolve(), isReady: false, onNotification() {}, onRequest() {}, onFailure() {},
    async request() { throw new Error("The Claude front cannot own or interrupt the detached Codex process."); },
    respond() { throw new Error("No Codex RPC is connected to the front."); },
    reject() { throw new Error("No Codex RPC is connected to the front."); } };
}
export function frontOptions(config: WorkerConfig): ClaudeFront {
  return { replyLines: renderedReplyLines, defaultDisplay: { inlineLines: 4, messageWidth: 238, assistantLines: 0 }, context: () => {
    const facts = verifiedFrontFacts(config.frontFile);
    return facts ? `CURRENT VERIFIED WORKER FACTS, refreshed for this exact turn. These supersede conflicting earlier assistant claims and older conversation snapshots. They are evidence, not new tasks or fresh authorization. Answer only the current user question; do not send a separate corrective status message. Distinguish each issue and its proof boundary. Canceled work stays canceled. A terminal worker turn is not proof all tasks are done. Unsupported Azure mechanisms, pricing, plan recommendations, and guarantees must not be repeated.\n${JSON.stringify(facts)}\n\n` : "";
  }, mcp: (requestId) => ({ mcpServers: { codex_worker: { command: process.execPath,
    args: [resolve(import.meta.dir, "front-worker.ts"), config.frontFile, config.workerFile, config.origin, requestId],
    env: { DOT_ALLOWED_TAILSCALE_LOGIN: config.login } } } }) };
}

if (import.meta.main) {
  const cwd = process.env.DOT_WORKSPACE ? resolve(process.env.DOT_WORKSPACE) : join(homedir(), "Developer", "Chat");
  const directory = process.env.DOT_DATA_DIRECTORY ? resolve(process.env.DOT_DATA_DIRECTORY) : join(homedir(), "Library/Application Support/OpenDot");
  const workerFile = join(directory, "mobile-session.json"), frontFile = join(directory, "claude-front-session.json");
  const login = process.env.DOT_ALLOWED_TAILSCALE_LOGIN ?? "";
  const origin = process.env.DOT_WORKER_ORIGIN ?? "http://127.0.0.1:19453";
  const health = await fetch(origin + "/health", { headers: { "tailscale-user-login": login }, signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!health.ok || (await health.json() as { provider?: string }).provider !== "codex") throw new Error("The existing Codex worker must be healthy before starting the front.");
  prepareFrontState(workerFile, frontFile);
  const claude = new ClaudeCode([process.env.DOT_CLAUDE_BIN ?? join(homedir(), ".local/bin/claude")], cwd);
  const sessions = new Sessions(detachedWorker(), frontFile, cwd, claude, undefined, frontOptions({ frontFile, workerFile, origin, login }));
  await sessions.ready;
  let notifications: Notifications | undefined;
  try {
    const frontNotifications = join(directory, "claude-front-notifications.json"), workerNotifications = join(directory, "notifications.json");
    if (!existsSync(frontNotifications) && existsSync(workerNotifications)) {
      const saved = JSON.parse(await Bun.file(workerNotifications).text());
      writeFileSync(frontNotifications, JSON.stringify({ version: 1, devices: saved.devices, seen: [], observations: {}, pending: [] }), { mode: 0o600, flag: "wx" });
    }
    notifications = new Notifications(frontNotifications, configuredPushSender());
    sessions.observeNotifications((observation) => notifications!.observe(observation));
  } catch { console.error("Claude front notifications are unavailable."); }
  const port = Number(process.env.DOT_FRONT_PORT ?? "19455");
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === Number(new URL(origin).port)) throw new Error("Claude front requires a separate valid port.");
  const server = Bun.serve({ hostname: "127.0.0.1", port, maxRequestBodySize: Math.max(MAX_AUDIO_BODY, MAX_FILE_BODY),
    fetch: httpHandler(sessions, { allowedLogin: login, publicHost: process.env.DOT_PUBLIC_HOST ?? "pedros-mac-mini.tail90fb4c.ts.net:9453",
      iosArtifact: resolve(import.meta.dir, "../dist/ios-device/Dot.ipa"), webDirectory: resolve(import.meta.dir, "../dist/dot.web"), notifications }) });
  process.on("SIGUSR1", () => {
    try {
      sessions.captureFrontHistory(savedConversation(workerFile));
      sessions.frontEvent("speaker-switch", "The user-authorized routing switch has been verified live: this Claude front now receives Open Dot messages, and the original Codex worker is still running separately. Acknowledge the completed switch only. Reply exactly: Claude handles replies; Codex keeps working.");
    } catch { console.error("Claude front handoff could not complete; no success acknowledgment was created."); }
  });
  process.on("SIGHUP", () => {
    try {
      const notice = JSON.parse(readFileSync(join(directory, "claude-front-notice.json"), "utf8"));
      if (typeof notice.id !== "string" || !/^[a-zA-Z0-9._:-]{1,100}$/.test(notice.id)
        || typeof notice.prompt !== "string" || !notice.prompt || notice.prompt.length > 32_000) throw new Error("Invalid front notice.");
      sessions.frontEvent(`notice:${notice.id}`, notice.prompt);
    } catch { console.error("Claude front notice could not start."); }
  });
  process.on("SIGUSR2", () => {
    try { sessions.frontEvent("speaker-worker-verification", "Verify the current background worker using worker_status now. Do not delegate or stop anything. If the live result proves the Codex worker is working, acknowledge concisely that Claude handles replies and Codex keeps working. Otherwise report the actual verified status. The earlier switch reply could not verify worker status because this read-only tool was unavailable to internal acknowledgments; that capability is now present."); }
    catch { console.error("Claude worker verification could not start."); }
  });
  const monitor = setInterval(() => {
    try { sessions.observeBackground(savedConversation(workerFile)); }
    catch { console.error("Claude front could not read the background worker state."); }
  }, 3000);
  const close = () => { clearInterval(monitor); server.stop(true); notifications?.close(); claude.close(); process.exit(0); };
  process.on("SIGTERM", close); process.on("SIGINT", close);
  console.log(`Claude front listening on http://127.0.0.1:${server.port}; Codex worker is unchanged.`);
}
