import { ThumbnailQuotes } from "../src/thumbnail-quote.ts";
import { VideoTagGenerator } from "../src/video-tags.ts";
import { expect, it } from "vite-plus/test";
import { ConfigProvider, DateTime, Effect, Layer, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { AppError } from "../src/core.ts";
import { collectFirstComments, TelegramComments } from "../src/telegram-comments.ts";
import { TopicService } from "../src/topic-service.ts";
import { ModelProxy, type ModelRequest } from "../src/model.ts";
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
  reply: (
    command: ChildProcess.StandardCommand,
    prompt: string,
  ) => {
    value: unknown;
    code?: number;
    stderr?: string;
    delay?: number;
    onExit?: () => void;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") throw new Error("Unexpected pipeline");
        const input = command.options.stdin;
        const prompt = Stream.isStream(input)
          ? yield* input.pipe(Stream.decodeText(), Stream.mkString, Effect.orDie)
          : "";
        const { value, code = 0, stderr = "", delay = 0, onExit } = reply(command, prompt);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.gen(function* () {
            if (delay) yield* Effect.sleep(delay);
            onExit?.();
            return ChildProcessSpawner.ExitCode(code);
          }),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(JSON.stringify(value))),
          stderr: Stream.make(new TextEncoder().encode(stderr)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );
}
function modelLayer(
  reply: (request: ModelRequest) => { value: unknown; delay?: number; onExit?: () => void },
) {
  return Layer.succeed(
    ModelProxy,
    ModelProxy.of({
      model: "test-model",
      json: (request) =>
        Effect.suspend(() => {
          const { value, delay = 0, onExit } = reply(request);
          return Effect.sleep(delay).pipe(
            Effect.map(() => {
              onExit?.();
              return value;
            }),
          );
        }),
    }),
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

it("titles a post deleted from Telegram without comments, but keeps other tg errors retryable", async () => {
  const failing = (reason: string) =>
    TelegramComments.layer.pipe(
      Layer.provide(
        spawnerLayer(() => ({
          value: "",
          code: 6,
          stderr: `keyring warning\n{"error":{"code":"x","reason":"${reason}","message":"m"}}\n`,
        })),
      ),
      Layer.provide(config),
    );
  const read = (reason: string) =>
    Effect.runPromise(
      TelegramComments.use((service) => service.read(source)).pipe(Effect.provide(failing(reason))),
    );
  expect(await read("item.not-found")).toEqual([]);
  await expect(read("rate.limited")).rejects.toThrow("tg exited 6 (rate.limited)");
});

it("processes 500 bodies in isolated batches and combines weak mentions across batches", async () => {
  const comments = Array.from({ length: 500 }, (_, index) => ({
    id: String(index + 1),
    text: `Ворон в комментарии ${index + 1}`,
  }));
  const requests: ModelRequest[] = [];
  let active = 0;
  let maxActive = 0;
  const layer = CommentTopics.layer.pipe(
    Layer.provide(
      modelLayer((request) => {
        const { prompt } = request;
        const batch = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as typeof comments;
        expect(batch.length).toBeLessThanOrEqual(50);
        requests.push(request);
        active++;
        maxActive = Math.max(maxActive, active);
        expect(request.webSearch).toBeFalsy();
        return {
          delay: 20,
          onExit: () => {
            active--;
          },
          value: { nicks: ["Ворон"] },
        };
      }),
    ),
    Layer.provide(config),
  );
  const result = await Effect.runPromise(
    CommentTopics.use((service) =>
      Effect.gen(function* () {
        expect((yield* service.extract([])).candidates).toEqual([]);
        expect(requests).toHaveLength(0);
        return yield* service.extract(comments);
      }),
    ).pipe(Effect.provide(layer)),
  );
  expect(requests).toHaveLength(10);
  expect(maxActive).toBe(2);
  expect(active).toBe(0);
  expect(result.candidates).toHaveLength(1);
  const ids = result.candidates[0]!.mentions.map((mention) => mention.commentId);
  expect(ids).toHaveLength(50);
  expect(new Set(ids).size).toBe(50);
  expect(ids).toEqual(expect.arrayContaining(["1", "51", "451"]));
});

it("filters bodies in parallel filter-model batches while preserving selected text and excluding author metadata", async () => {
  const comments = Array.from({ length: 250 }, (_, index) => ({
    id: String(index + 1),
    text: index % 2 ? "Ха-ха" : `Ворон в игре ${index}`,
    sender_name: "hidden-author",
  }));
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const layer = CommentTopics.layer.pipe(
    Layer.provide(
      modelLayer(({ prompt, model }) => {
        expect(model).toBe("gpt-6-luna");
        expect(prompt).not.toContain("hidden-author");
        const input = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
        expect(input.comments.length).toBeLessThanOrEqual(100);
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        return {
          value: {
            keepIds: input.comments
              .filter((comment: { text: string }) => comment.text.includes("Ворон"))
              .map((comment: { id: string }) => comment.id),
          },
          delay: 20,
          onExit: () => {
            active--;
          },
        };
      }),
    ),
    Layer.provide(config),
  );
  const result = await Effect.runPromise(
    CommentTopics.use((service) => service.filter("Речь о новой игре", comments)).pipe(
      Effect.provide(layer),
    ),
  );
  expect(result).toEqual(
    comments.filter((_, index) => index % 2 === 0).map(({ id, text }) => ({ id, text })),
  );
  expect(calls).toBe(3);
  expect(maxActive).toBe(2);
  expect(active).toBe(0);
});

it("uses comment candidates in the production topic service and removes the duplicated author prefix", async () => {
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
  const layer = TopicService.layer.pipe(
    Layer.provide(
      Layer.succeed(
        VideoTagGenerator,
        VideoTagGenerator.of({
          generate: (text, context) => {
            expect(text).toBe(transcript);
            expect(context?.title).toBe("Мэддисон обсуждает спор с Ворон");
            return Effect.succeed(["спор"]);
          },
        }),
      ),
    ),
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
            filterModel: "test",
            filter: (_, input) => Effect.succeed(input),
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
        modelLayer(() => {
          throw new Error("Must not invoke legacy generator");
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        ThumbnailQuotes,
        ThumbnailQuotes.of({ generate: () => Effect.succeed("Вор опять спорит") }),
      ),
    ),
    Layer.provide(config),
  );
  expect(
    await Effect.runPromise(
      TopicService.use((service) => service.summarize(transcript, source)).pipe(
        Effect.provide(layer),
      ),
    ),
  ).toEqual({
    topic: "обсуждает спор с Ворон",
    thumbnailQuote: "Вор опять спорит",
    tags: ["спор"],
  });
  expect(reads).toBe(1);
});

it("runs semantic checking in its own isolated model call and rejects fabricated speech evidence", async () => {
  const transcript = "Герой пытается доказать свою правоту в споре о новой игре.";
  const requests: ModelRequest[] = [];
  let quote = transcript;
  const layer = CommentTopics.layer.pipe(
    Layer.provide(
      modelLayer((request) => {
        requests.push(request);
        expect(request.webSearch).toBeFalsy();
        expect(request.model).toBe("gpt-6.1-sol");
        expect(request.effort).toBe("medium");
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
  expect(requests).toHaveLength(2);
});

it("the production pipeline regenerates a rejected meaning without re-extracting nicknames", async () => {
  const transcript = "Вор пытается доказать свою правоту в споре о новой игре.";
  const comments = [
    { id: "a", text: "Это Ворон." },
    { id: "b", text: "Ворон снова спорит." },
  ];
  const draft = (topic: string) => ({
    topic,
    subjects: [{ name: "Ворон", transcriptQuote: transcript, commentIds: ["a", "b"] }],
  });
  const responses = [
    { keepIds: ["a", "b"] },
    { nicks: ["Ворон"] },
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
  const layer = TopicService.layer.pipe(
    Layer.provide(
      Layer.succeed(
        VideoTagGenerator,
        VideoTagGenerator.of({
          generate: (text) => {
            expect(text).toBe(transcript);
            return Effect.succeed(["новая игра"]);
          },
        }),
      ),
    ),
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
    Layer.provide(modelLayer(() => ({ value: responses[calls++] }))),
    Layer.provide(
      Layer.succeed(
        ThumbnailQuotes,
        ThumbnailQuotes.of({ generate: () => Effect.succeed("пытается доказать свою правоту") }),
      ),
    ),
    Layer.provide(config),
  );
  expect(
    await Effect.runPromise(
      TopicService.use((service) => service.summarize(transcript, source)).pipe(
        Effect.provide(layer),
      ),
    ),
  ).toEqual({
    topic: "Ворон пытается доказать свою правоту",
    thumbnailQuote: "пытается доказать свою правоту",
    tags: ["новая игра"],
  });
  expect(calls).toBe(6);
  expect(reads).toBe(1);
});
