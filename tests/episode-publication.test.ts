import { afterEach, expect, it } from "vite-plus/test";
import { Effect, Layer, Schema } from "effect";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppError, attempt, Settings } from "../src/core.ts";
import { listJobs, runSql, savePosts, Store, type Job } from "../src/database.ts";
import { fingerprint, Media } from "../src/media.ts";
import { ModelProxy } from "../src/model.ts";
import { NameChecker } from "../src/names.ts";
import { Telegram, type Post } from "../src/telegram.ts";
import { Thumbnails, type ThumbnailRecording } from "../src/thumbnail.ts";
import { Topics } from "../src/topic.ts";
import { Transcriber, TranscriptStore } from "../src/transcription.ts";
import { drainQueue } from "../src/worker.ts";
import { listTitles } from "../src/titles.ts";
import { YouTube, YouTubeClient, type EpisodeDescription } from "../src/youtube.ts";
import { episodeFakes, type EpisodeCalls } from "./episode-fakes.ts";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

const hour = 3600_000;
const now = Date.now();
const post = (id: number, hoursAgo: number, voice = true, text = ""): Post => ({
  id,
  date: new Date(now - hoursAgo * hour).toISOString().replace(/\.\d{3}Z$/, ".000Z"),
  text,
  forwarded: false,
  images: [],
  audio: voice ? ["https://cdn4.telesco.pe/audio.ogg"] : [],
  url: `https://t.me/maddysontg/${id}`,
});

class Client extends YouTubeClient {
  readonly starts: { id: string; episode?: EpisodeDescription }[] = [];
  readonly published: string[] = [];
  constructor() {
    super({
      clientId: "test",
      clientSecret: "test",
      refreshToken: "test",
      channelId: "UCtest",
      channelTitle: "Test",
    });
  }
  override async verifyChannel() {}
  override async verifyVideo() {}
  override async start(
    job: Job,
    _privacy: "private" | "public" | "unlisted",
    _signal?: AbortSignal,
    episode?: EpisodeDescription,
  ) {
    this.starts.push({ id: job.id, episode });
    return `https://www.googleapis.com/upload/youtube/v3/videos?upload_id=${job.id}`;
  }
  override async resume(session: string) {
    return `v-${new URL(session).searchParams.get("upload_id")}`;
  }
  override async updateTitle(): Promise<"applied" | "manual"> {
    return "applied";
  }
  override async setThumbnail() {
    return [];
  }
  override async publish(job: Job) {
    this.published.push(job.id);
    return true;
  }
}

async function fixture(feed: Post[]) {
  const dataDir = await mkdtemp(join(tmpdir(), "maddyvoice-episode-test-"));
  temporary.push(dataDir);
  const video = join(dataDir, "video.mp4");
  await writeFile(video, "12345678");
  await mkdir(join(dataDir, "thumbnails"));
  const info = await fingerprint(video);
  const client = new Client();
  const calls: EpisodeCalls = { transcripts: [], titles: 0, nearby: [] };
  const renders: { recordings: number[]; scene: number }[] = [];
  const singles: string[] = [];
  const thumbnails: ThumbnailRecording[] = [];
  const settings = Layer.succeed(
    Settings,
    Settings.of({
      channel: "maddysontg",
      dataDir,
      pollSeconds: 300,
      privacy: "public",
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      chromium: "chromium",
      expectedChannel: "",
    }),
  );
  const telegram = Layer.succeed(
    Telegram,
    Telegram.of({
      page: (before = Infinity) => {
        const older = feed.filter((item) => item.id < before).sort((a, b) => a.id - b.id);
        return Effect.succeed({ posts: older, before: undefined });
      },
      post: (id) => {
        const found = feed.find((item) => item.id === id);
        return found ? Effect.succeed(found) : Effect.fail(new AppError({ message: "No post" }));
      },
    }),
  );
  const media = Layer.succeed(
    Media,
    Media.of({
      render: (_post, _index, key) =>
        Effect.sync(() => {
          singles.push(key);
          return { path: video, ...info, duration: 30 };
        }),
      renderEpisode: (recordings, scene) =>
        Effect.sync(() => {
          renders.push({ recordings: recordings.map((item) => item.post.id), scene });
          return {
            path: video,
            ...info,
            duration: 30 * recordings.length,
            starts: recordings.map((_, index) => 30 * index),
          };
        }),
    }),
  );
  const layer = Layer.mergeAll(
    Store.layer,
    telegram,
    media,
    Layer.succeed(YouTube, YouTube.of({ load: () => Effect.succeed(client) })),
    Layer.succeed(
      Topics,
      Topics.of({
        enabled: true,
        summarize: () =>
          Effect.succeed({ topic: "о старой записи", thumbnailQuote: "Старая", tags: [] }),
      }),
    ),
    Layer.succeed(
      Thumbnails,
      Thumbnails.of({
        render: (_quote, recording, destination) =>
          attempt("Render fixture thumbnail", async () => {
            thumbnails.push(recording);
            await writeFile(destination, "thumbnail");
            return destination;
          }),
      }),
    ),
    episodeFakes(calls),
  ).pipe(Layer.provideMerge(settings));
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));
  return { client, calls, renders, singles, thumbnails, run };
}

