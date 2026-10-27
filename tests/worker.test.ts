import { afterEach, describe, expect, it } from "vite-plus/test";
import { DateTime, Effect, Layer, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, Settings } from "../src/core.ts";
import { getCursor, listJobs, runSql, savePosts, Store, withWorkerLock } from "../src/database.ts";
import { dateRange, importHistory, poll, processJob, retryJob } from "../src/worker.ts";
import { Telegram, type Page, type Post } from "../src/telegram.ts";
import { Media, fingerprint } from "../src/media.ts";
import { YouTube, YouTubeClient } from "../src/youtube.ts";
import { writeFile } from "node:fs/promises";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

const post = (id: number, date = "2026-10-26T10:20:30.000Z", audio = true): Post => ({
  id,
  date,
  audio: audio ? ["https://cdn4.telesco.pe/audio.ogg"] : [],
  images: [],
  text: "",
  forwarded: false,
  url: `https://t.me/maddysontg/${id}`,
});

async function testStore() {
  const dataDir = await mkdtemp(join(tmpdir(), "maddyvoice-test-"));
  temporary.push(dataDir);
  const settings = Layer.succeed(
    Settings,
    Settings.of({
      channel: "maddysontg",
      dataDir,
      pollSeconds: 300,
      privacy: "private",
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      expectedChannel: "",
    }),
  );
  return Store.layer.pipe(Layer.provideMerge(settings));
}

describe("BoxDB queue and polling", () => {
  it("starts with new messages only and catches up across multiple pages without duplicates", async () => {
    const store = await testStore();
    let pages: Record<string, Page> = { latest: { posts: [post(10), post(11)], before: 10 } };
    const telegram = Layer.succeed(
      Telegram,
      Telegram.of({
        page: (before) =>
          Effect.sync(() => {
            const result = pages[before ?? "latest"];
            if (!result) throw new Error("Unexpected page");
            return result;
          }),
        post: () => Effect.succeed(post(1)),
      }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* poll();
        expect(yield* getCursor()).toBe(11);
        expect(yield* listJobs()).toHaveLength(0);
        pages = {
          latest: { posts: [post(14), post(15)], before: 14 },
          14: { posts: [post(10), post(11), post(12), post(13, undefined, false)], before: 10 },
        };
        yield* poll();
        yield* poll();
        expect(yield* getCursor()).toBe(15);
        expect((yield* listJobs()).map((job) => job.message_id)).toEqual([12n, 14n, 15n]);
      }).pipe(Effect.provide(store), Effect.provide(telegram)),
    );
  });

  it("imports a historical date range independently of the live boundary and skips forwards", async () => {
    const store = await testStore();
    const historical = post(3, "2026-09-10T01:02:03.000Z");
    const telegram = Layer.succeed(
      Telegram,
      Telegram.of({
        page: () =>
          Effect.succeed({
            posts: [
              post(1, "2026-08-01T00:00:00.000Z"),
              historical,
              { ...post(4), forwarded: true },
              post(20),
            ],
            before: undefined,
          }),
        post: () => Effect.succeed(historical),
      }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* savePosts([], "live", 99);
        yield* importHistory("2026-09-01", "2026-09-30", 2);
        yield* importHistory("2026-09-01", "2026-09-30", 2);
        yield* savePosts([{ ...post(4), forwarded: true }], "history");
        expect(yield* getCursor()).toBe(99);
        const jobs = yield* listJobs();
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({
          message_id: 3n,
          origin: "history",
          published_at: historical.date,
        });
      }).pipe(Effect.provide(store), Effect.provide(telegram)),
    );
  });

  it("preserves cursor and does not partially commit a failed live catch-up", async () => {
    const store = await testStore();
    const telegram = Layer.succeed(
      Telegram,
      Telegram.of({
        page: (before) =>
          before
            ? Effect.fail(new AppError({ message: "Network down" }))
            : Effect.succeed({ posts: [post(15)], before: 15 }),
        post: () => Effect.succeed(post(1)),
      }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* savePosts([], "live", 10);
        const result = yield* poll().pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(yield* getCursor()).toBe(10);
        expect(yield* listJobs()).toHaveLength(0);
      }).pipe(Effect.provide(store), Effect.provide(telegram)),
    );
  });
});

