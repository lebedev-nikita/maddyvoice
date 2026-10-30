import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { AppError, attempt } from "./core.ts";

export const commandJson = Effect.fn("commandJson")(function* (
  command: ChildProcess.Command,
  label = "Read-only command",
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner
    .spawn(command)
    .pipe(Effect.mapError(() => new AppError({ message: `Cannot start ${label}` })));
  const [stdout, , code] = yield* Effect.all(
    [
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.runDrain),
      handle.exitCode,
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.mapError(() => new AppError({ message: `${label} process failed` })));
  if (Number(code) !== 0)
    return yield* new AppError({
      message: `${label} exited ${code}; check login, permissions and usage limits`,
    });
  return yield* attempt(`Decode ${label} JSON`, async () => JSON.parse(stdout) as unknown);
}, Effect.scoped);
