import { Config, Context, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { AppError, attempt, Paths } from "./core.ts";

export function thumbnailLines(quote: string) {
  const words = quote.toLocaleUpperCase("ru-RU").trim().split(/\s+/);
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
  const lines = thumbnailLines(quote);
  if (!quote.trim() || lines.length > 4)
    return yield* new AppError({ message: "Thumbnail requires a short nonempty quote" });
  const work = yield* Effect.acquireRelease(
    attempt("Create thumbnail workspace", () => mkdtemp(join(tmpdir(), "maddyvoice-thumbnail-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const longest = Math.max(...lines.map((line) => Array.from(line).length));
  const fontSize = Math.min(114, Math.floor(620 / (longest * 0.61)));
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
      `fontcolor=${index === lines.length - 1 ? "0xe8ff56" : "0xfaf9f1"}:` +
      `fontsize=${fontSize}:x=64:y=${top + index * lineHeight}:shadowcolor=black@0.25:shadowx=2:shadowy=4`,
  );
  const filter =
    `[0:v]scale=880:720:force_original_aspect_ratio=increase,` +
    `crop=828:720:(iw-880)*0.39:(ih-oh)*0.44,eq=contrast=1.08:saturation=0.8,` +
    `pad=1280:720:452:0:color=0x111410,setsar=1,split[photo][mask];` +
    `[mask]format=rgba,geq=r=17:g=20:b=16:a='255*clip((832-X)/400,0,1)'[shade];` +
    `[photo][shade]overlay,${text.join(",")},` +
    `drawtext=fontfile=font.ttf:textfile=brand.txt:expansion=none:fontcolor=0xfaf9f1@0.6:fontsize=22:x=68:y=660`;
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
