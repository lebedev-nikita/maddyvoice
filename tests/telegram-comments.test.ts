import { expect, it } from "vite-plus/test";
import { ConfigProvider, DateTime, Effect, Layer, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { AppError } from "../src/core.ts";
import { collectFirstComments, TelegramComments } from "../src/telegram-comments.ts";
import { CodexTopics } from "../src/codex.ts";
import { CommentTopics } from "../src/comment-topics.ts";
import { commentsReadyAt } from "../src/topic.ts";

const page = (ids: number[], more: boolean) => ({
  items: ids.map((id) => ({
    id: String(id),
    text: `Комментарий ${id}`,
    sender_name: "Не учитывать автора",
  })),
  page: { has_more: more },
  meta: { complete: true },
});

it("takes the earliest 500, not the latest 500, across reverse-ordered pages", async () => {
  const cursors: Array<string | undefined> = [];
  const rows = Array.from({ length: 651 }, (_, index) => index + 1);
  const comments = await Effect.runPromise(
    collectFirstComments((before) => {
      cursors.push(before);
      const available = rows.filter((id) => before === undefined || BigInt(id) < BigInt(before));
      const ids = available.slice(-100);
      return Effect.succeed(page(ids, available.length > ids.length));
    }),
  );
  expect(cursors).toHaveLength(7);
  expect(comments).toHaveLength(500);
  expect(comments[0]).toEqual({ id: "1", text: "Комментарий 1" });
  expect(comments.at(-1)?.id).toBe("500");
  expect(JSON.stringify(comments)).not.toContain("sender_name");
});

it("counts non-text comments in the first-500 limit, then removes their empty bodies", async () => {
  const data = page(
    Array.from({ length: 600 }, (_, index) => index + 1),
    false,
  );
  data.items[0]!.text = "";
  const comments = await Effect.runPromise(collectFirstComments(() => Effect.succeed(data)));
  expect(comments).toHaveLength(499);
  expect(comments[0]?.id).toBe("2");
  expect(comments.at(-1)?.id).toBe("500");
});

it("refuses partial, stuck and empty continuation pages rather than using a recent sample", async () => {
  const partial = { ...page([1], false), meta: { complete: false } };
  await expect(
    Effect.runPromise(collectFirstComments(() => Effect.succeed(partial))),
  ).rejects.toThrow("Incomplete");
  await expect(
    Effect.runPromise(collectFirstComments(() => Effect.succeed(page([1], true)))),
  ).rejects.toThrow("did not advance");
  await expect(
    Effect.runPromise(collectFirstComments(() => Effect.succeed(page([], true)))),
  ).rejects.toThrow("empty page");
  await expect(
    Effect.runPromise(
      collectFirstComments(() => Effect.fail(new AppError({ message: "tg rate limit" }))),
    ),
  ).rejects.toThrow("rate limit");
});

it("defines the exact one-hour boundary independently of upload time", () => {
  expect(commentsReadyAt("2026-10-27T12:00:00Z")).toBe(
    DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-27T13:00:00Z")),
  );
});

function spawnerLayer(
  reply: (command: ChildProcess.StandardCommand) => { value: unknown; code?: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (command._tag !== "StandardCommand") throw new Error("Unexpected pipeline");
        const { value, code = 0 } = reply(command);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(JSON.stringify(value))),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );
}
const config = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ TG_PROFILE: "personal", TG_PATH: "tg-test" }),
);
const source = { channel: "maddysontg", messageId: "123", publishedAt: "2020-01-01T00:00:00.000Z" };

it("checks the original Telegram timestamp, strips author metadata and handles closed discussions", async () => {
  const calls: Array<readonly string[]> = [];
  const reader = TelegramComments.layer.pipe(
    Layer.provide(
      spawnerLayer((command) => {
        calls.push(command.args);
        expect(command.command).toBe("tg-test");
        expect(command.args).not.toContain("--json");
        if (command.args.includes("show"))
          return {
            value: {
              item: {
                id: source.messageId,
                timestamp: source.publishedAt,
                provider_metadata: { comments: 2 },
              },
              meta: { complete: true },
            },
          };
        expect(command.args).toContain("--json=id,text");
        return { value: page([11, 12], false) };
      }),
    ),
    Layer.provide(config),
  );
  expect(
    await Effect.runPromise(
      TelegramComments.use((service) => service.read(source)).pipe(Effect.provide(reader)),
    ),
  ).toEqual([
    { id: "11", text: "Комментарий 11" },
    { id: "12", text: "Комментарий 12" },
  ]);
  expect(calls).toHaveLength(2);
  let closedReads = 0;
  const closed = TelegramComments.layer.pipe(
    Layer.provide(
      spawnerLayer(() => {
        closedReads++;
        return {
          value: {
            item: { id: source.messageId, timestamp: source.publishedAt, provider_metadata: {} },
            meta: { complete: true },
          },
        };
      }),
    ),
    Layer.provide(config),
  );
  expect(
    await Effect.runPromise(
      TelegramComments.use((service) => service.read(source)).pipe(Effect.provide(closed)),
    ),
  ).toEqual([]);
  expect(closedReads).toBe(1);
});

