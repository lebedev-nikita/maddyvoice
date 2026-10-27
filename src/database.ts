import { BoxDB, MigrationSet } from "@boxdb/client";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { AppError, attempt, Paths, Settings } from "./core.ts";
import type { Post } from "./telegram.ts";

const Job = Schema.Struct({
  id: Schema.String,
  channel: Schema.String,
  message_id: Schema.BigInt,
  audio_index: Schema.BigInt,
  published_at: Schema.String,
  source_url: Schema.String,
  caption: Schema.String,
  origin: Schema.Literals(["live", "history"]),
  status: Schema.Literals(["pending", "ready", "uploading", "uploaded", "review"]),
  attempts: Schema.BigInt,
  next_attempt: Schema.BigInt,
  error: Schema.NullOr(Schema.String),
  video_path: Schema.NullOr(Schema.String),
  video_sha256: Schema.NullOr(Schema.String),
  video_size: Schema.NullOr(Schema.BigInt),
  upload_session: Schema.NullOr(Schema.String),
  upload_privacy: Schema.NullOr(Schema.Literals(["private", "public", "unlisted"])),
  publication_privacy: Schema.NullOr(Schema.Literals(["private", "public", "unlisted"])),
  catchup_batch: Schema.NullOr(Schema.String),
  youtube_id: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
});
export type Job = typeof Job.Type;
const jobKey = (channel: string, message: number, index: number) =>
  `${channel}-${message}-${index}`;
const Position = Schema.Struct({ message_id: Schema.BigInt, audio_index: Schema.BigInt });

async function canInsertRecording(
  tx: Awaited<ReturnType<BoxDB["begin"]>>,
  channel: string,
  message: number,
  index: number,
  frontier: typeof Position.Type | undefined,
  catchup: boolean,
) {
  if (catchup) return true;
  if (!frontier || BigInt(message) > frontier.message_id) return true;
  if (BigInt(message) === frontier.message_id && BigInt(index) > frontier.audio_index) return true;
  const existing = await tx.query`SELECT id FROM jobs WHERE channel=${channel}
    AND message_id=${message} AND audio_index=${index}`.get();
  if (existing !== undefined) return false;
  throw new Error(
    "Recording predates a completed or potentially visible publication; import before publishing or prepare a chronological channel rebuild",
  );
}

async function insertPostRecordings(
  tx: Awaited<ReturnType<BoxDB["begin"]>>,
  channel: string,
  post: Post,
  frontier: typeof Position.Type | undefined,
  now: string,
  origin: "live" | "history",
  catchupId?: string,
) {
  if (post.forwarded) return 0;
  let inserted = 0;
  for (let index = 0; index < post.audio.length; index++) {
    if (!(await canInsertRecording(tx, channel, post.id, index, frontier, catchupId !== undefined)))
      continue;
    const result = await tx.query`INSERT INTO jobs
      (id, channel, message_id, audio_index, published_at, source_url, caption, origin, created_at, updated_at, catchup_batch)
      VALUES (${jobKey(channel, post.id, index)}, ${channel}, ${post.id}, ${index}, ${post.date},
      ${post.url}, ${post.text}, ${origin}, ${now}, ${now}, ${catchupId ?? null}) ON CONFLICT DO NOTHING`.run();
    inserted += Number(result.changes);
    if (catchupId) {
      await tx.query`UPDATE jobs SET catchup_batch=${catchupId}
        WHERE channel=${channel} AND message_id=${post.id} AND audio_index=${index}
          AND status!='uploaded' AND catchup_batch IS NULL`.run();
    }
  }
  return inserted;
}

export class Store extends Context.Service<
  Store,
  {
    readonly db: BoxDB;
  }
>()("maddyvoice/Store") {
  static readonly layer = Layer.effect(
    Store,
    Effect.gen(function* () {
      const config = yield* Settings;
      yield* attempt("Create data directory", () =>
        mkdir(config.dataDir, { recursive: true, mode: 0o700 }),
      );
      const db = yield* Effect.acquireRelease(
        attempt("Open BoxDB", () =>
          BoxDB.open(join(config.dataDir, "maddyvoice.db"), { format: "binary" }),
        ),
        (db) => Effect.promise(() => db.close()),
      );
      yield* attempt("Migrate BoxDB", async () => {
        const migrations = await MigrationSet.read(Paths.migrations);
        await migrations.up(db);
      });
      return Store.of({ db });
    }),
  );
}

export const withWorkerLock = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* Settings;
      yield* Effect.acquireRelease(
        attempt("Acquire worker lock (another worker may be running)", async () => {
          await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
          const path = join(config.dataDir, "worker");
          await writeFile(path, "", { flag: "a", mode: 0o600 });
          return lockfile.lock(path, { stale: 120_000, update: 30_000, retries: 0 });
        }),
        (release) => Effect.promise(() => release()),
      );
      return yield* program;
    }),
  );

export const getCursor = Effect.fn("Store.getCursor")(function* () {
  const { db } = yield* Store;
  const { channel } = yield* Settings;
  const row = yield* attempt("Read live cursor", () =>
    db.query`SELECT cursor FROM sources WHERE channel = ${channel}`.get(),
  );
  if (row === undefined) return undefined;
  return Number(Schema.decodeUnknownSync(Schema.Struct({ cursor: Schema.BigInt }))(row).cursor);
});

export const savePosts = Effect.fn("Store.savePosts")(function* (
  posts: readonly Post[],
  origin: "live" | "history",
  cursor?: number,
  catchup?: { id: string; from: string; to: string },
) {
  const { db } = yield* Store;
  const { channel } = yield* Settings;
  const now = DateTime.formatIso(yield* DateTime.now);
  if (
    catchup &&
    (origin !== "history" ||
      cursor !== undefined ||
      posts.some((post) => post.date < catchup.from || post.date >= catchup.to))
  )
    return yield* new AppError({
      message: "Catch-up must be a bounded history scan without a live cursor",
    });
  return yield* attempt("Save discovered recordings", async () => {
    await using tx = await db.begin();
    // A known non-private release may have succeeded even if its response was lost.
    const row = await tx.query`SELECT message_id, audio_index FROM jobs WHERE channel=${channel}
      AND (status='uploaded' OR (youtube_id IS NOT NULL
        AND (publication_privacy IS NULL OR publication_privacy != 'private')))
      ORDER BY message_id DESC, audio_index DESC LIMIT 1`.get();
    const frontier = row === undefined ? undefined : Schema.decodeUnknownSync(Position)(row);
    let inserted = 0;
    for (const post of posts) {
      inserted += await insertPostRecordings(tx, channel, post, frontier, now, origin, catchup?.id);
    }
    if (cursor !== undefined) {
      await tx.query`INSERT INTO sources(channel, cursor, checked_at) VALUES (${channel}, ${cursor}, ${now})
        ON CONFLICT(channel) DO UPDATE SET cursor = excluded.cursor, checked_at = excluded.checked_at`.run();
    }
    await tx.commit();
    return inserted;
  });
});

export const listJobs = Effect.fn("Store.listJobs")(function* () {
  const { db } = yield* Store;
  const { channel } = yield* Settings;
  return yield* attempt("Read job queue", async () =>
    Schema.decodeUnknownSync(Schema.Array(Job))(
      await db.query`SELECT * FROM jobs WHERE channel = ${channel} ORDER BY message_id, audio_index`,
    ),
  );
});

export const runSql = (
  message: string,
  sql: string,
  values: readonly (string | number | bigint | null)[] = [],
) =>
  Effect.gen(function* () {
    const { db } = yield* Store;
    yield* attempt(message, () => db.execute(sql, [...values]));
  });
