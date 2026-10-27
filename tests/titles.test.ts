import { afterEach, expect, it } from "vite-plus/test";
import { DateTime, Effect, Layer } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, Settings } from "../src/core.ts";
import { getCursor, listJobs, runSql, savePosts, Store, type Job } from "../src/database.ts";
import { commentsReadyAt, Topics, type TopicSource } from "../src/topic.ts";
import { drainTitles, listTitles, regenerateTitles } from "../src/titles.ts";
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

async function fixture(
  client: YouTubeClient,
  summarize: (text: string, source: TopicSource) => Effect.Effect<string, AppError>,
) {
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
    Layer.succeed(
      Topics,
      Topics.of({
        enabled: true,
        summarize: (text, source) =>
          summarize(text, source).pipe(
            Effect.map((topic) => ({
              topic,
              thumbnailQuote: "Большой рассказ",
              tags: ["компьютерные игры", "впечатления"],
            })),
          ),
      }),
    ),
    Layer.succeed(YouTube, YouTube.of({ load: () => Effect.succeed(client) })),
  );
}

const uploaded = Effect.fn("test.uploaded")(function* (
  id: number,
  publishedAt = "2026-10-26T10:20:30.000Z",
) {
  yield* savePosts(
    [
      {
        id,
        date: publishedAt,
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

it("waits one hour from the original Telegram post even with --now and sends source identity", async () => {
  let reads = 0;
  let generations = 0;
  class Client extends YouTubeClient {
    override async verifyChannel() {}
    override async captions() {
      reads++;
      return "Большой рассказ про новую компьютерную игру.";
    }
    override async updateTitle(
      _job: Job,
      _title: string,
      _previous?: string | null,
      tags?: readonly string[],
    ): Promise<"applied"> {
      expect(tags).toEqual(["компьютерные игры", "впечатления"]);
      return "applied";
    }
  }
  const layer = await fixture(new Client(auth), (_text, source) => {
    generations++;
    expect(source.channel).toBe("maddysontg");
    expect(source.messageId).toBe("1");
    return Effect.succeed("Впечатления от новой компьютерной игры");
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const recent = DateTime.formatIso(DateTime.add(now, { minutes: -59 }));
      yield* uploaded(1, recent);
      yield* drainTitles(1, true);
      expect(reads).toBe(0);
      expect(generations).toBe(0);
      expect((yield* listTitles())[0]).toMatchObject({
        status: "pending",
        next_attempt: BigInt(commentsReadyAt(recent)),
        attempts: 0n,
      });
      yield* runSql(
        "Test elapsed comment wait",
        "UPDATE jobs SET published_at=? WHERE message_id=1",
        [DateTime.formatIso(DateTime.add(now, { minutes: -61 }))],
      );
      yield* drainTitles(1, true);
      expect(reads).toBe(1);
      expect(generations).toBe(1);
      expect((yield* listTitles())[0]?.status).toBe("applied");
    }).pipe(Effect.provide(layer)),
  );
});

it("keeps generated topic and tags across a lost YouTube update response", async () => {
  let generations = 0;
  let updates = 0;
  class Client extends YouTubeClient {
    override async verifyChannel() {}
    override async captions() {
      return "Большой рассказ про новую компьютерную игру.";
    }
    override async updateTitle(
      _job: Job,
      _title: string,
      _previous?: string | null,
      tags?: readonly string[],
    ): Promise<"applied"> {
      expect(tags).toEqual(["компьютерные игры", "впечатления"]);
      if (++updates === 1) throw new Error("Lost YouTube response");
      return "applied";
    }
  }
  const layer = await fixture(new Client(auth), () => {
    generations++;
    return Effect.succeed("Впечатления от новой компьютерной игры");
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* uploaded(1);
      yield* drainTitles(1, true);
      expect((yield* listTitles())[0]).toMatchObject({
        status: "pending",
        topic: "Впечатления от новой компьютерной игры",
        thumbnail_quote: "Большой рассказ",
        tags: ["компьютерные игры", "впечатления"],
        transcript: null,
      });
      yield* drainTitles(1, true);
      expect(generations).toBe(1);
      expect(updates).toBe(2);
      expect((yield* listTitles())[0]?.status).toBe("applied");
    }).pipe(Effect.provide(layer)),
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
      expect(title).toBe("Мэддисон впечатления от новой компьютерной игры");
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

it("reformats a current-policy topic and retains the previous title over retries", async () => {
  const oldTitle = "Впечатления от новой компьютерной игры | Мэддисон";
  const title = "Мэддисон впечатления от новой компьютерной игры";
  let updates = 0;
  class Client extends YouTubeClient {
    override async verifyChannel() {}
    override async captions(): Promise<string | undefined> {
      throw new Error("A format change must not download captions");
    }
    override async updateTitle(
      _job: Job,
      next: string,
      previous?: string | null,
    ): Promise<"applied"> {
      expect(previous).toBe(oldTitle);
      expect(next).toBe(title);
      if (++updates === 1) throw new Error("Response lost after title update");
      return "applied";
    }
  }
  const layer = await fixture(new Client(auth), () =>
    Effect.die("A saved topic must not be regenerated"),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* savePosts([], "live", 900);
      yield* uploaded(1);
      const jobs = yield* listJobs();
      yield* runSql(
        "Seed a legacy title",
        `INSERT INTO video_titles
      (job_id,video_id,status,topic,title,created_at,updated_at,generation_version) VALUES (?,?,'applied',?,?,?,?,1)`,
        [
          "maddysontg-1-0",
          "abcdefghijk",
          "Впечатления от новой компьютерной игры",
          oldTitle,
          "2026-10-26T10:20:30.000Z",
          "2026-10-26T10:20:30.000Z",
        ],
      );
      yield* drainTitles(1);
      expect((yield* listTitles())[0]).toMatchObject({
        status: "pending",
        title: oldTitle,
        attempts: 1n,
      });
      yield* drainTitles(1);
      expect(updates).toBe(1);
      yield* drainTitles(1, true);
      expect((yield* listTitles())[0]).toMatchObject({
        status: "applied",
        title,
        transcript: null,
        error: null,
      });
      yield* drainTitles(1, true);
      expect(updates).toBe(2);
      expect(yield* listJobs()).toEqual(jobs);
      expect(yield* getCursor()).toBe(900);
    }).pipe(Effect.provide(layer)),
  );
});

it("regenerates legacy topics and keeps the previous remote title after a failed update", async () => {
  let generations = 0;
  let updates = 0;
  const oldTitle = "Старое название | Мэддисон";
  class Client extends YouTubeClient {
    override async verifyChannel() {}
    override async captions() {
      return "Речь про выбор новой компьютерной игры.";
    }
    override async updateTitle(
      _job: Job,
      title: string,
      previous?: string | null,
    ): Promise<"applied"> {
      expect(previous).toBe(oldTitle);
      expect(title).toBe("Мэддисон выбирает новую игру");
      if (++updates === 1) throw new Error("Failure before remote update");
      return "applied";
    }
  }
  const layer = await fixture(new Client(auth), () => {
    generations++;
    return Effect.succeed("выбирает новую игру");
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* uploaded(1);
      yield* drainTitles(0, true);
      yield* runSql(
        "Seed legacy title policy",
        "UPDATE video_titles SET status='applied',topic='Старый пересказ',title=?,generation_version=0",
        [oldTitle],
      );
      updates = 0;
      yield* drainTitles(1, true);
      expect((yield* listTitles())[0]).toMatchObject({
        status: "pending",
        title: oldTitle,
        topic: "выбирает новую игру",
        generation_version: 1n,
      });
      yield* drainTitles(1, true);
      expect(generations).toBe(1);
      expect((yield* listTitles())[0]?.status).toBe("applied");
      yield* regenerateTitles();
      expect((yield* listTitles())[0]).toMatchObject({ status: "pending", generation_version: 0n });
    }).pipe(Effect.provide(layer)),
  );
});
