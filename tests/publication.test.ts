import { afterEach, expect, it } from "vite-plus/test";
import { DateTime, Effect, Layer } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppError, Settings } from "../src/core.ts";
import { getCursor, listJobs, runSql, savePosts, Store, type Job } from "../src/database.ts";
import { Media, fingerprint } from "../src/media.ts";
import { Telegram, type Post } from "../src/telegram.ts";
import {
  drainQueue,
  importHistory,
  importCatchup,
  processJob,
  resolveJob,
  retryJob,
  scanAndPublish,
} from "../src/worker.ts";
import { UploadReview, YouTube, YouTubeClient } from "../src/youtube.ts";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
const post = (id: number, date = "2026-10-26T10:20:30.000Z", count = 1): Post => ({
  id,
  date,
  text: "",
  forwarded: false,
  images: [],
  audio: Array.from({ length: count }, () => "https://cdn4.telesco.pe/audio.ogg"),
  url: `https://t.me/maddysontg/${id}`,
});
const auth = {
  clientId: "test",
  clientSecret: "test",
  refreshToken: "test",
  channelId: "UCtest",
  channelTitle: "Test",
};
class Client extends YouTubeClient {
  readonly starts: string[] = [];
  readonly resumes: string[] = [];
  readonly publications: string[] = [];
  readonly waiting = new Set<string>();
  readonly startFailures = new Set<string>();
  readonly ambiguous = new Set<string>();
  constructor() {
    super(auth);
  }
  override async verifyChannel() {}
  override async verifyVideo() {}
  override async start(job: Job, privacy: "private" | "public" | "unlisted") {
    expect(privacy).toBe("private");
    this.starts.push(job.id);
    if (this.startFailures.has(job.id)) throw new Error("Network failure");
    return `https://www.googleapis.com/upload/youtube/v3/videos?upload_id=${job.id}`;
  }
  override async resume(session: string) {
    const id = new URL(session).searchParams.get("upload_id")!;
    this.resumes.push(id);
    if (this.ambiguous.has(id)) throw new UploadReview("Expired session with uncertain outcome");
    return `v${id.split("-")[1]!.padStart(8, "0")}${id.split("-")[2]!.padStart(2, "0")}`;
  }
  override async publish(job: Job, privacy: "private" | "public" | "unlisted") {
    expect(job.publication_privacy).toBe(privacy);
    this.publications.push(job.id);
    return !this.waiting.has(job.id);
  }
}
async function fixture(client = new Client()) {
  const dataDir = await mkdtemp(join(tmpdir(), "maddyvoice-publication-test-"));
  temporary.push(dataDir);
  const path = join(dataDir, "video.mp4");
  await writeFile(path, "12345678");
  const video = { path, ...(await fingerprint(path)) };
  const config = Layer.succeed(
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
  const store = Store.layer.pipe(Layer.provideMerge(config));
  const youtube = Layer.succeed(YouTube, YouTube.of({ load: () => Effect.succeed(client) }));
  const media = Layer.succeed(
    Media,
    Media.of({ render: () => Effect.die("Reuse the prepared file") }),
  );
  const telegram = Layer.succeed(
    Telegram,
    Telegram.of({
      page: () => Effect.fail(new AppError({ message: "Telegram unavailable" })),
      post: () => Effect.die("Reuse the prepared file"),
    }),
  );
  return {
    client,
    video,
    layer: Layer.mergeAll(store, youtube, media, telegram),
    prepare: (posts: Post[]) =>
      Effect.gen(function* () {
        yield* savePosts(posts, "history");
        yield* runSql(
          "Prepare fixture",
          "UPDATE jobs SET status='ready',video_path=?,video_sha256=?,video_size=?",
          [path, video.sha256, video.size],
        );
      }),
  };
}

it("uses Telegram IDs and audio indices even for equal or inconsistent timestamps", async () => {
  const f = await fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* f.prepare([post(10, "2026-10-25T00:00:00.000Z"), post(9, undefined, 2)]);
      yield* drainQueue(10);
      expect(f.client.starts).toEqual(["maddysontg-9-0", "maddysontg-9-1", "maddysontg-10-0"]);
      expect(f.client.publications).toEqual(f.client.starts);
      expect((yield* listJobs()).every((job) => job.status === "uploaded")).toBe(true);
    }).pipe(Effect.provide(f.layer)),
  );
});

