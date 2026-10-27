import { afterEach, expect, it } from "vite-plus/test";
import { Effect, Layer } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, Settings } from "../src/core.ts";
import { getCursor, listJobs, runSql, savePosts, Store, type Job } from "../src/database.ts";
import { Topics } from "../src/topic.ts";
import { drainTitles, listTitles } from "../src/titles.ts";
import { YouTube, YouTubeClient } from "../src/youtube.ts";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
const auth = {
  clientId: "test",
  clientSecret: "test",
  refreshToken: "test",
  channelId: "UCtest",
  channelTitle: "Test",
};

async function fixture(client: YouTubeClient, summarize: Topics["Service"]["summarize"]) {
  const dataDir = await mkdtemp(join(tmpdir(), "maddyvoice-titles-test-"));
  temporary.push(dataDir);
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
  return Layer.mergeAll(
    Store.layer.pipe(Layer.provideMerge(config)),
    Layer.succeed(Topics, Topics.of({ enabled: true, summarize })),
    Layer.succeed(YouTube, YouTube.of({ load: () => Effect.succeed(client) })),
  );
}

const uploaded = Effect.fn("test.uploaded")(function* (id: number) {
  yield* savePosts(
    [
      {
        id,
        date: "2026-10-26T10:20:30.000Z",
        audio: ["https://example.com/voice.ogg"],
        images: [],
        forwarded: false,
        text: "",
        url: `https://t.me/maddysontg/${id}`,
      },
    ],
    "history",
  );
  yield* runSql(
    "Test completed upload",
    "UPDATE jobs SET status='uploaded', youtube_id=? WHERE message_id=?",
    ["abcdefghijk", id],
  );
});

it("caches captions over model failures, discards text after a topic, and never changes upload state or cursor", async () => {
  let reads = 0;
  let generations = 0;
  class Client extends YouTubeClient {
    override async verifyChannel() {}
    override async captions() {
      reads++;
      return "Большой рассказ про новую компьютерную игру.";
    }
    override async updateTitle(_job: Job, title: string): Promise<"applied"> {
      expect(title).toBe("Мэддисон — Впечатления от новой компьютерной игры | 2026-10-26");
      return "applied";
    }
  }
  const layer = await fixture(new Client(auth), () =>
    ++generations === 1
      ? Effect.fail(new AppError({ message: "Temporary model failure" }))
      : Effect.succeed("Впечатления от новой компьютерной игры"),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* savePosts([], "live", 900);
      yield* uploaded(1);
      yield* drainTitles(1, true);
      expect((yield* listTitles())[0]?.transcript).toContain("Большой рассказ");
      yield* drainTitles(1, true);
      expect((yield* listTitles())[0]).toMatchObject({
        status: "applied",
        transcript: null,
        topic: "Впечатления от новой компьютерной игры",
      });
      yield* drainTitles(1, true);
      expect(reads).toBe(1);
      expect(generations).toBe(2);
      expect(yield* getCursor()).toBe(900);
      expect((yield* listJobs())[0]).toMatchObject({
        status: "uploaded",
        youtube_id: "abcdefghijk",
        attempts: 0n,
        upload_session: null,
      });
    }).pipe(Effect.provide(layer)),
  );
});

it("persists caption backoff and a daily quota cap even when --now is used", async () => {
  let reads = 0;
  class Client extends YouTubeClient {
    override async verifyChannel() {}
    override async captions() {
      reads++;
      return undefined;
    }
  }
  const layer = await fixture(new Client(auth), () => Effect.die("Model must not be called"));
  await Effect.runPromise(
    Effect.gen(function* () {
      for (let id = 1; id <= 13; id++) yield* uploaded(id);
      yield* drainTitles(20, true);
      expect(reads).toBe(12);
      expect((yield* listTitles()).every((item) => item.next_attempt > 0n)).toBe(true);
      yield* drainTitles(20);
      yield* drainTitles(20, true);
      expect(reads).toBe(12);
      expect((yield* listJobs()).every((job) => job.status === "uploaded")).toBe(true);
    }).pipe(Effect.provide(layer)),
  );
});
