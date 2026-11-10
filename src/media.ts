import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { AppError, attempt, Paths, safeMessage, Settings } from "./core.ts";
import { PostCard } from "./post-card.ts";
import type { Post } from "./telegram.ts";

function allowedMedia(url: string): boolean {
  const parsed = new URL(url);
  return (
    parsed.protocol === "https:" &&
    /(^|\.)(telesco\.pe|cdn-telegram\.org|telegram\.org|t\.me)$/.test(parsed.hostname)
  );
}

async function openMedia(url: string, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let redirect = 0; redirect < 6; redirect++) {
    if (!allowedMedia(current)) throw new Error("Telegram returned an unexpected media host");
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Media redirect has no location");
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Telegram media HTTP ${response.status}`);
    }
    return response;
  }
  throw new Error("Too many media redirects");
}

async function download(
  url: string,
  destination: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<void> {
  const response = await openMedia(url, signal);
  if (!response.body) throw new Error("Telegram returned no media body");
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body.cancel();
    throw new Error("Media exceeds download limit");
  }
  let total = 0;
  await pipeline(
    Readable.from(response.body),
    async function* (chunks) {
      for await (const chunk of chunks) {
        total += (chunk as Buffer).length;
        if (total > maxBytes) throw new Error("Media exceeds download limit");
        yield chunk;
      }
    },
    createWriteStream(destination, { mode: 0o600 }),
    { signal },
  );
  if (total === 0) throw new Error("Telegram returned an empty media file");
}

export async function fingerprint(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest("hex"), size: (await stat(path)).size };
}

const Probe = Schema.Struct({
  format: Schema.Struct({ duration: Schema.String }),
});

export class Media extends Context.Service<
  Media,
  {
    render(
      post: Post,
      audioIndex: number,
      key: string,
    ): Effect.Effect<{ path: string; sha256: string; size: number; duration: number }, AppError>;
  }
>()("maddyvoice/Media") {
  static readonly layer = Layer.effect(
    Media,
    Effect.gen(function* () {
      const config = yield* Settings;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const postCard = yield* PostCard;
      const backgrounds = yield* attempt("List video backgrounds", async () =>
        (await readdir(Paths.backgrounds))
          .filter((name) => name.endsWith(".jpg"))
          .sort()
          .map((name) => join(Paths.backgrounds, name)),
      );
      if (backgrounds.length === 0)
        return yield* new AppError({ message: "No video backgrounds in assets/backgrounds" });
      // Collect output through Effect streams so child pipes cannot block each other.
      const execute = Effect.fn("Media.execute")(function* (
        binary: string,
        args: readonly string[],
      ) {
        const handle = yield* spawner
          .spawn(ChildProcess.make(binary, [...args]))
          .pipe(
            Effect.mapError(
              () => new AppError({ message: `Cannot start ${binary}; install FFmpeg and FFprobe` }),
            ),
          );
        const [stdout, stderr, code] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError(
            (cause) => new AppError({ message: `${binary} process failed: ${safeMessage(cause)}` }),
          ),
        );
        if (Number(code) !== 0) {
          return yield* new AppError({
            message: `${binary} exited ${code}: ${stderr.slice(-2000)}`,
          });
        }
        return stdout;
      }, Effect.scoped);

      const render = Effect.fn("Media.render")(function* (
        post: Post,
        audioIndex: number,
        key: string,
      ) {
        const audioUrl = post.audio[audioIndex];
        if (!audioUrl)
          return yield* new AppError({ message: "Recording has no downloadable audio" });
        if (!/^[a-zA-Z0-9_-]+$/.test(key))
          return yield* new AppError({ message: "Invalid output key" });
        const root = join(config.dataDir, "videos");
        yield* attempt("Create video directory", () => mkdir(root, { recursive: true }));
        const work = yield* Effect.acquireRelease(
          attempt("Create render workspace", () => mkdtemp(join(root, ".render-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const audioPath = join(work, "audio");
        yield* attempt("Download Telegram audio", (signal) =>
          download(audioUrl, audioPath, 512 * 1024 * 1024, signal),
        );
        const probeText = yield* execute(config.ffprobe, [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "json",
          audioPath,
        ]);
        const duration = yield* attempt("Read audio duration", async () => {
          const probe = Schema.decodeUnknownSync(Probe)(JSON.parse(probeText));
          const duration = Number(probe.format.duration);
          if (!Number.isFinite(duration) || duration <= 0 || duration > 12 * 3600)
            throw new Error("Invalid or excessive audio duration");
          return duration;
        });
        // Attached photos fill the frame; otherwise each post rotates through the backgrounds.
        const pictures =
          post.images.length > 0 ? post.images : [backgrounds[post.id % backgrounds.length]!];
        const card = yield* postCard.render(post, audioIndex, work);
        for (const [index, picture] of pictures.entries()) {
          let input = picture;
          if (post.images.length > 0) {
            input = join(work, `input-${index}`);
            yield* attempt("Download attached image", (signal) =>
              download(picture, input, 50 * 1024 * 1024, signal),
            );
          }
          yield* execute(config.ffmpeg, [
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-filter_complex_threads",
            "1",
            "-i",
            input,
            "-i",
            Paths.videoOverlay,
            "-i",
            card.base,
            "-i",
            card.played,
            "-filter_complex",
            "[0:v]scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos," +
              "crop=1920:1080:(iw-ow)/2:(ih-oh)/2," +
              `setsar=1,${post.images.length ? "eq=saturation=0.94," : ""}format=rgba[photo];` +
              `[photo][1:v]overlay=0:840:format=auto[branded];` +
              `[branded][2:v]overlay=${card.x}:${card.y}:format=auto[carded];` +
              `[3:v]crop=${card.wave.width}:${card.wave.height}:${card.wave.x}:${card.wave.y}[playedWave];` +
              `[carded][playedWave]overlay=${card.x + card.wave.x}:${card.y + card.wave.y}:format=auto,` +
              "format=rgb24[frame]",
            "-map",
            "[frame]",
            "-frames:v",
            "1",
            "-threads",
            "2",
            join(work, `frame-${index}.png`),
          ]);
        }
        // Repeat each still frame on demand: a concat demuxer slideshow makes fps
        // burst-duplicate full-size frames that FFmpeg then holds in memory. Stills are
        // converted to the output colour space once; per frame only small layers change.
        const fps = 30;
        const yuv = "scale=out_color_matrix=bt709:out_range=tv,";
        const starts = pictures.map((_, index) =>
          Math.round(((index * duration) / pictures.length) * fps),
        );
        const slides = pictures.map((_, index) => {
          const frames = index + 1 < pictures.length ? starts[index + 1]! - starts[index]! : 0;
          return `[${index}:v]${yuv}format=yuv420p,loop=loop=${frames - 1}:size=1[slide${index}];`;
        });
        // Playback progress: the stills already show every bar played (blue); the unplayed
        // bars from the card cover everything right of the position. The pixel column at
        // the edge fills with the fraction of a pixel already played, so the fill moves
        // every frame instead of in whole-pixel steps. Card images are decoded once and
        // repeated; only these small crops are converted per frame.
        const { wave, timer } = card;
        // 4:2:0 chroma covers 2 × 2 pixels: grow the per-frame layers to even rows so they
        // replace whole chroma blocks; the extra rows are the card's plain background.
        const lift = (card.y + wave.y) % 2;
        const rows = wave.height + lift + ((wave.height + lift) % 2);
        const layer = `crop=${wave.width}:${rows}:${wave.x}:${wave.y - lift}`;
        const top = card.y + wave.y - lift;
        const played = `min(${wave.width},floor(${wave.width}*t/${duration}))`;
        const repeat = `loop=loop=-1:size=1,setpts=N/(${fps}*TB),`;
        const edge = `min(1,${wave.width}*T/${duration}-floor(${wave.width}*T/${duration}))`;
        const timerText = join(work, "timer.txt");
        yield* attempt("Write timer template", () =>
          writeFile(timerText, "%{eif:trunc(t/60):d}:%{eif:mod(trunc(t),60):d:2}"),
        );
        const audioInput = pictures.length;
        const temporary = join(work, "video.mp4");
        yield* execute(config.ffmpeg, [
          "-nostdin",
          "-v",
          "error",
          "-y",
          "-filter_complex_threads",
          "1",
          ...pictures.flatMap((_, index) => ["-i", join(work, `frame-${index}.png`)]),
          "-i",
          audioPath,
          "-i",
          card.base,
          "-i",
          card.played,
          "-map",
          "[video]",
          "-map",
          `${audioInput}:a:0`,
          "-filter_complex",
          slides.join("") +
            `${pictures.map((_, index) => `[slide${index}]`).join("")}` +
            `concat=n=${pictures.length}:v=1:a=0,settb=1/${fps},setpts=N,fps=${fps}[slides];` +
            `[${audioInput + 1}:v]${layer},format=rgba,` +
            `pad=${wave.width * 2}:${rows}:0:0:color=0x00000000,${repeat}` +
            `crop=${wave.width}:${rows}:'${played}':0,${yuv}format=yuva420p[unplayed];` +
            `[${audioInput + 2}:v]${layer},format=rgba,` +
            `pad=${wave.width + 1}:${rows}:0:0:color=0x00000000,${repeat}` +
            `crop=1:${rows}:'${played}':0,` +
            `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${edge}',${yuv}format=yuva420p[edge];` +
            `[slides][unplayed]overlay=x='${card.x + wave.x}+${played}':y=${top}:format=yuv420[covered];` +
            `[covered][edge]overlay=x='${card.x + wave.x}+${played}':y=${top}:format=yuv420,` +
            `drawtext=fontfile='${Paths.cardFont}':textfile='${timerText}':fontcolor=0x8f9eab:` +
            `fontsize=${timer.size}:x=${card.x + timer.x}:y=${card.y + timer.y}[video]`,
          "-t",
          String(duration),
          "-r",
          String(fps),
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-threads",
          "2",
          "-crf",
          "18",
          "-pix_fmt",
          "yuv420p",
          "-color_primaries",
          "bt709",
          "-color_trc",
          "bt709",
          "-colorspace",
          "bt709",
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-ar",
          "48000",
          "-movflags",
          "+faststart",
          temporary,
        ]);
        const path = join(root, `${key}.mp4`);
        yield* attempt("Save rendered video", () => rename(temporary, path));
        const info = yield* attempt("Fingerprint video", () => fingerprint(path));
        return { path, ...info, duration };
      }, Effect.scoped);
      return Media.of({ render });
    }),
  ).pipe(Layer.provide(PostCard.layer));
}
