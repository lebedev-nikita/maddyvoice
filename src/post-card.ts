import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { AppError, attempt, Paths, Settings } from "./core.ts";
import type { Post } from "./telegram.ts";

/** Frame area the visible card may fill: right of the face, inside the 1920 × 1080 frame. */
const CardArea = { left: 896, right: 1884, top: 20, bottom: 1060 } as const;
// CSS padding around the bubble that holds its shadow; the PNG includes it.
const shadow = { left: 22, top: 22, right: 28, bottom: 30 } as const;
// Largest first: the card uses the biggest type at which the whole post fits.
const scales = Array.from({ length: 27 }, (_, index) => 2.4 - index * 0.025);

type CardLayers = {
  /** Card as posted, positioned at (x, y) in the frame. */
  readonly base: string;
  /** Only the played (blue) waveform bars, same size as base. */
  readonly played: string;
  readonly x: number;
  readonly y: number;
  /** Waveform rectangle inside the card images, in pixels. */
  readonly wave: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Elapsed-time label position inside the card images and its font size, in pixels. */
  readonly timer: { readonly x: number; readonly y: number; readonly size: number };
};

export type CardImages = { readonly avatar: string; readonly reactions: readonly string[] };

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const moscowTime = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  hour: "2-digit",
  minute: "2-digit",
});

const star = `<svg viewBox="0 0 24 24" width="17" height="17"><path fill="#f5a623" d="M12 2.6l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"/></svg>`;
const eye = `<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 5C6.5 5 2.7 9.1 1.5 12c1.2 2.9 5 7 10.5 7s9.3-4.1 10.5-7C21.3 9.1 17.5 5 12 5zm0 11.5a4.5 4.5 0 110-9 4.5 4.5 0 010 9zm0-2.3a2.2 2.2 0 100-4.4 2.2 2.2 0 000 4.4z"/></svg>`;

