import { DateTime, Effect, Schema } from "effect";
import { attempt, Settings } from "./core.ts";
import { listJobs, runSql, Store, type Job } from "./database.ts";
import { commentsReadyAt, titleGenerationVersion, Topics, topicTitle } from "./topic.ts";
import { YouTube } from "./youtube.ts";

const TitleJob = Schema.Struct({
  job_id: Schema.String,
  video_id: Schema.String,
  status: Schema.Literals(["pending", "applied", "manual", "review"]),
  transcript: Schema.NullOr(Schema.String),
  topic: Schema.NullOr(Schema.String),
  generation_version: Schema.BigInt,
  title: Schema.NullOr(Schema.String),
  attempts: Schema.BigInt,
  next_attempt: Schema.BigInt,
  error: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
});
type TitleJob = typeof TitleJob.Type;

export const listTitles = Effect.fn("listTitles")(function* () {
  const { db } = yield* Store;
  const { channel } = yield* Settings;
  return yield* attempt("Read video title queue", async () =>
    Schema.decodeUnknownSync(Schema.Array(TitleJob))(
      await db.query`SELECT video_titles.* FROM video_titles JOIN jobs ON jobs.id=video_titles.job_id
    WHERE jobs.channel=${channel} ORDER BY jobs.published_at`,
    ),
  );
});

const queueTitles = Effect.fn("queueTitles")(function* (now: DateTime.Utc) {
  const { channel } = yield* Settings;
  const iso = DateTime.formatIso(now);
  yield* runSql(
    "Queue titles for uploaded videos",
    `INSERT INTO video_titles
    (job_id, video_id, created_at, updated_at, next_attempt)
    SELECT id, youtube_id, ?, ?, ? FROM jobs WHERE status='uploaded' AND youtube_id IS NOT NULL
      AND channel=? ON CONFLICT DO NOTHING`,
    [iso, iso, DateTime.toEpochMillis(now) + 15 * 60_000, channel],
  );
  for (const item of yield* listTitles()) {
    if (item.status !== "applied" || !item.topic) continue;
    if (
      item.generation_version === BigInt(titleGenerationVersion) &&
      item.title === topicTitle(item.topic)
    )
      continue;
    // Retain the previous title for remote reconciliation, including after a lost response.
    yield* runSql(
      "Queue title format update",
      "UPDATE video_titles SET status='pending', next_attempt=0, error=NULL, updated_at=? WHERE job_id=? AND status='applied'",
      [iso, item.job_id],
    );
  }
});

export const regenerateTitles = Effect.fn("regenerateTitles")(function* () {
  yield* queueTitles(yield* DateTime.now);
  yield* runSql(
    "Queue title regeneration without discarding remote reconciliation state",
    `UPDATE video_titles SET status='pending',generation_version=0,next_attempt=0,error=NULL
      WHERE status IN ('pending','applied') AND job_id IN (SELECT id FROM jobs WHERE status='uploaded' AND channel=?)`,
    [(yield* Settings).channel],
  );
});

const reserveCaptionCheck = Effect.fn("reserveCaptionCheck")(function* (day: string) {
  const { db } = yield* Store;
  // Reserve the worst case of 50 (list) + 200 (download) before any caption request.
  // Twelve checks cap caption usage at 3000 units per UTC day, including failures.
  return yield* attempt("Reserve YouTube caption quota", async () => {
    const result = await db.query`INSERT INTO title_caption_budget(day, checks) VALUES(${day}, 1)
      ON CONFLICT(day) DO UPDATE SET checks=checks+1 WHERE checks<12`.run();
    return result.changes === 1n;
  });
});

const readTranscript = Effect.fn("readTranscript")(function* (
  item: TitleJob,
  job: Job,
  now: DateTime.Utc,
) {
  if (item.transcript) return item.transcript;
  const client = yield* (yield* YouTube).load();
  const iso = DateTime.formatIso(now);
  if (!(yield* reserveCaptionCheck(iso.slice(0, 10)))) {
    const tomorrow = DateTime.startOf(DateTime.add(now, { days: 1 }), "day");
    yield* runSql(
      "Wait for next caption quota day",
      "UPDATE video_titles SET next_attempt=?, error=? WHERE job_id=?",
      [
        DateTime.toEpochMillis(tomorrow),
        "Daily caption budget reached; waiting until tomorrow UTC",
        job.id,
      ],
    );
    return;
  }
  const text = yield* attempt("Read YouTube speech captions", (signal) =>
    client.captions(job, signal),
  );
  if (!text) {
    const minutes = [15, 30, 60, 120, 360, 720, 1440][Math.min(Number(item.attempts), 6)] ?? 1440;
    yield* runSql(
      "Wait for automatic captions",
      `UPDATE video_titles SET attempts=attempts+1,
        next_attempt=?, error=?, updated_at=? WHERE job_id=?`,
      [
        DateTime.toEpochMillis(now) + minutes * 60_000,
        "Russian YouTube captions are not ready",
        iso,
        job.id,
      ],
    );
    return;
  }
  yield* runSql(
    "Cache captions before topic generation",
    "UPDATE video_titles SET transcript=?, updated_at=? WHERE job_id=?",
    [text, iso, job.id],
  );
  return text;
});

