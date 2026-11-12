import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { AppError, attempt, Settings } from "./core.ts";

export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const Reply = Schema.Struct({
  id: Schema.optional(Schema.Number),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
});
const Evaluation = Schema.Struct({
  result: Schema.Struct({ value: Schema.optional(Schema.Unknown) }),
  exceptionDetails: Schema.optional(
    Schema.Struct({
      text: Schema.String,
      exception: Schema.optional(Schema.Struct({ description: Schema.optional(Schema.String) })),
    }),
  ),
});
const Targets = Schema.Array(
  Schema.Struct({ type: Schema.String, webSocketDebuggerUrl: Schema.optional(Schema.String) }),
);
const FrameTree = Schema.Struct({
  frameTree: Schema.Struct({ frame: Schema.Struct({ id: Schema.String }) }),
});
const Screenshot = Schema.Struct({ data: Schema.String });

/** Minimal Chrome DevTools Protocol client for one page target. */
class DevTools {
  private next = 0;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const reply = Schema.decodeUnknownSync(Reply)(JSON.parse(String(event.data)));
      const waiter = reply.id === undefined ? undefined : this.pending.get(reply.id);
      if (!waiter || reply.id === undefined) return;
      this.pending.delete(reply.id);
      if (reply.error) waiter.reject(new Error(`Chromium: ${reply.error.message}`));
      else waiter.resolve(reply.result);
    });
    socket.addEventListener("close", () => {
      for (const waiter of this.pending.values())
        waiter.reject(new Error("Chromium closed the connection"));
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<DevTools> {
    const socket = new WebSocket(url);
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(new DevTools(socket)), { once: true });
      socket.addEventListener("error", () => reject(new Error("Cannot connect to Chromium")), {
        once: true,
      });
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const evaluation = Schema.decodeUnknownSync(Evaluation)(
      await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
    );
    if (evaluation.exceptionDetails) {
      const details = evaluation.exceptionDetails;
      throw new Error(`Page script failed: ${details.exception?.description ?? details.text}`);
    }
    return evaluation.result.value;
  }

  /** Replace the document and wait for its fonts and images. */
  async load(html: string): Promise<void> {
    const tree = Schema.decodeUnknownSync(FrameTree)(await this.send("Page.getFrameTree"));
    await this.send("Page.setDocumentContent", { frameId: tree.frameTree.frame.id, html });
    await this.evaluate(
      "document.fonts.ready.then(() => Promise.all([...document.images].map((image) => image.decode().catch(() => {}))))",
    );
  }

  async screenshot(path: string, width: number, height: number): Promise<void> {
    const shot = Schema.decodeUnknownSync(Screenshot)(
      await this.send("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width, height, scale: 1 },
        captureBeyondViewport: true,
      }),
    );
    await writeFile(path, Buffer.from(shot.data, "base64"), { mode: 0o600 });
  }

  close(): void {
    this.socket.close();
  }
}

/** The page's DevTools WebSocket once Chromium has written its port file. */
async function pageSocket(profile: string, signal: AbortSignal): Promise<string | undefined> {
  const portFile = join(profile, "DevToolsActivePort");
  const port = existsSync(portFile) ? (await readFile(portFile, "utf8")).split("\n")[0] : "";
  if (!port) return undefined;
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal });
  return Schema.decodeUnknownSync(Targets)(await response.json()).find(
    (target) => target.type === "page" && target.webSocketDebuggerUrl,
  )?.webSocketDebuggerUrl;
}

/** A headless Chromium page for the current scope, with its profile inside `work`. */
export const openPage = Effect.fn("openPage")(function* (work: string) {
  const config = yield* Settings;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const profile = join(work, "chromium");
  const browser = yield* spawner
    .spawn(
      ChildProcess.make(
        config.chromium,
        [
          "--headless",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          "--hide-scrollbars",
          "--mute-audio",
          `--user-data-dir=${profile}`,
          "--remote-debugging-address=127.0.0.1",
          "--remote-debugging-port=0",
          "about:blank",
        ],
        { stdout: "ignore", stderr: "pipe" },
      ),
    )
    .pipe(
      Effect.mapError(
        () => new AppError({ message: `Cannot start ${config.chromium}; install Chromium` }),
      ),
    );
  // Keep the end of Chromium's log for errors; draining it also keeps the pipe open.
  let log = "";
  yield* browser.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) => Effect.sync(() => (log = (log + text).slice(-1500)))),
    Effect.ignore,
    Effect.forkScoped,
  );
  const failure = (message: string) =>
    new AppError({ message: `${message}; Chromium log: ${log.trim() || "(empty)"}` });
  let socket: string | undefined;
  for (let waited = 0; !socket; waited += 100) {
    if (!(yield* browser.isRunning.pipe(Effect.orElseSucceed(() => false))))
      return yield* failure("Chromium exited before opening DevTools");
    if (waited >= 30_000)
      return yield* failure("Chromium did not open its DevTools port within 30 seconds");
    socket = yield* attempt("Find Chromium DevTools", (signal) => pageSocket(profile, signal));
    if (!socket) yield* Effect.sleep("100 millis");
  }
  return yield* Effect.acquireRelease(
    attempt("Connect to Chromium", () => DevTools.connect(socket)),
    (page) => Effect.sync(() => page.close()),
  );
});