it("blocks later recordings until processing completes and reuses the accepted video after a restart", async () => {
  const f = await fixture();
  f.client.waiting.add("maddysontg-1-0");
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* f.prepare([post(2), post(1)]);
      yield* drainQueue(10);
      const [first, later] = yield* listJobs();
      expect(first).toMatchObject({
        status: "uploading",
        youtube_id: "v0000000100",
        upload_session: null,
        publication_privacy: "private",
        attempts: 1n,
      });
      expect((yield* processJob(later!).pipe(Effect.result))._tag).toBe("Failure");
      yield* drainQueue(10);
      expect(f.client.starts).toEqual(["maddysontg-1-0"]);
    }).pipe(Effect.provide(f.layer)),
  );
  // Closing and reopening the Store simulates the worker restarting with the same database.
  f.client.waiting.clear();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* retryJob("maddysontg-1-0", false);
      yield* drainQueue(10);
      expect(f.client.starts).toEqual(["maddysontg-1-0", "maddysontg-2-0"]);
      expect(f.client.resumes).toEqual(f.client.starts);
      expect(f.client.publications).toEqual(["maddysontg-1-0", "maddysontg-1-0", "maddysontg-2-0"]);
      expect((yield* listJobs())[0]!.attempts).toBe(1n);
    }).pipe(Effect.provide(f.layer)),
  );
});

it("stops on the first network failure and honors that recording's persisted backoff", async () => {
  const f = await fixture();
  f.client.startFailures.add("maddysontg-1-0");
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* f.prepare([post(1), post(2)]);
      yield* drainQueue(10);
      expect(f.client.starts).toEqual(["maddysontg-1-0"]);
      expect((yield* listJobs())[0]!.next_attempt).toBeGreaterThan(0n);
      yield* drainQueue(10);
      expect(f.client.starts).toHaveLength(1);
      f.client.startFailures.clear();
      yield* retryJob("maddysontg-1-0", false);
      yield* drainQueue(10);
      expect(f.client.publications).toEqual(["maddysontg-1-0", "maddysontg-2-0"]);
    }).pipe(Effect.provide(f.layer)),
  );
});

it("keeps uncertain expired sessions as a queue barrier", async () => {
  const f = await fixture();
  f.client.ambiguous.add("maddysontg-1-0");
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* f.prepare([post(1), post(2)]);
      yield* drainQueue(10);
      yield* drainQueue(10);
      expect((yield* listJobs())[0]).toMatchObject({ status: "review", upload_privacy: "private" });
      expect(f.client.starts).toEqual(["maddysontg-1-0"]);
      expect(f.client.publications).toEqual([]);
    }).pipe(Effect.provide(f.layer)),
  );
});

it("blocks all publication behind a legacy session that could already be public", async () => {
  const f = await fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* f.prepare([post(1), post(2)]);
      yield* runSql(
        "Seed legacy session",
        "UPDATE jobs SET status='uploading',upload_session=?,upload_privacy='public' WHERE message_id=2",
        ["https://www.googleapis.com/upload/youtube/v3/videos?upload_id=legacy"],
      );
      yield* drainQueue(10);
      expect(f.client.starts).toEqual([]);
      expect((yield* listJobs())[1]!.status).toBe("review");
      expect((yield* resolveJob("maddysontg-2-0", "v0000000200").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect((yield* listJobs())[1]!.youtube_id).toBeNull();
    }).pipe(Effect.provide(f.layer)),
  );
});

it.each(["uploaded", "uploading"])(
  "quarantines an old queue row behind a later %s release",
  async (status) => {
    const f = await fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* f.prepare([post(1), post(2)]);
        yield* runSql(
          "Seed inconsistent old queue",
          "UPDATE jobs SET status=?,youtube_id='v0000000200',publication_privacy='public' WHERE message_id=2",
          [status],
        );
        yield* drainQueue(10);
        expect(f.client.starts).toEqual([]);
        expect((yield* listJobs())[0]!.status).toBe("review");
      }).pipe(Effect.provide(f.layer)),
    );
  },
);

it("rejects history older than a public release whose completion was not persisted", async () => {
  const f = await fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* f.prepare([post(2)]);
      yield* runSql(
        "Seed potentially visible release",
        "UPDATE jobs SET status='uploading',youtube_id='v0000000200',publication_privacy='public'",
      );
      expect((yield* savePosts([post(3), post(1)], "history").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect((yield* listJobs()).map((job) => job.message_id)).toEqual([2n]);
      expect(yield* savePosts([post(2)], "history")).toBe(0);
    }).pipe(Effect.provide(f.layer)),
  );
});

it("does not publish cached recordings after a failed Telegram scan", async () => {
  const f = await fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* f.prepare([post(1)]);
      expect((yield* scanAndPublish(10).pipe(Effect.result))._tag).toBe("Failure");
      expect(f.client.starts).toEqual([]);
    }).pipe(Effect.provide(f.layer)),
  );
});