it("publishes recordings after the cutover as one episode once six hours of silence follow", async () => {
  const feed = [
    post(10, 30, false, "Последний пост до перехода"),
    post(11, 12),
    post(12, 11.5, false, "Пишу про Озона"),
    post(13, 11, true),
    post(14, 10),
    post(15, 1),
  ];
  const f = await fixture(feed);
  await f.run(
    Effect.gen(function* () {
      // The live cursor stood at #10 when episodes were enabled.
      yield* savePosts([], "live", 10);
      yield* savePosts(feed.slice(1), "live", 15);
      yield* drainQueue(10);
      const jobs = yield* listJobs();
      const episode = jobs.filter((job) => job.episode_id === "maddysontg-11-0");
      expect(episode.map((job) => [job.id, job.status, job.youtube_id, job.chapter])).toEqual([
        ["maddysontg-11-0", "uploaded", "v-maddysontg-11-0", "Глава 1"],
        ["maddysontg-13-0", "uploaded", "v-maddysontg-11-0", "Глава 2"],
        ["maddysontg-14-0", "uploaded", "v-maddysontg-11-0", "Глава 3"],
      ]);
      // The newest voice may still be joined by others.
      const open = jobs.find((job) => job.id === "maddysontg-15-0")!;
      expect([open.status, open.episode_id]).toEqual(["pending", null]);
      expect((yield* listTitles()).map((item) => [item.job_id, item.title])).toEqual([
        ["maddysontg-11-0", "Мэддисон о голосовании за участников"],
      ]);
    }),
  );
  expect(f.renders).toEqual([{ recordings: [11, 13, 14], scene: 1 }]);
  expect(f.singles).toEqual([]);
  expect(f.calls.titles).toBe(1);
  expect(f.calls.transcripts).toEqual(["11-0", "13-0", "14-0"]);
  // Names in the author's posts around the episode are hinted to the recogniser.
  expect(f.calls.nearby[0]).toEqual(["Пишу про Озона"]);
  expect(f.client.starts.map((start) => start.id)).toEqual(["maddysontg-11-0"]);
  const episode = f.client.starts[0]!.episode!;
  expect(episode.title).toBe("Мэддисон о голосовании за участников");
  expect(episode.chapters).toEqual(["0:00 Глава 1", "0:30 Глава 2", "1:00 Глава 3"]);
  expect(episode.recordings.map((recording) => recording.source_url)).toEqual([
    "https://t.me/maddysontg/11",
    "https://t.me/maddysontg/13",
    "https://t.me/maddysontg/14",
  ]);
  expect(f.client.published).toEqual(["maddysontg-11-0"]);
  expect(f.thumbnails.map((item) => [item.messageId, item.scene])).toEqual([[11, 1]]);
});

