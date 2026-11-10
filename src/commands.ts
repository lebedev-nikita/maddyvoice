import { Effect, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { AppError, attempt } from "./core.ts";

/** A command reported a structured error, such as tg's `{"error":{"reason":…}}` on stderr. */
export class CommandFailure extends Schema.TaggedError<CommandFailure>()("CommandFailure", {
  message: Schema.String,
  reason: Schema.String,
}) {}

const decodeFailure = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ reason: Schema.String }) })),
);

export const commandJson = Effect.fn("commandJson")(function* (
  command: ChildProcess.Command,
  label = "Read-only command",
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner
    .spawn(command)
    .pipe(Effect.mapError(() => new AppError({ message: `Cannot start ${label}` })));
  const [stdout, stderr, code] = yield* Effect.all(
    [
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode,
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.mapError(() => new AppError({ message: `${label} process failed` })));
  if (Number(code) !== 0) {
    // Warnings may precede the error object; only its reason leaves the process.
    const lastLine = stderr.trim().split("\n").at(-1) ?? "";
    const failure = decodeFailure(lastLine);
    if (Option.isSome(failure))
      return yield* new CommandFailure({
        message: `${label} exited ${code} (${failure.value.error.reason})`,
        reason: failure.value.error.reason,
      });
    return yield* new AppError({
      message: `${label} exited ${code}; check login, permissions and usage limits`,
    });
  }
  return yield* attempt(`Decode ${label} JSON`, async () => JSON.parse(stdout) as unknown);
}, Effect.scoped);
