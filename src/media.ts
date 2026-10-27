import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { AppError, attempt, Paths, Settings } from "./core.ts";
import type { Post } from "./telegram.ts";

export const portraitAttribution =
  "Default background photo: Ilya Maddyson. Source: " +
  "https://click-or-die.ru/app/uploads/2025/06/photo_2024-07-31_13-33-46.jpg";

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
        ).pipe(Effect.mapError(() => new AppError({ message: `${binary} process failed` })));
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
        const pictures = post.images.length > 0 ? post.images : [Paths.portrait];
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
            "-i",
            input,
            "-vf",
            "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x101014,setsar=1",
            "-frames:v",
            "1",
            join(work, `frame-${index}.png`),
          ]);
        }
        const slides = pictures.map(
          (_, index) =>
            `file 'frame-${index}.png'\nduration ${(duration / pictures.length).toFixed(9)}`,
        );
        slides.push(`file 'frame-${pictures.length - 1}.png'`);
        yield* attempt("Write slideshow", () =>
          writeFile(join(work, "slides.ffconcat"), `ffconcat version 1.0\n${slides.join("\n")}\n`),
        );
        const temporary = join(work, "video.mp4");
        yield* execute(config.ffmpeg, [
          "-nostdin",
          "-v",
          "error",
          "-y",
          "-f",
          "concat",
          "-safe",
          "1",
          "-i",
          join(work, "slides.ffconcat"),
          "-i",
          audioPath,
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-vf",
          `fps=30,tpad=stop_mode=clone:stop_duration=${duration}`,
          "-t",
          String(duration),
          "-r",
          "30",
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-tune",
          "stillimage",
          "-crf",
          "20",
          "-pix_fmt",
          "yuv420p",
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
  );
}