const waitForComments = Effect.fn("waitForComments")(function* (
  item: TitleJob,
  job: Job,
  now: DateTime.Utc,
) {
  if (item.topic && item.generation_version === BigInt(titleGenerationVersion)) return false;
  const readyAt = commentsReadyAt(job.published_at);
  if (DateTime.toEpochMillis(now) >= readyAt) return false;
  yield* runSql(
    "Wait for Telegram comments to accumulate",
    "UPDATE video_titles SET next_attempt=?, error=?, updated_at=? WHERE job_id=?",
    [
      readyAt,
      "Waiting one hour after Telegram publication for comments",
      DateTime.formatIso(now),
      job.id,
    ],
  );
  return true;
});

const currentTopic = Effect.fn("currentTopic")(function* (
  item: TitleJob,
  job: Job,
  now: DateTime.Utc,
) {
  if (item.generation_version === BigInt(titleGenerationVersion) && item.topic) return item.topic;
  const text = yield* readTranscript(item, job, now);
  if (!text) return;
  const topics = yield* Topics;
  const topic = yield* topics.summarize(text, {
    channel: job.channel,
    messageId: job.message_id.toString(),
    publishedAt: job.published_at,
  });
  // Retain the previous remote title until the write is confirmed.
  yield* runSql(
    "Save topic and discard transcript",
    `UPDATE video_titles SET topic=?, generation_version=?,
      transcript=NULL, updated_at=? WHERE job_id=?`,
    [topic, titleGenerationVersion, DateTime.formatIso(now), job.id],
  );
  return topic;
});

const processTitle = Effect.fn("processTitle")(function* (item: TitleJob, job: Job) {
  const client = yield* (yield* YouTube).load();
  const now = yield* DateTime.now;
  if (item.video_id !== job.youtube_id) {
    yield* runSql(
      "Pause mismatched title job",
      "UPDATE video_titles SET status='review', error=? WHERE job_id=?",
      ["Uploaded video ID changed; reconcile the title job", job.id],
    );
    return;
  }
  if (yield* waitForComments(item, job, now)) return;
  const topic = yield* currentTopic(item, job, now);
  if (!topic) return;
  const title = topicTitle(topic);
  const outcome = yield* attempt("Apply topic to YouTube title", (signal) =>
    client.updateTitle(job, title, item.title, signal),
  );
  yield* runSql(
    "Save title result",
    "UPDATE video_titles SET status=?, title=?, next_attempt=0, error=NULL, updated_at=? WHERE job_id=?",
    [outcome, title, DateTime.formatIso(yield* DateTime.now), job.id],
  );
  yield* Effect.logInfo(
    outcome === "applied"
      ? `Updated title for ${job.id}: ${title}`
      : `Preserved manually edited YouTube title for ${job.id}`,
  );
});

export const drainTitles = Effect.fn("drainTitles")(function* (limit: number, nowFlag = false) {
  if (!(yield* Topics).enabled) return;
  const now = yield* DateTime.now;
  yield* queueTitles(now);
  const jobs = yield* listJobs();
  const pending = (yield* listTitles())
    .filter(
      (item) =>
        item.status === "pending" &&
        (nowFlag || item.next_attempt <= BigInt(DateTime.toEpochMillis(now))),
    )
    .slice(0, limit);
  if (pending.length === 0) return;
  const client = yield* (yield* YouTube).load();
  yield* attempt("Verify title destination channel", (signal) => client.verifyChannel(signal));
  for (const item of pending) {
    const job = jobs.find((job) => job.id === item.job_id && job.status === "uploaded");
    if (!job) continue;
    yield* processTitle(item, job).pipe(
      Effect.catch(
        Effect.fn(function* (error) {
          const failedAt = yield* DateTime.now;
          const delay = Math.min(
            24 * 3600_000,
            15 * 60_000 * 2 ** Math.min(Number(item.attempts), 7),
          );
          yield* runSql(
            "Save title error",
            `UPDATE video_titles SET attempts=attempts+1, next_attempt=?,
        error=?, updated_at=? WHERE job_id=?`,
            [
              DateTime.toEpochMillis(failedAt) + delay,
              error.message,
              DateTime.formatIso(failedAt),
              job.id,
            ],
          );
          yield* Effect.logWarning(`Title ${job.id}: ${error.message}; retry scheduled`);
        }),
      ),
    );
  }
});