it("does not contact Telegram for a young post and refuses a mismatched source timestamp", async () => {
  let calls = 0;
  const reader = TelegramComments.layer.pipe(
    Layer.provide(
      spawnerLayer(() => {
        calls++;
        return {
          value: {
            item: {
              id: source.messageId,
              timestamp: "2020-01-02T00:00:00.000Z",
              provider_metadata: { comments: 2 },
            },
            meta: { complete: true },
          },
        };
      }),
    ),
    Layer.provide(config),
  );
  const recent = DateTime.formatIso(DateTime.add(Effect.runSync(DateTime.now), { minutes: -59 }));
  await expect(
    Effect.runPromise(
      TelegramComments.use((service) => service.read({ ...source, publishedAt: recent })).pipe(
        Effect.provide(reader),
      ),
    ),
  ).rejects.toThrow("less than one hour");
  expect(calls).toBe(0);
  await expect(
    Effect.runPromise(
      TelegramComments.use((service) => service.read(source)).pipe(Effect.provide(reader)),
    ),
  ).rejects.toThrow("does not match");
});

it("retries failed Telegram reads instead of treating rate limits as an empty discussion", async () => {
  const reader = TelegramComments.layer.pipe(
    Layer.provide(spawnerLayer(() => ({ value: {}, code: 8 }))),
    Layer.provide(config),
  );
  await expect(
    Effect.runPromise(
      TelegramComments.use((service) => service.read(source)).pipe(Effect.provide(reader)),
    ),
  ).rejects.toThrow("tg exited 8");
});

it("processes 500 bodies in isolated batches and combines weak mentions across batches", async () => {
  const comments = Array.from({ length: 500 }, (_, index) => ({
    id: String(index + 1),
    text: `Ворон в комментарии ${index + 1}`,
  }));
  const commands: ChildProcess.StandardCommand[] = [];
  const layer = CommentTopics.layer.pipe(
    Layer.provide(
      spawnerLayer((command) => {
        const comment = comments[commands.length * 100]!;
        commands.push(command);
        expect(command.args).toContain("--ignore-rules");
        expect(command.args).toContain('web_search="disabled"');
        return {
          value: {
            candidates: [
              { nick: "Ворон", mentions: [{ commentId: comment.id, quote: comment.text }] },
            ],
          },
        };
      }),
    ),
    Layer.provide(config),
  );
  const result = await Effect.runPromise(
    CommentTopics.use((service) =>
      Effect.gen(function* () {
        expect((yield* service.extract([])).candidates).toEqual([]);
        expect(commands).toHaveLength(0);
        return yield* service.extract(comments);
      }),
    ).pipe(Effect.provide(layer)),
  );
  expect(commands).toHaveLength(5);
  expect(new Set(commands.map((command) => command.options.cwd)).size).toBe(5);
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]?.mentions.map((mention) => mention.commentId)).toEqual([
    "1",
    "101",
    "201",
    "301",
    "401",
  ]);
});

