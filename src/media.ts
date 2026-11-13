import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { AppError, attempt, Paths, safeMessage, Settings } from "./core.ts";
import type { Recording } from "./episode.ts";
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

export async function downloadMedia(
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

/** Scene backgrounds in file-name order; a post without photos uses `message_id % length`. */
export const listBackgrounds = Effect.gen(function* () {
  const backgrounds = yield* attempt("List video backgrounds", async () =>
    (await readdir(Paths.backgrounds))
      .filter((name) => name.endsWith(".jpg"))
      .sort()
      .map((name) => join(Paths.backgrounds, name)),
  );
  if (backgrounds.length === 0)
    return yield* new AppError({ message: "No video backgrounds in assets/backgrounds" });
  return backgrounds;
});

type Rendered = { path: string; sha256: string; size: number; duration: number };

export class Media extends Context.Service<
  Media,
  {
    render(post: Post, audioIndex: number, key: string): Effect.Effect<Rendered, AppError>;
    /**
     * Render the recordings in order into one video in a single scene, chosen by the video's
     * number so consecutive videos differ; `starts` are the recordings' offsets in seconds.
     */
    renderEpisode(
      recordings: readonly Recording[],
      video: number,
      key: string,
    ): Effect.Effect<Rendered & { starts: readonly number[] }, AppError>;
  }
>()("maddyvoice/Media") {
  static readonly layer = Layer.effect(
    Media,
    Effect.gen(function* () {
      const config = yield* Settings;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const postCard = yield* PostCard;
      const backgrounds = yield* listBackgrounds;
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

      const probeDuration = Effect.fn("Media.probeDuration")(function* (path: string) {
        const probeText = yield* execute(config.ffprobe, [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "json",
          path,
        ]);
        return yield* attempt("Read media duration", async () => {
          const probe = Schema.decodeUnknownSync(Probe)(JSON.parse(probeText));
          const duration = Number(probe.format.duration);
          if (!Number.isFinite(duration) || duration <= 0 || duration > 12 * 3600)
            throw new Error("Invalid or excessive media duration");
          return duration;
        });
      });

      /** The output directory and a scratch directory inside it that the scope removes. */
      const workspace = Effect.fn("Media.workspace")(function* (key: string) {
        if (!/^[a-zA-Z0-9_-]+$/.test(key))
          return yield* new AppError({ message: "Invalid output key" });
        const root = join(config.dataDir, "videos");
        yield* attempt("Create video directory", () => mkdir(root, { recursive: true }));
        const work = yield* Effect.acquireRelease(
          attempt("Create render workspace", () => mkdtemp(join(root, ".render-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        return { root, work };
      });

      const save = Effect.fn("Media.save")(function* (
        temporary: string,
        root: string,
        key: string,
      ) {
        const path = join(root, `${key}.mp4`);
        yield* attempt("Save rendered video", () => rename(temporary, path));
        return { path, ...(yield* attempt("Fingerprint video", () => fingerprint(path))) };
      });

      /**
       * Render one voice into `work` over `background` unless it has photos of its own;
       * `position` marks its place in an episode.
       */
      const segment = Effect.fn("Media.segment")(function* (
        { post, audioIndex }: Recording,
        background: string,
        position: string,
        work: string,
      ) {
        const audioUrl = post.audio[audioIndex];
        if (!audioUrl)
          return yield* new AppError({ message: "Recording has no downloadable audio" });
        const audioPath = join(work, "audio");
        yield* attempt("Download Telegram audio", (signal) =>
          downloadMedia(audioUrl, audioPath, 512 * 1024 * 1024, signal),
        );
        const duration = yield* probeDuration(audioPath);
        const fps = 30;
        // Attached photos fill the frame; otherwise each post rotates through the backgrounds.
        const pictures = post.images.length > 0 ? post.images : [background];
        const card = yield* postCard.render(post, audioIndex, work, position);
        for (const [index, picture] of pictures.entries()) {
          let input = picture;
          if (post.images.length > 0) {
            input = join(work, `input-${index}`);
            yield* attempt("Download attached image", (signal) =>
              downloadMedia(picture, input, 50 * 1024 * 1024, signal),
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
            "-filter_complex",
            "[0:v]scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos," +
              "crop=1920:1080:(iw-ow)/2:(ih-oh)/2," +
              `setsar=1,${post.images.length ? "eq=saturation=0.94," : ""}format=rgba[photo];` +
              `[photo][1:v]overlay=0:840:format=auto[branded];` +
              `[branded][2:v]overlay=${card.x}:${card.y}:format=auto,format=rgb24[frame]`,
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
        const yuv = "scale=out_color_matrix=bt709:out_range=tv,";
        const starts = pictures.map((_, index) =>
          Math.round(((index * duration) / pictures.length) * fps),
        );
        const slides = pictures.map((_, index) => {
          const frames = index + 1 < pictures.length ? starts[index + 1]! - starts[index]! : 0;
          return `[${index}:v]${yuv}format=yuv420p,loop=loop=${frames - 1}:size=1[slide${index}];`;
        });
        // Playback progress: the waveform row is composed in RGB for every frame and then
        // replaces a fixed region of the still. Over the card's unplayed bars go the played
        // (blue) bars left of the position, then the pixel column at the edge, blended by
        // the fraction of a pixel already played, so the fill moves every frame instead of
        // in whole-pixel steps. Card images are decoded once and repeated; only this small
        // row is converted per frame.
        const { wave, timer } = card;
        // 4:2:0 chroma covers 2 × 2 pixels: grow the row to even bounds so it replaces
        // whole chroma blocks; the extra rows and columns are the card's plain background.
        const lift = (card.y + wave.y) % 2;
        const rows = wave.height + lift + ((wave.height + lift) % 2);
        const shift = (card.x + wave.x) % 2;
        const columns = wave.width + shift + ((wave.width + shift) % 2);
        const played = `min(${wave.width},floor(${wave.width}*t/${duration}))`;
        // The slides' time base: an image input's own 1/25 would round t differently in
        // each filter, and the layers would disagree on the position.
        const repeat = `loop=loop=-1:size=1,settb=1/${fps},setpts=N`;
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
            `[${audioInput + 1}:v]crop=${columns}:${rows}:${wave.x - shift}:${wave.y - lift},` +
            `format=rgb24,${repeat}[unplayed];` +
            `[${audioInput + 2}:v]crop=${wave.width}:${rows}:${wave.x}:${wave.y - lift},` +
            `format=rgba,split[bars][column];` +
            `[bars]pad=${wave.width * 2}:${rows}:${wave.width}:0:color=0x00000000,${repeat},` +
            `crop=${wave.width}:${rows}:'${played}':0[fill];` +
            `[column]pad=${wave.width + 1}:${rows}:0:0:color=0x00000000,${repeat},` +
            `crop=1:${rows}:'${played}':0,` +
            `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${edge}'[edge];` +
            `[unplayed][fill]overlay=x='${shift - wave.width}+${played}':y=0:format=rgb[filled];` +
            `[filled][edge]overlay=x='${shift}+${played}':y=0:format=rgb,` +
            `${yuv}format=yuva420p[wave];` +
            `[slides][wave]overlay=x=${card.x + wave.x - shift}:y=${card.y + wave.y - lift}:format=yuv420,` +
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
        return { path: temporary, duration };
      });

      const render = Effect.fn("Media.render")(function* (
        post: Post,
        audioIndex: number,
        key: string,
      ) {
        const { root, work } = yield* workspace(key);
        // Each post rotates through the backgrounds.
        const background = backgrounds[post.id % backgrounds.length]!;
        const video = yield* segment({ post, audioIndex }, background, "", work);
        return { ...(yield* save(video.path, root, key)), duration: video.duration };
      }, Effect.scoped);

      const renderEpisode = Effect.fn("Media.renderEpisode")(function* (
        recordings: readonly Recording[],
        video: number,
        key: string,
      ) {
        if (recordings.length === 0)
          return yield* new AppError({ message: "Episode has no voices" });
        const { root, work } = yield* workspace(key);
        const background = backgrounds[video % backgrounds.length]!;
        const starts: number[] = [];
        const files: string[] = [];
        let offset = 0;
        for (const [index, recording] of recordings.entries()) {
          const directory = join(work, `part-${index}`);
          yield* attempt("Create segment workspace", () => mkdir(directory));
          const position = recordings.length > 1 ? `${index + 1} / ${recordings.length}` : "";
          const part = yield* segment(recording, background, position, directory);
          starts.push(offset);
          files.push(part.path);
          // The joined video continues each segment where the previous file ends.
          offset += yield* probeDuration(part.path);
        }
        const list = join(work, "segments.txt");
        yield* attempt("Write segment list", () =>
          writeFile(
            list,
            files.map((file) => `file '${file.replaceAll("'", "'\\''")}'\n`).join(""),
          ),
        );
        const temporary = join(work, "episode.mp4");
        // Segments share one encoder configuration, so they join without re-encoding.
        yield* execute(config.ffmpeg, [
          "-nostdin",
          "-v",
          "error",
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          list,
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          temporary,
        ]);
        const duration = yield* probeDuration(temporary);
        return { ...(yield* save(temporary, root, key)), duration, starts };
      }, Effect.scoped);
      return Media.of({ render, renderEpisode });
    }),
  ).pipe(Layer.provide(PostCard.layer));
}
