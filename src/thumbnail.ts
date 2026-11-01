import { Config, Context, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { AppError, attempt, Paths } from "./core.ts";

export function thumbnailText(quote: string) {
  return quote.trim().replace(/[.,:;!?…—–\s-]+$/u, (ending) => (ending.includes("?") ? "?" : ""));
}

export function thumbnailLines(quote: string) {
  const words = thumbnailText(quote).split(/\s+/);
  const lines: string[] = [];
  for (const word of words) {
    const previous = lines.at(-1);
    if (previous && Array.from(previous + " " + word).length <= 11)
      lines[lines.length - 1] = `${previous} ${word}`;
    else lines.push(word);
  }
  return lines;
}

export const renderThumbnail = Effect.fn("renderThumbnail")(function* (
  quote: string,
  destination: string,
) {
  const binary = yield* Config.String("FFMPEG_PATH").pipe(Config.withDefault("ffmpeg"));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const displayQuote = thumbnailText(quote);
  const lines = thumbnailLines(displayQuote);
  if (!displayQuote || lines.length > 4)
    return yield* new AppError({ message: "Thumbnail requires a short nonempty quote" });
  const work = yield* Effect.acquireRelease(
    attempt("Create thumbnail workspace", () => mkdtemp(join(tmpdir(), "maddyvoice-thumbnail-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const longest = Math.max(...lines.map((line) => Array.from(line).length));
  const fontSize = Math.min(82, Math.floor(440 / (longest * 0.56)));
  const lineHeight = Math.ceil(fontSize * 1.22);
  const top = Math.round((720 - lineHeight * lines.length) / 2);
  yield* attempt("Prepare thumbnail text and font", async () => {
    await copyFile(Paths.portrait, join(work, "portrait.jpg"));
    await copyFile(Paths.thumbnailFont, join(work, "font.ttf"));
    for (const [index, line] of lines.entries())
      await writeFile(join(work, `line-${index}.txt`), line, { mode: 0o600 });
    await writeFile(join(work, "brand.txt"), "MADDYVOICE", { mode: 0o600 });
  });
  const text = lines.map(
    (_, index) =>
      `drawtext=fontfile=font.ttf:textfile=line-${index}.txt:expansion=none:` +
      `fontcolor=0x1b1f1a:fontsize=${fontSize}:x=64:y=${top + index * lineHeight}`,
  );
  // A light card fades into the portrait; a short olive rule marks the quote.
  const filter =
    `[0:v]scale=880:720:force_original_aspect_ratio=increase,` +
    `crop=828:720:(iw-880)*0.39:(ih-oh)*0.44,eq=saturation=0.8:brightness=0.03,` +
    `pad=1280:720:452:0:color=0xf1eee4,setsar=1,split[photo][mask];` +
    `[mask]format=rgba,geq=r=241:g=238:b=228:a='255*clip((760-X)/300,0,1)'[shade];` +
    `[photo][shade]overlay,drawbox=x=66:y=${top - 26}:w=56:h=6:color=0x8a9a1c:t=fill,` +
    `${text.join(",")},` +
    `drawtext=fontfile=font.ttf:textfile=brand.txt:expansion=none:fontcolor=0x1b1f1a@0.55:fontsize=22:x=68:y=660`;
  const process = yield* spawner
    .spawn(
      ChildProcess.make(
        binary,
        [
          "-nostdin",
          "-v",
          "error",
          "-y",
          "-filter_complex_threads",
          "2",
          "-i",
          "portrait.jpg",
          "-filter_complex",
          filter,
          "-frames:v",
          "1",
          "-threads",
          "2",
          "thumbnail.png",
        ],
        { cwd: work },
      ),
    )
    .pipe(
      Effect.mapError(
        () =>
          new AppError({
            message: "Thumbnail render failed; FFmpeg must include drawtext and geq filters",
          }),
      ),
    );
  const [output, code] = yield* Effect.all(
    [process.all.pipe(Stream.decodeText(), Stream.mkString), process.exitCode],
    { concurrency: "unbounded" },
  ).pipe(Effect.mapError(() => new AppError({ message: "Cannot read thumbnail FFmpeg output" })));
  if (Number(code) !== 0)
    return yield* new AppError({
      message: `Thumbnail FFmpeg exited ${code}; requires drawtext and geq: ${output.slice(-1000)}`,
    });
  yield* attempt("Save thumbnail", async () => {
    await mkdir(dirname(destination), { recursive: true });
    // The staging file is placed beside the destination for an atomic rename across filesystems.
    const staging = join(dirname(destination), `.${work.split("/").at(-1)}.png`);
    try {
      await copyFile(join(work, "thumbnail.png"), staging);
      await rename(staging, destination);
    } finally {
      await rm(staging, { force: true });
    }
  });
  return destination;
}, Effect.scoped);

export class Thumbnails extends Context.Service<
  Thumbnails,
  { render(quote: string, destination: string): Effect.Effect<string, AppError> }
>()("maddyvoice/Thumbnails") {
  static readonly layer = Layer.effect(
    Thumbnails,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return Thumbnails.of({
        render: (quote, destination) =>
          renderThumbnail(quote, destination).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.mapError((error) => new AppError({ message: error.message })),
          ),
      });
    }),
  );
}
