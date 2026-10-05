import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

// JSON values at the installed app-server protocol boundary. Provider credentials
// stay inside Codex; the bridge never reads auth files or forwards stderr.
export type Wire = Record<string, any>;
export type ServerCall = { id: string | number; method: string; params: Wire };
type Pending = { resolve: (value: Wire) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export class RpcTimeout extends Error {}

export class AppServer {
  readonly ready: Promise<void>;
  isReady = false;
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private failure?: Error;
  private closed = false;
  onNotification: (method: string, params: Wire) => void = () => {};
  onRequest: (call: ServerCall) => void = () => {};
  onFailure: (error: Error) => void = () => {};

  constructor(command: string[], cwd: string, private timeoutMs = 60_000) {
    this.child = spawn(command[0], command.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.resume();
    this.child.on("error", () => this.fail(new Error("Could not start Codex app-server.")));
    this.child.on("exit", () => { if (!this.closed) this.fail(new Error("Codex app-server disconnected. Restart the Open Dot harness to reconnect.")); });
    this.child.stdin.on("error", () => this.fail(new Error("Codex app-server connection closed.")));
    this.ready = this.initialize();
    void this.ready.catch(() => {});
  }

  private async initialize() {
    await this.sendRequest("initialize", {
      clientInfo: { name: "open_dot_mobile", title: "Open Dot", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    });
    this.send({ method: "initialized" });
    this.isReady = true;
  }

  async request(method: string, params: Wire): Promise<Wire> {
    await this.ready;
    return this.sendRequest(method, params);
  }

  respond(id: string | number, result: Wire) { this.send({ id, result }); }
  reject(id: string | number, message: string) { this.send({ id, error: { code: -32601, message } }); }

  private sendRequest(method: string, params: Wire): Promise<Wire> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeout(`Codex ${method} did not acknowledge the request. Its outcome is unknown.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  private send(message: Wire) {
    if (this.closed || this.failure) throw this.failure ?? new Error("Codex connection closed.");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private consume(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 256_000_000) return this.fail(new Error("Codex app-server sent an oversized message."));
    let boundary: number;
    while ((boundary = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, boundary); this.buffer = this.buffer.slice(boundary + 1);
      if (!line.trim()) continue;
      let message: Wire;
      try { message = JSON.parse(line); }
      catch { return this.fail(new Error("Codex app-server sent invalid JSON.")); }
      try {
        if (typeof message.method === "string") {
          if (message.id !== undefined) this.onRequest({ id: message.id, method: message.method, params: message.params ?? {} });
          else this.onNotification(message.method, message.params ?? {});
        } else if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          clearTimeout(pending.timer); this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(String(message.error.message ?? "Codex request failed").slice(0, 2000)));
          else pending.resolve(message.result ?? {});
        }
      } catch { this.fail(new Error("Open Dot could not record an app-server event.")); }
    }
  }

  private fail(error: Error) {
    if (this.failure || this.closed) return;
    this.failure = error; this.isReady = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.child.kill();
    this.onFailure(error);
  }

  close() {
    this.closed = true; this.isReady = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Codex connection closed.")); }
    this.pending.clear(); this.child.kill();
  }
}
