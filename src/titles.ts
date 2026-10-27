import { DateTime, Effect, Schema } from "effect";
import { attempt, Settings } from "./core.ts";
import { listJobs, runSql, Store, type Job } from "./database.ts";
import { Topics, topicTitle } from "./topic.ts";
import { YouTube } from "./youtube.ts";

const TitleJob = Schema.Struct({
  job_id: Schema.String,
  video_id: Schema.String,
  status: Schema.Literals(["pending", "applied", "manual", "review"]),
  transcript: Schema.NullOr(Schema.String),
  topic: Schema.NullOr(Schema.String),
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

const processTitle = Effect.fn("processTitle")(function* (item: TitleJob, job: Job) {
  const client = yield* (yield* YouTube).load();
  const topics = yield* Topics;
  const now = yield* DateTime.now;
  const iso = DateTime.formatIso(now);
  if (item.video_id !== job.youtube_id) {
    yield* runSql(
      "Pause mismatched title job",
      "UPDATE video_titles SET status='review', error=? WHERE job_id=?",
      ["Uploaded video ID changed; reconcile the title job", job.id],
    );
    return;
  }
  let topic = item.topic;
  const text = topic ? undefined : yield* readTranscript(item, job, now);
  if (!topic && !text) return;
  if (!topic) {
    topic = yield* topics.summarize(text ?? "");
    const title = topicTitle(topic, job.published_at);
    // Keep the topic before a remote mutation. A lost update response is reconciled by reading the title.
    yield* runSql(
      "Save topic and discard transcript",
      `UPDATE video_titles SET topic=?, title=?,
      transcript=NULL, updated_at=? WHERE job_id=?`,
      [topic, title, iso, job.id],
    );
  }
  const title = topicTitle(topic, job.published_at);
  const outcome = yield* attempt("Apply topic to YouTube title", (signal) =>
    client.updateTitle(job, title, signal),
  );
  yield* runSql(
    "Save title result",
    "UPDATE video_titles SET status=?, title=?, error=NULL, updated_at=? WHERE job_id=?",
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