it("uses comment candidates in the production Codex service and removes the duplicated author prefix", async () => {
  const transcript = "Вор опять спорит о выборе новой игры для эфира.";
  const comments = [
    { id: "a", text: "Это Ворон." },
    { id: "b", text: "Ворон снова спорит." },
  ];
  const candidate = {
    nick: "Ворон",
    mentions: comments.map((entry) => ({ commentId: entry.id, quote: entry.text })),
  };
  let reads = 0;
  const layer = CodexTopics.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          TelegramComments,
          TelegramComments.of({
            read: () => {
              reads++;
              return Effect.succeed(comments);
            },
          }),
        ),
        Layer.succeed(
          CommentTopics,
          CommentTopics.of({
            model: "test",
            reviewModel: "test",
            extract: (input) => {
              expect(input).toEqual(comments);
              return Effect.succeed({
                candidates: [candidate],
                rejectedMentions: 0,
                rejectedCandidates: 0,
              });
            },
            generate: (text, candidates) => {
              expect(text).toBe(transcript);
              expect(candidates).toEqual([candidate]);
              return Effect.succeed({
                accepted: false,
                validationError: "Topic repeats the author's name",
                draft: {
                  topic: "Илья Мэддисон обсуждает спор с Ворон",
                  subjects: [
                    { name: "Ворон", transcriptQuote: transcript, commentIds: ["a", "b"] },
                  ],
                },
              });
            },
            verify: (text, topic) => {
              expect(text).toBe(transcript);
              expect(topic).toBe("обсуждает спор с Ворон");
              return Effect.succeed({
                supported: true,
                claims: [{ claim: "Ворон спорит об игре", quote: transcript }],
                reason: "Тема подтверждается расшифровкой речи.",
              });
            },
          }),
        ),
        spawnerLayer(() => {
          throw new Error("Must not invoke legacy generator");
        }),
      ),
    ),
    Layer.provide(config),
  );
  expect(
    await Effect.runPromise(
      CodexTopics.use((service) => service.summarize(transcript, source)).pipe(
        Effect.provide(layer),
      ),
    ),
  ).toBe("обсуждает спор с Ворон");
  expect(reads).toBe(1);
});

it("runs semantic checking in its own isolated model call and rejects fabricated speech evidence", async () => {
  const transcript = "Герой пытается доказать свою правоту в споре о новой игре.";
  const commands: ChildProcess.StandardCommand[] = [];
  let quote = transcript;
  const layer = CommentTopics.layer.pipe(
    Layer.provide(
      spawnerLayer((command) => {
        commands.push(command);
        expect(command.args).toContain("--ignore-rules");
        expect(command.args).toContain('web_search="disabled"');
        expect(command.args).toContain("gpt-6.1-sol");
        expect(command.args).toContain('model_reasoning_effort="medium"');
        return {
          value: {
            supported: true,
            claims: [{ claim: "Герой пытается доказать свою правоту", quote }],
            reason: "Утверждение подтверждается расшифровкой.",
          },
        };
      }),
    ),
    Layer.provide(config),
  );
  await Effect.runPromise(
    CommentTopics.use((service) =>
      service.verify(transcript, "Попытки доказать свою правоту в споре"),
    ).pipe(Effect.provide(layer)),
  );
  quote = "Придуманные слова, отсутствующие в исходной записи.";
  expect(
    await Effect.runPromise(
      CommentTopics.use((service) =>
        service.verify(transcript, "Попытки доказать свою правоту в споре"),
      ).pipe(Effect.provide(layer)),
    ),
  ).toMatchObject({ supported: false, claims: [] });
  expect(new Set(commands.map((command) => command.options.cwd)).size).toBe(2);
});

it("the production pipeline regenerates a rejected meaning without re-extracting nicknames", async () => {
  const transcript = "Вор пытается доказать свою правоту в споре о новой игре.";
  const comments = [
    { id: "a", text: "Это Ворон." },
    { id: "b", text: "Ворон снова спорит." },
  ];
  const candidate = {
    nick: "Ворон",
    mentions: comments.map((entry) => ({ commentId: entry.id, quote: entry.text })),
  };
  const draft = (topic: string) => ({
    topic,
    subjects: [{ name: "Ворон", transcriptQuote: transcript, commentIds: ["a", "b"] }],
  });
  const responses = [
    { candidates: [candidate] },
    draft("Ворон возвращается в стриминг"),
    {
      supported: false,
      claims: [{ claim: "Герой возвращается в стриминг", quote: null }],
      reason: "Речь не подтверждает изменение деятельности героя.",
    },
    draft("Ворон пытается доказать свою правоту"),
    {
      supported: true,
      claims: [{ claim: "Герой пытается доказать свою правоту", quote: transcript }],
      reason: "Утверждение подтверждается расшифровкой.",
    },
  ];
  let calls = 0;
  let reads = 0;
  const layer = CodexTopics.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        CommentTopics.layer,
        Layer.succeed(
          TelegramComments,
          TelegramComments.of({
            read: () => {
              reads++;
              return Effect.succeed(comments);
            },
          }),
        ),
      ),
    ),
    Layer.provide(spawnerLayer(() => ({ value: responses[calls++] }))),
    Layer.provide(config),
  );
  expect(
    await Effect.runPromise(
      CodexTopics.use((service) => service.summarize(transcript, source)).pipe(
        Effect.provide(layer),
      ),
    ),
  ).toBe("Ворон пытается доказать свою правоту");
  expect(calls).toBe(5);
  expect(reads).toBe(1);
});