/** Telegram-like voice post; images are data URIs so Chromium never waits on the network. */
export function cardHtml(post: Post, audioIndex: number, images: CardImages, font: string): string {
  const card = post.card;
  const waveform = card?.waveforms[audioIndex] ?? [];
  const paragraphs = post.text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const reactions = (card?.reactions ?? []).map((reaction, index) => {
    if (reaction.paid) return `<span class="reaction paid">${star}${escape(reaction.count)}</span>`;
    const image = images.reactions[index];
    const icon = image
      ? `<img src="${image}">`
      : `<span class="glyph">${escape(reaction.emoji)}</span>`;
    return `<span class="reaction">${icon}${escape(reaction.count)}</span>`;
  });
  const meta = [
    card?.views ? `${eye}<span>${escape(card.views)}</span><span>&nbsp;·&nbsp;</span>` : "",
    `<span>${card?.edited ? "изменено " : ""}${moscowTime.format(Date.parse(post.date))}</span>`,
  ];
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Roboto; src: url("${font}"); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: transparent; font-family: Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
.card { width: 520px; padding: ${shadow.top}px ${shadow.right}px ${shadow.bottom}px ${shadow.left}px; }
.bubble { background: #fff; border-radius: 16px; padding: 9px 13px 8px;
  box-shadow: 0 4px 22px rgba(0,0,0,.28), 0 1px 2px rgba(0,0,0,.12); }
.author { display: flex; align-items: center; gap: 8px; color: #3a8bc8; font-weight: 600; font-size: 14.5px;
  line-height: 19px; margin-bottom: 7px; }
.author span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.avatar { width: 26px; height: 26px; border-radius: 50%; flex: none; background: #3a8bc8; }
.voice { display: flex; align-items: center; gap: 11px; margin-bottom: 7px; }
.play { width: 44px; height: 44px; border-radius: 50%; background: #40a7e3; flex: none; position: relative; }
.play::before, .play::after { content: ""; position: absolute; top: 14px; width: 4px; height: 16px;
  border-radius: 1.5px; background: #fff; }
.play::before { left: 15px; } .play::after { left: 25px; }
.wave-wrap { flex: 1; min-width: 0; }
.wave { height: 26px; display: flex; align-items: flex-end; }
.duration { height: 17px; margin-top: 3px; }
.text { color: #111; font-size: 15px; line-height: 21px; white-space: pre-wrap; overflow-wrap: anywhere;
  margin-bottom: 8px; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }
.text p + p { margin-top: 10px; }
.reactions { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 4px; }
.reaction { display: flex; align-items: center; gap: 5px; height: 28px; padding: 0 9px 0 6px; border-radius: 14px;
  background: rgba(64,167,227,.13); color: #2481cc; font-size: 13.5px; font-weight: 600; }
.reaction img { width: 19px; height: 19px; }
.reaction .glyph { font-size: 16px; line-height: 19px; }
.reaction.paid { background: rgba(245,166,35,.16); color: #d2860c; }
.footer { display: flex; justify-content: flex-end; align-items: center; gap: 4px; color: #a0acb6; font-size: 12.5px; }
.footer svg { margin-right: 1px; }
body.played .bubble > *:not(.voice), body.played .voice > *:not(.wave-wrap), body.played .duration { visibility: hidden; }
body.played .bubble { background: none; box-shadow: none; }
</style></head><body>
<div class="card"><div class="bubble">
  <div class="author">${images.avatar ? `<img class="avatar" src="${images.avatar}">` : `<span class="avatar"></span>`}<span>${escape(card?.author ?? "")}</span></div>
  <div class="voice"><div class="play"></div>
    <div class="wave-wrap"><div class="wave" data-waveform="${waveform.join(",")}"></div><div class="duration"></div></div></div>
  ${paragraphs.length ? `<div class="text">${paragraphs.map((part) => `<p>${escape(part)}</p>`).join("")}</div>` : ""}
  ${reactions.length ? `<div class="reactions">${reactions.join("")}</div>` : ""}
  <div class="footer">${meta.join("")}</div>
</div></div>
</body></html>`;
}

// Runs inside the page. fit() picks the scale; draw() paints the waveform in device pixels.
const pageScript = `
const card = document.querySelector(".card"), text = document.querySelector(".text");
const box = (element) => { const r = element.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
window.fit = (scales, area, padding) => {
  const fits = (scale) => {
    card.style.width = area.width / scale + padding.width + "px";
    return card.getBoundingClientRect().height <= area.height / scale + padding.height;
  };
  for (const scale of scales) if (fits(scale)) return scale;
  // Even the smallest type overflows: drop whole lines from the end of the text.
  const scale = scales[scales.length - 1];
  for (let lines = text ? Math.round(text.scrollHeight / 21) : 0; !fits(scale) && lines > 1; )
    text.style.webkitLineClamp = String(--lines);
  return scale;
};
window.draw = () => {
  // Bars fill the row and resample Telegram's 100-point, 5-bit waveform; a dip rises
  // to 60% of its taller neighbour so short pauses don't read as gaps.
  const wave = document.querySelector(".wave");
  const raw = wave.dataset.waveform ? wave.dataset.waveform.split(",").map(Number) : [];
  const dpr = devicePixelRatio, barW = Math.round(3 * dpr), gapW = Math.round(2 * dpr), maxH = Math.round(26 * dpr);
  const bars = Math.max(1, Math.floor((wave.parentElement.clientWidth * dpr + gapW) / (barW + gapW)));
  const peaks = Array.from({ length: bars }, (_, i) => {
    if (!raw.length) return 0;
    const from = Math.floor((i * raw.length) / bars), to = Math.max(from + 1, Math.floor(((i + 1) * raw.length) / bars));
    return Math.max(...raw.slice(from, to)) / 31;
  });
  const canvas = document.createElement("canvas");
  canvas.width = bars * (barW + gapW) - gapW;
  canvas.height = maxH;
  canvas.style.cssText = "display:block;width:" + canvas.width / dpr + "px;height:" + maxH / dpr + "px";
  const context = canvas.getContext("2d");
  context.fillStyle = document.body.classList.contains("played") ? "#40a7e3" : "#c5d7e6";
  peaks.forEach((peak, i) => {
    const level = Math.max(peak, 0.6 * Math.max(peaks[i - 1] ?? 0, peaks[i + 1] ?? 0));
    const height = Math.max(Math.round(2 * dpr), Math.round(level * maxH));
    context.beginPath();
    context.roundRect(i * (barW + gapW), maxH - height, barW, height, barW / 2);
    context.fill();
  });
  wave.replaceChildren(canvas);
  return { card: box(card), wave: box(canvas), pixels: [canvas.width, canvas.height], timer: box(document.querySelector(".duration")) };
};
`;

const Rect = Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]);
const Geometry = Schema.Struct({
  card: Rect,
  wave: Rect,
  pixels: Schema.Tuple([Schema.Number, Schema.Number]),
  timer: Rect,
});
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
      throw new Error(`Card script failed: ${details.exception?.description ?? details.text}`);
    }
    return evaluation.result.value;
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

const imageHosts = /(^|\.)(telesco\.pe|cdn-telegram\.org|telegram\.org|t\.me|cdn\.jsdelivr\.net)$/;

/** First available candidate as a data URI, or "" when every candidate is missing. */
async function imageData(candidates: readonly string[], signal: AbortSignal): Promise<string> {
  for (const candidate of candidates) {
    const url = new URL(candidate, "https://telegram.org");
    if (url.protocol !== "https:" || !imageHosts.test(url.hostname)) continue;
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
    const type = response.headers.get("content-type") ?? "";
    if (response.status >= 500) throw new Error(`Card image HTTP ${response.status}`);
    if (!response.ok || !type.startsWith("image/")) {
      await response.body?.cancel();
      continue;
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 2 * 1024 * 1024) throw new Error("Card image exceeds 2 MB");
    return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
  }
  return "";
}

// Telegram serves 40 px reaction emoji; emoji-datasource has the same Apple set at 64 px.
const emojiCandidates = (emoji: string, fallback: string) => {
  // File names are code points (not grapheme clusters) joined by "-".
  const code = (emoji.match(/./gsu) ?? [])
    .map((char) => char.codePointAt(0)!.toString(16))
    .filter((point) => point !== "fe0f")
    .join("-");
  const base = "https://cdn.jsdelivr.net/npm/emoji-datasource-apple@16.0.0/img/apple/64/";
  return code ? [`${base}${code}.png`, `${base}${code}-fe0f.png`, fallback] : [fallback];
};

const pngSize = (bytes: Buffer) => ({
  width: bytes.readUInt32BE(16),
  height: bytes.readUInt32BE(20),
});

export class PostCard extends Context.Service<
  PostCard,
  {
    /** Write the card's base and played layers into `work` and place them in the frame. */
    render(post: Post, audioIndex: number, work: string): Effect.Effect<CardLayers, AppError>;
  }
>()("maddyvoice/PostCard") {
  static readonly layer = Layer.effect(
    PostCard,
    Effect.gen(function* () {
      const config = yield* Settings;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const render = Effect.fn("PostCard.render")(function* (
        post: Post,
        audioIndex: number,
        work: string,
      ) {
        const images = yield* attempt("Download post card images", async (signal) => ({
          avatar: post.card?.avatar ? await imageData([post.card.avatar], signal) : "",
          reactions: await Promise.all(
            (post.card?.reactions ?? []).map((reaction) =>
              reaction.paid
                ? Promise.resolve("")
                : imageData(emojiCandidates(reaction.emoji, reaction.image), signal),
            ),
          ),
        }));
        const font = yield* attempt(
          "Read card font",
          async () => `data:font/ttf;base64,${(await readFile(Paths.cardFont)).toString("base64")}`,
        );
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
          socket = yield* attempt("Find Chromium DevTools", (signal) =>
            pageSocket(profile, signal),
          );
          if (!socket) yield* Effect.sleep("100 millis");
        }
        const base = join(work, "card.png");
        const played = join(work, "card-played.png");
        const geometry = yield* Effect.acquireUseRelease(
          attempt("Connect to Chromium", () => DevTools.connect(socket)),
          (page) =>
            attempt("Render post card", async () => {
              const area = {
                width: CardArea.right - CardArea.left,
                height: CardArea.bottom - CardArea.top,
              };
              const padding = {
                width: shadow.left + shadow.right,
                height: shadow.top + shadow.bottom,
              };
              await page.send("Emulation.setDefaultBackgroundColorOverride", {
                color: { r: 0, g: 0, b: 0, a: 0 },
              });
              await page.send("Emulation.setDeviceMetricsOverride", {
                width: 1200,
                height: 1200,
                deviceScaleFactor: 1,
                mobile: false,
              });
              const tree = Schema.decodeUnknownSync(FrameTree)(
                await page.send("Page.getFrameTree"),
              );
              await page.send("Page.setDocumentContent", {
                frameId: tree.frameTree.frame.id,
                html: cardHtml(post, audioIndex, images, font),
              });
              await page.evaluate(
                "document.fonts.ready.then(() => Promise.all([...document.images].map((image) => image.decode().catch(() => {}))))",
              );
              await page.evaluate(pageScript);
              const scale = Number(
                await page.evaluate(
                  `fit(${JSON.stringify(scales)}, ${JSON.stringify(area)}, ${JSON.stringify(padding)})`,
                ),
              );
              await page.send("Emulation.setDeviceMetricsOverride", {
                width: Math.ceil(area.width / scale + padding.width),
                height: Math.ceil(area.height / scale + padding.height) + 1,
                deviceScaleFactor: scale,
                mobile: false,
              });
              const layout = Schema.decodeUnknownSync(Geometry)(await page.evaluate("draw()"));
              const [, , width, height] = layout.card;
              await page.screenshot(base, width, height);
              await page.evaluate("document.body.classList.add('played'), draw()");
              await page.screenshot(played, width, height);
              return { scale, layout };
            }),
          (page) => Effect.sync(() => page.close()),
        );
        const size = pngSize(
          yield* attempt("Read card image", () =>
            readFile(base).then((bytes) => bytes.subarray(0, 24)),
          ),
        );
        const { scale, layout } = geometry;
        // Right-align the visible bubble; centre it a little above the middle, kept inside the area.
        const x = Math.round(CardArea.right + shadow.right * scale) - size.width;
        const y = Math.min(
          Math.max(
            Math.round((1080 - size.height) / 2) - 50,
            Math.round(CardArea.top - shadow.top * scale),
          ),
          Math.round(CardArea.bottom + shadow.bottom * scale) - size.height,
        );
        return {
          base,
          played,
          x,
          y,
          wave: {
            x: Math.round(layout.wave[0] * scale),
            y: Math.round(layout.wave[1] * scale),
            width: layout.pixels[0],
            height: layout.pixels[1],
          },
          timer: {
            x: Math.round(layout.timer[0] * scale),
            y: Math.round(layout.timer[1] * scale + scale),
            size: Math.round(13 * scale),
          },
        } satisfies CardLayers;
      }, Effect.scoped);
      return PostCard.of({ render });
    }),
  );
}
