import { Config, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { AppError, attempt } from "./core.ts";

export const codexSettings = Effect.gen(function* () {
  const binary = yield* Config.String("CODEX_PATH").pipe(Config.withDefault("codex"));
  const model = yield* Config.String("TOPIC_MODEL").pipe(Config.withDefault("gpt-6.1-sol"));
  return { binary, model };
});

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

export function codexCommand(options: {
  binary: string;
  model: string;
  schemaPath: string;
  cwd: string;
  prompt: string;
  webSearch: "live" | "disabled";
  reasoningEffort?: "low" | "medium";
}) {
  const args = [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
  ];
  for (const feature of [
    "shell_tool",
    "unified_exec",
    "apps",
    "plugins",
    "browser_use",
    "computer_use",
    "multi_agent",
    "view_image",
  ])
    args.push("--disable", feature);
  args.push(
    "-c",
    `web_search="${options.webSearch}"`,
    "-c",
    'approval_policy="never"',
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    `model_reasoning_effort="${options.reasoningEffort ?? "low"}"`,
    "--model",
    options.model,
    "--output-schema",
    options.schemaPath,
    "--color",
    "never",
    "-",
  );
  return ChildProcess.make(options.binary, args, {
    cwd: options.cwd,
    stdin: Stream.make(new TextEncoder().encode(options.prompt)),
  });
}
