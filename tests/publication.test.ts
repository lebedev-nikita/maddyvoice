import { afterEach, expect, it } from "vite-plus/test";
import { DateTime, Effect, Layer } from "effect";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppError, attempt, Settings } from "../src/core.ts";
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
import { Topics } from "../src/topic.ts";
import { Thumbnails } from "../src/thumbnail.ts";
import { drainTitles, listTitles } from "../src/titles.ts";

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
  readonly events: string[] = [];
  captionsReady = true;
  titleFailure = false;
  thumbnailFailure = false;
  manualTitle = false;
  captionReads = 0;
  constructor() {
    super(auth);
  }
  override async verifyChannel() {}
  override async verifyVideo() {}
  override async captions() {
    this.captionReads++;
    return this.captionsReady ? "Большой рассказ про новую игру." : undefined;
  }
  override async updateTitle(job: Job): Promise<"applied" | "manual"> {
    this.events.push(`title:${job.id}`);
    if (this.titleFailure) throw new Error("Title update response lost");
    return this.manualTitle ? "manual" : "applied";
  }
  override async setThumbnail(job: Pick<Job, "id" | "youtube_id">) {
    this.events.push(`thumbnail:${job.id}`);
    if (this.thumbnailFailure) throw new Error("HTTP 429 uploadRateLimitExceeded");
    return [{ high: { url: "https://i.ytimg.com/image.jpg" } }];
  }
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
    this.events.push(`publish:${job.id}`);
    return !this.waiting.has(job.id);
  }
}
async function fixture(client = new Client(), metadataReady = true) {
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
      chromium: "chromium",
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
  const metadata = { generations: 0, renders: 0, renderFailure: false };
  const topics = Layer.succeed(
    Topics,
    Topics.of({
      enabled: true,
      summarize: () =>
        Effect.sync(() => {
          metadata.generations++;
          return {
            topic: "выбирает новую игру",
            thumbnailQuote: "Большой рассказ",
            tags: ["игры"],
          };
        }),
    }),
  );
  const thumbnails = Layer.succeed(
    Thumbnails,
    Thumbnails.of({
      render: (_quote, _recording, destination) =>
        attempt("Render fixture thumbnail", async () => {
          metadata.renders++;
          if (metadata.renderFailure) throw new Error("FFmpeg thumbnail render failed");
          await writeFile(destination, "thumbnail");
          return destination;
        }),
    }),
  );
  await mkdir(join(dataDir, "thumbnails"));
  return {
    client,
    video,
    metadata,
    layer: Layer.mergeAll(store, youtube, media, telegram, topics, thumbnails),
    prepare: (posts: Post[]) =>
      Effect.gen(function* () {
        yield* savePosts(posts, "history");
        yield* runSql(
          "Prepare fixture",
          "UPDATE jobs SET status='ready',video_path=?,video_sha256=?,video_size=?",
          [path, video.sha256, video.size],
        );
        if (metadataReady) {
          for (const job of yield* listJobs()) {
            yield* runSql(
              "Seed confirmed fixture metadata",
              `INSERT INTO video_titles
                (job_id,video_id,status,topic,title,thumbnail_quote,thumbnail_applied_quote,
                  generation_version,created_at,updated_at)
                VALUES (?,?,'applied','выбирает новую игру','Мэддисон выбирает новую игру',
                  'Большой рассказ','Большой рассказ',1,?,?) ON CONFLICT DO NOTHING`,
              [
                job.id,
                `v${job.message_id.toString().padStart(8, "0")}${job.audio_index.toString().padStart(2, "0")}`,
                job.created_at,
                job.updated_at,
              ],
            );
          }
        }
      }),
  };
}

const metadataDue = Effect.fn("test.metadataDue")(function* () {
  yield* runSql("Advance metadata retry", "UPDATE video_titles SET next_attempt=0");
  yield* runSql("Advance publication retry", "UPDATE jobs SET next_attempt=0");
});