it("publishes a recording from before the cutover alone and ahead of the episodes", async () => {
  const feed = [post(10, 30), post(20, 12), post(21, 11)];
  const f = await fixture(feed);
  await f.run(
    Effect.gen(function* () {
      yield* savePosts([], "live", 15);
      yield* savePosts([feed[0]!], "history");
      yield* savePosts(feed.slice(1), "live", 21);
      yield* drainQueue(10);
      // The single video waits for its captions; the episode behind it waits too.
      expect((yield* listJobs()).map((job) => [job.id, job.status, job.episode_id])).toEqual([
        ["maddysontg-10-0", "uploading", null],
        ["maddysontg-20-0", "pending", "maddysontg-20-0"],
        ["maddysontg-21-0", "pending", "maddysontg-20-0"],
      ]);
    }),
  );
  expect(f.singles).toEqual(["maddysontg-10-0"]);
  expect(f.client.starts.map((start) => [start.id, start.episode])).toEqual([
    ["maddysontg-10-0", undefined],
  ]);
  expect(f.renders).toEqual([]);
});

it("numbers consecutive episodes so they take different scenes", async () => {
  const feed = [post(20, 40), post(21, 30), post(22, 20)];
  const f = await fixture(feed);
  await f.run(
    Effect.gen(function* () {
      yield* savePosts([], "live", 15);
      yield* savePosts(feed, "live", 22);
      yield* drainQueue(10);
    }),
  );
  expect(f.renders.map((render) => [render.recordings, render.scene])).toEqual([
    [[20], 1],
    [[21], 2],
    [[22], 3],
  ]);
});

it("keeps paid transcripts and name verdicts in the worker's database", async () => {
  const feed = [post(20, 12)];
  const f = await fixture(feed);
  const proxy = Layer.succeed(
    ModelProxy,
    ModelProxy.of({ model: "test", json: () => Effect.die("No trigger words to judge") }),
  );
  await f.run(
    Effect.gen(function* () {
      yield* savePosts([], "live", 15);
      yield* savePosts(feed, "live", 20);
      const store = yield* TranscriptStore;
      yield* store.write("maddysontg-20-0", "gpt-transcribe", "Сосавот прошёл игру");
      yield* store.saveVerdicts("maddysontg-20-0", "gpt-transcribe", { "4:давка:Давг": true });
      expect(yield* store.verdicts("maddysontg-20-0", "gpt-transcribe")).toEqual({
        "4:давка:Давг": true,
      });
      // A saved transcript is read back and corrected without calling the recogniser.
      const transcript = yield* Transcriber.use((transcriber) =>
        transcriber.transcribe(feed[0]!, 0),
      ).pipe(
        Effect.provide(
          Transcriber.layer.pipe(
            Layer.provide(NameChecker.layer.pipe(Layer.provide(proxy))),
            Layer.provide(TranscriptStore.database),
          ),
        ),
      );
      expect(transcript).toBe("Сасавот прошёл игру");
      const { db } = yield* Store;
      const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ text: Schema.String })))(
        yield* attempt("Read transcripts", async () => db.query`SELECT text FROM transcripts`),
      );
      expect(rows).toEqual([{ text: "Сосавот прошёл игру" }]);
    }).pipe(Effect.provide(TranscriptStore.database)),
  );
});

it("does not publish a recording that is waiting for its episode to close", async () => {
  const feed = [post(20, 2), post(21, 1)];
  const f = await fixture(feed);
  await f.run(
    Effect.gen(function* () {
      yield* savePosts([], "live", 15);
      yield* savePosts(feed, "live", 21);
      yield* drainQueue(10);
      yield* runSql("Check nothing moved", "SELECT 1");
      expect((yield* listJobs()).map((job) => [job.status, job.episode_id])).toEqual([
        ["pending", null],
        ["pending", null],
      ]);
    }),
  );
  expect(f.renders).toEqual([]);
  expect(f.client.starts).toEqual([]);
});
