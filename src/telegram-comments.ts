import { Config, Context, DateTime, Effect, Layer, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { AppError, attempt } from "./core.ts";
import { commentBodies, type CommentBody } from "./comment-topics.ts";
import { commentsReadyAt, type TopicSource } from "./topic.ts";
import { commandJson } from "./commands.ts";

const MessageId = Schema.String.check(Schema.isPattern(/^[1-9]\d*$/));
const Page = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: MessageId, text: Schema.String })),
  page: Schema.Struct({ has_more: Schema.Boolean }),
  meta: Schema.Struct({ complete: Schema.Boolean }),
});
const Post = Schema.Struct({
  item: Schema.Struct({
    id: MessageId,
    timestamp: Schema.String,
    provider_metadata: Schema.Struct({ comments: Schema.optionalKey(Schema.Number) }),
  }),
  meta: Schema.Struct({ complete: Schema.Boolean }),
});

export const collectFirstComments = Effect.fn("collectFirstComments")(function* (
  page: (before?: string) => Effect.Effect<unknown, AppError>,
) {
  let before: string | undefined;
  let earliest: readonly CommentBody[] = [];
  while (true) {
    const raw = yield* page(before);
    const result = yield* attempt("Validate Telegram comment page", async () =>
      Schema.decodeUnknownSync(Page)(raw),
    );
    if (!result.meta.complete)
      return yield* new AppError({ message: "Incomplete Telegram comment page" });
    const boundary = before;
    if (boundary !== undefined && result.items.some((item) => BigInt(item.id) >= BigInt(boundary)))
      return yield* new AppError({ message: "Telegram comments pagination did not advance" });
    const entries = new Map([...earliest, ...result.items].map((entry) => [entry.id, entry]));
    earliest = [...entries.values()]
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
      .slice(0, 500);
    if (!result.page.has_more) return commentBodies(earliest);
    const oldest = result.items.reduce<string | undefined>(
      (id, item) => (!id || BigInt(item.id) < BigInt(id) ? item.id : id),
      undefined,
    );
    if (!oldest)
      return yield* new AppError({ message: "Telegram returned an empty page with more comments" });
    before = oldest;
  }
});

export class TelegramComments extends Context.Service<
  TelegramComments,
  {
    read(source: TopicSource): Effect.Effect<readonly CommentBody[], AppError>;
  }
>()("maddyvoice/TelegramComments") {
  static readonly layer = Layer.effect(
    TelegramComments,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const binary = yield* Config.String("TG_PATH").pipe(Config.withDefault("tg"));
      const profile = yield* Config.String("TG_PROFILE");
      if (!profile.trim())
        return yield* new AppError({ message: "TG_PROFILE must select an existing tg login" });
      const channel = yield* Config.String("TELEGRAM_CHANNEL").pipe(
        Config.withDefault("maddysontg"),
      );
      const run = (args: readonly string[]) =>
        commandJson(
          ChildProcess.make(binary, [
            profile,
            ...args,
            "--no-input",
            "--no-record",
            "--timeout",
            "45s",
          ]),
          "tg",
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      const read = Effect.fn("TelegramComments.read")(function* (source: TopicSource) {
        if (source.channel !== channel)
          return yield* new AppError({ message: "Comment source does not match TELEGRAM_CHANNEL" });
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const readyAt = yield* attempt("Validate Telegram publication time", async () =>
          commentsReadyAt(source.publishedAt),
        );
        if (now < readyAt)
          return yield* new AppError({ message: "Telegram post is less than one hour old" });
        const raw = yield* run([
          "messages",
          "show",
          `@${source.channel}`,
          source.messageId,
          "--json=id,timestamp,provider_metadata",
        ]);
        const post = yield* attempt("Validate source Telegram post", async () =>
          Schema.decodeUnknownSync(Post)(raw),
        );
        const sameTime = yield* attempt(
          "Verify original publication time",
          async () =>
            DateTime.toEpochMillis(DateTime.makeUnsafe(post.item.timestamp)) ===
            DateTime.toEpochMillis(DateTime.makeUnsafe(source.publishedAt)),
        );
        if (!post.meta.complete || post.item.id !== source.messageId || !sameTime)
          return yield* new AppError({
            message: "Telegram post identity or publication date does not match the title request",
          });
        if (now < commentsReadyAt(post.item.timestamp))
          return yield* new AppError({ message: "Telegram post is less than one hour old" });
        if (!post.item.provider_metadata.comments) return [];
        return yield* collectFirstComments((before) =>
          run([
            "messages",
            "comments",
            `@${source.channel}`,
            source.messageId,
            "--limit",
            "100",
            "--json=id,text",
            ...(before ? ["--cursor", `before:${before}`] : []),
          ]),
        );
      });
      return TelegramComments.of({ read });
    }),
  );
}