it("keeps a new upload private while waiting for captions and persists that wait across restarts", async () => {
  const f = await fixture(new Client(), false);
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* f.prepare([post(1), post(2)]);
      yield* drainQueue(10);
      expect(f.client.starts).toEqual(["maddysontg-1-0"]);
      expect(f.client.publications).toEqual([]);
      expect(f.client.captionReads).toBe(0);
      expect((yield* listJobs())[0]).toMatchObject({
        status: "uploading",
        youtube_id: "v0000000100",
      });
      expect((yield* listTitles())[0]!.next_attempt).toBeGreaterThan(0n);
      yield* drainTitles(10, true);
      expect(f.client.captionReads).toBe(0);
      f.client.captionsReady = false;
      yield* metadataDue();
      yield* drainQueue(10);
      expect(f.client.captionReads).toBe(1);
      expect((yield* listTitles())[0]!.error).toBe("Russian YouTube captions are not ready");
      expect((yield* listJobs())[0]!.error).toBe("Russian YouTube captions are not ready");
    }).pipe(Effect.provide(f.layer)),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* drainQueue(10);
      expect(f.client.captionReads).toBe(1);
      expect(f.client.publications).toEqual([]);
      expect(f.client.starts).toEqual(["maddysontg-1-0"]);
    }).pipe(Effect.provide(f.layer)),
  );
});

it.each(["title", "render", "thumbnail"])(
  "blocks publication on a %s failure and resumes the same video with saved metadata",
  async (failure) => {
    const f = await fixture(new Client(), false);
    f.client.titleFailure = failure === "title";
    f.client.thumbnailFailure = failure === "thumbnail";
    f.metadata.renderFailure = failure === "render";
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* f.prepare([post(1), post(2)]);
        yield* runSql("Use public target", "UPDATE jobs SET publication_privacy='public'");
        yield* drainQueue(10);
        yield* metadataDue();
        yield* drainQueue(10);
        expect(f.client.publications).toEqual([]);
        expect(f.client.starts).toEqual(["maddysontg-1-0"]);
        expect((yield* listJobs())[0]).toMatchObject({
          status: "uploading",
          youtube_id: "v0000000100",
        });
        expect((yield* listJobs())[0]!.next_attempt).toBeGreaterThan(0n);
        expect((yield* listTitles())[0]).toMatchObject({
          status: "pending",
          thumbnail_quote: "Большой рассказ",
          transcript: null,
        });
      }).pipe(Effect.provide(f.layer)),
    );
    f.client.titleFailure = false;
    f.client.thumbnailFailure = false;
    f.metadata.renderFailure = false;
    await Effect.runPromise(
      Effect.gen(function* () {
        const before = [...f.client.events];
        yield* drainQueue(10);
        expect(f.client.events).toEqual(before);
        yield* metadataDue();
        yield* drainQueue(1);
        expect(f.client.events.slice(-3)).toEqual([
          "title:maddysontg-1-0",
          "thumbnail:maddysontg-1-0",
          "publish:maddysontg-1-0",
        ]);
        expect(f.client.publications).toEqual(["maddysontg-1-0"]);
        expect(f.client.starts).toEqual(["maddysontg-1-0"]);
        expect(f.client.resumes).toEqual(f.client.starts);
        expect(f.metadata.generations).toBe(1);
        expect(f.client.captionReads).toBe(1);
        expect((yield* listTitles())[0]).toMatchObject({
          status: "applied",
          thumbnail_applied_quote: "Большой рассказ",
        });
        expect((yield* listJobs())[0]!.status).toBe("uploaded");
        expect((yield* listJobs())[1]!.status).toBe("ready");
      }).pipe(Effect.provide(f.layer)),
    );
  },
);

it("continues updating published videos while the private publication head is waiting", async () => {
  const f = await fixture(new Client(), false);
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* f.prepare([post(1, "2026-10-28T10:20:30.000Z"), post(2)]);
      yield* runSql(
        "Seed old published video",
        "UPDATE jobs SET status='uploaded', youtube_id='v0000000100' WHERE message_id=1",
      );
      yield* drainQueue(10);
      expect(f.client.starts).toEqual(["maddysontg-2-0"]);
      yield* drainTitles(1, true);
      expect(f.client.events).toEqual(["title:maddysontg-1-0", "thumbnail:maddysontg-1-0"]);
      expect((yield* listTitles()).find((item) => item.job_id === "maddysontg-1-0")!.status).toBe(
        "applied",
      );
      expect((yield* listJobs())[1]!.status).toBe("uploading");
      expect(f.client.publications).toEqual([]);
    }).pipe(Effect.provide(f.layer)),
  );
});

it("retries a staged upload's metadata backoff on request instead of waiting it out", async () => {
  const f = await fixture(new Client(), false);
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* f.prepare([post(1), post(2)]);
      yield* drainQueue(10);
      expect(f.metadata.generations).toBe(0);
      expect(f.client.publications).toEqual([]);
      yield* retryJob("maddysontg-1-0", false);
      yield* drainQueue(1);
      expect(f.metadata.generations).toBe(1);
      expect(f.client.publications).toEqual(["maddysontg-1-0"]);
    }).pipe(Effect.provide(f.layer)),
  );
});