it("uses calendar months and inclusive UTC end dates", () => {
  const now = DateTime.makeUnsafe("2026-10-27T06:00:00Z");
  expect(dateRange(undefined, undefined, 2, now)).toEqual({
    from: "2026-08-27T06:00:00.000Z",
    to: "2026-10-27T06:00:00.000Z",
  });
  expect(dateRange("2026-08-27", "2026-10-26", 2, now).to).toBe("2026-10-27T00:00:00.000Z");
  expect(() => dateRange("2026-02-30", undefined, 2, now)).toThrow("Invalid calendar date");
});

it("persists the session BEFORE video bytes and recovers a lost completion without another upload", async () => {
  const store = await testStore();
  const directory = temporary.at(-1)!;
  const file = join(directory, "video.mp4");
  await writeFile(file, "12345678");
  const info = await fingerprint(file);
  const session = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=persisted";
  let starts = 0;
  let puts = 0;
  let readSession = async () => "";
  const client = new YouTubeClient(
    {
      clientId: "test",
      clientSecret: "test",
      refreshToken: "test",
      channelId: "UCtest",
      channelTitle: "Test",
    },
    async (url, init) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "access" });
      if (init?.method === "POST") {
        starts++;
        return new Response(null, { headers: { Location: session } });
      }
      expect(await readSession()).toBe(session);
      puts++;
      if (puts === 1) return new Response(null, { status: 308 });
      if (puts === 2) throw new Error("Final response lost");
      return Response.json({ id: "abcdefghijk" });
    },
  );
  const youtube = Layer.succeed(YouTube, YouTube.of({ load: () => Effect.succeed(client) }));
  const media = Layer.succeed(
    Media,
    Media.of({ render: () => Effect.fail(new AppError({ message: "Must reuse existing video" })) }),
  );
  const telegram = Layer.succeed(
    Telegram,
    Telegram.of({
      page: () => Effect.succeed({ posts: [], before: undefined }),
      post: () => Effect.succeed(post(8)),
    }),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* savePosts([post(8)], "live");
      yield* runSql(
        "Ready test recording",
        "UPDATE jobs SET status='ready', video_path=?, video_sha256=?, video_size=?",
        [file, info.sha256, info.size],
      );
      const { db } = yield* Store;
      readSession = async () =>
        Schema.decodeUnknownSync(Schema.Struct({ upload_session: Schema.String }))(
          await db.query`SELECT upload_session FROM jobs`.get(),
        ).upload_session;
      const job = (yield* listJobs())[0]!;
      expect((yield* processJob(job).pipe(Effect.result))._tag).toBe("Failure");
      const interrupted = (yield* listJobs())[0]!;
      expect(interrupted.status).toBe("uploading");
      yield* processJob(interrupted);
      expect((yield* listJobs())[0]).toMatchObject({
        status: "uploaded",
        youtube_id: "abcdefghijk",
        attempts: 2n,
      });
      expect(starts).toBe(1);
    }).pipe(
      Effect.provide(store),
      Effect.provide(youtube),
      Effect.provide(media),
      Effect.provide(telegram),
    ),
  );
});

it("requires explicit reconciliation before recreating an uncertain upload", async () => {
  const store = await testStore();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* savePosts([post(8)], "live");
      yield* runSql(
        "Mark uncertain",
        "UPDATE jobs SET status='review', upload_session='https://example.com/old'",
      );
      const key = (yield* listJobs())[0]!.id;
      expect((yield* retryJob(key, false).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* listJobs())[0]!.status).toBe("review");
      yield* retryJob(key, true);
      expect((yield* listJobs())[0]).toMatchObject({ status: "pending", upload_session: null });
    }).pipe(Effect.provide(store)),
  );
});

it("releases the worker lock and excludes a second writer", async () => {
  const store = await testStore();
  await Effect.runPromise(
    Effect.gen(function* () {
      const nested = yield* withWorkerLock(withWorkerLock(Effect.void).pipe(Effect.result));
      expect(nested._tag).toBe("Failure");
      yield* withWorkerLock(Effect.void);
    }).pipe(Effect.provide(store)),
  );
});