it("commits complete history batches atomically and preserves the live cursor over a pagination failure", async () => {
  const f = await fixture();
  let fail = true;
  const telegram = Layer.succeed(
    Telegram,
    Telegram.of({
      page: (before) =>
        Effect.gen(function* () {
          if (before === undefined) return { posts: [post(20)], before: 20 };
          if (fail) return yield* new AppError({ message: "History network failure" });
          return { posts: [post(10), post(1, "2026-09-30T00:00:00.000Z")], before: 1 };
        }),
      post: () => Effect.die("Not used"),
    }),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* savePosts([], "live", 77);
      expect((yield* importHistory("2026-10-01", "2026-10-31", 2).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* listJobs()).toEqual([]);
      fail = false;
      yield* importHistory("2026-10-01", "2026-10-31", 2);
      expect((yield* listJobs()).map((job) => job.message_id)).toEqual([10n, 20n]);
      expect(yield* getCursor()).toBe(77);
    }).pipe(Effect.provide(Layer.mergeAll(f.layer, telegram))),
  );
});

it("rejects a late historical import atomically while keeping existing duplicate imports harmless", async () => {
  const f = await fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* savePosts([post(2)], "live", 77);
      yield* runSql(
        "Seed published frontier",
        "UPDATE jobs SET status='uploaded',youtube_id='v0000000200'",
      );
      expect((yield* savePosts([post(3), post(1)], "history").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect((yield* listJobs()).map((job) => job.message_id)).toEqual([2n]);
      expect(yield* savePosts([post(2)], "history")).toBe(0);
      expect(yield* getCursor()).toBe(77);
    }).pipe(Effect.provide(f.layer)),
  );
});

it("allows only a complete explicitly authorized catch-up window behind the frontier", async () => {
  const f = await fixture();
  const now = DateTime.formatIso(DateTime.add(Effect.runSync(DateTime.now), { minutes: -1 }));
  const telegram = Layer.succeed(
    Telegram,
    Telegram.of({
      page: () => Effect.succeed({ posts: [post(1, now)], before: undefined }),
      post: () => Effect.die("Reuse the prepared render"),
    }),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* savePosts([post(2)], "live", 77);
      yield* runSql(
        "Seed published frontier",
        "UPDATE jobs SET status='uploaded',youtube_id='v0000000200'",
      );
      expect((yield* importCatchup(14, false).pipe(Effect.result))._tag).toBe("Failure");
      yield* importCatchup(14, true);
      const imported = (yield* listJobs())[0]!;
      expect(imported.message_id).toBe(1n);
      expect(imported.catchup_batch).toBeTypeOf("string");
      yield* runSql(
        "Prepare catch-up render",
        "UPDATE jobs SET status='ready',video_path=?,video_sha256=?,video_size=? WHERE message_id=1",
        [f.video.path, f.video.sha256, f.video.size],
      );
      yield* drainQueue(10);
      expect((yield* listJobs()).every((job) => job.status === "uploaded")).toBe(true);
      expect((yield* savePosts([post(0)], "history").pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* getCursor()).toBe(77);
      yield* savePosts([post(3), post(4)], "live", 78);
      f.client.startFailures.add("maddysontg-3-0");
      expect(
        (yield* listJobs())
          .filter((job) => job.message_id > 2n)
          .every((job) => job.catchup_batch === null),
      ).toBe(true);
    }).pipe(Effect.provide(Layer.mergeAll(f.layer, telegram))),
  );
});

it("resolves the earliest known video through the same publication barrier and refuses a duplicate upload", async () => {
  const f = await fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* f.prepare([post(1), post(2)]);
      yield* runSql(
        "Seed known failed publication",
        "UPDATE jobs SET status='review',youtube_id='v0000000100',publication_privacy='private' WHERE message_id=1",
      );
      expect((yield* retryJob("maddysontg-1-0", true).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* resolveJob("maddysontg-2-0", "v0000000200").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      yield* resolveJob("maddysontg-1-0", "v0000000100");
      expect((yield* listJobs())[0]!.status).toBe("uploaded");
      expect(f.client.starts).toEqual([]);
    }).pipe(Effect.provide(f.layer)),
  );
});

it("keeps the completion barrier durable across interruption and preserves the committed public target", async () => {
  const f = await fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* f.prepare([post(1)]);
      yield* runSql(
        "Seed processed private video",
        `UPDATE jobs SET status='uploading',youtube_id='v0000000100',
      upload_privacy='private',publication_privacy='public'`,
      );
      const job = (yield* listJobs())[0]!;
      expect((yield* processJob(job, "private").pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* processJob(job).pipe(Effect.timeout("100 millis"), Effect.result))._tag).toBe(
        "Failure",
      );
      expect(f.client.publications).toEqual(["maddysontg-1-0"]);
      expect((yield* listJobs())[0]!.status).toBe("uploading");
    }).pipe(Effect.provide(f.layer)),
  );
  const started = performance.now();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* drainQueue(1);
      expect((yield* listJobs())[0]).toMatchObject({
        status: "uploaded",
        publication_privacy: "public",
      });
      expect(f.client.starts).toEqual([]);
      expect(f.client.resumes).toEqual([]);
    }).pipe(Effect.provide(f.layer)),
  );
  expect(performance.now() - started).toBeGreaterThanOrEqual(1900);
});