it("refuses publication when metadata generation is disabled", async () => {
  const f = await fixture(new Client(), false);
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* f.prepare([post(1), post(2)]);
      yield* drainQueue(10);
      expect(f.client.publications).toEqual([]);
      expect(f.client.starts).toEqual(["maddysontg-1-0"]);
      expect((yield* listJobs())[0]!.error).toContain("requires TOPICS_URL");
    }).pipe(
      Effect.provideService(
        Topics,
        Topics.of({ enabled: false, summarize: () => Effect.die("Disabled") }),
      ),
      Effect.provide(f.layer),
    ),
  );
});

it("regenerates a legacy staged title that has no approved thumbnail quote", async () => {
  const f = await fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* f.prepare([post(1)]);
      yield* runSql(
        "Seed incomplete legacy metadata",
        "UPDATE video_titles SET thumbnail_quote=NULL, thumbnail_applied_quote=NULL",
      );
      yield* drainQueue(1);
      expect(f.client.events).toEqual([
        "title:maddysontg-1-0",
        "thumbnail:maddysontg-1-0",
        "publish:maddysontg-1-0",
      ]);
      expect(f.metadata.generations).toBe(1);
      expect((yield* listTitles())[0]).toMatchObject({
        status: "applied",
        thumbnail_applied_quote: "Большой рассказ",
      });
    }).pipe(Effect.provide(f.layer)),
  );
});

it("requires review when saved metadata confirms a different YouTube video", async () => {
  const f = await fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* f.prepare([post(1), post(2)]);
      yield* runSql(
        "Seed mismatched metadata",
        "UPDATE video_titles SET video_id='abcdefghijk' WHERE job_id='maddysontg-1-0'",
      );
      yield* drainQueue(10);
      expect((yield* listJobs())[0]!.status).toBe("review");
      expect(f.client.publications).toEqual([]);
      expect(f.client.starts).toEqual(["maddysontg-1-0"]);
    }).pipe(Effect.provide(f.layer)),
  );
});

it("reconciles a lost publication response without regenerating or reuploading confirmed metadata", async () => {
  class LostPublicationClient extends Client {
    override async publish(job: Job, privacy: "private" | "public" | "unlisted") {
      const ready = await super.publish(job, privacy);
      if (this.publications.length === 1) throw new Error("Public visibility response lost");
      return ready;
    }
  }
  const f = await fixture(new LostPublicationClient(), false);
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* f.prepare([post(1), post(2)]);
      yield* runSql("Commit public target", "UPDATE jobs SET publication_privacy='public'");
      yield* drainQueue(10);
      yield* metadataDue();
      yield* drainQueue(10);
      expect((yield* listTitles())[0]!.status).toBe("applied");
      expect((yield* listJobs())[0]!.status).toBe("uploading");
    }).pipe(Effect.provide(f.layer)),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* retryJob("maddysontg-1-0", false);
      yield* drainQueue(1);
      expect((yield* listJobs())[0]!.status).toBe("uploaded");
      expect(f.client.publications).toEqual(["maddysontg-1-0", "maddysontg-1-0"]);
      expect(f.client.starts).toHaveLength(1);
      expect(f.client.resumes).toHaveLength(1);
      expect(f.metadata.generations).toBe(1);
      expect(f.metadata.renders).toBe(1);
      expect(f.client.captionReads).toBe(1);
    }).pipe(Effect.provide(f.layer)),
  );
});

it("requires review for a manually edited staged title without publishing or replacing its thumbnail", async () => {
  const f = await fixture(new Client(), false);
  f.client.manualTitle = true;
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* f.prepare([post(1), post(2)]);
      yield* drainQueue(10);
      yield* metadataDue();
      yield* drainQueue(10);
      expect((yield* listJobs())[0]!.status).toBe("review");
      expect((yield* listTitles())[0]!.status).toBe("manual");
      expect(f.client.events).toEqual(["title:maddysontg-1-0"]);
      expect(f.metadata.renders).toBe(0);
      expect(f.client.publications).toEqual([]);
      yield* drainQueue(10);
      expect(f.client.starts).toHaveLength(1);
    }).pipe(Effect.provide(f.layer)),
  );
});

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
  const now = DateTime.formatIso(DateTime.add(Effect.runSync(DateTime.now), { minutes: -61 }));
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
      yield* metadataDue();
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
