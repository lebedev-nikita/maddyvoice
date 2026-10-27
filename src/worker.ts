import { DateTime, Effect, Option } from "effect";
import { AppError, attempt, json, safeMessage, Settings } from "./core.ts";
import { getCursor, listJobs, runSql, savePosts, type Job } from "./database.ts";
import { fingerprint, Media } from "./media.ts";
import { Telegram, type Post } from "./telegram.ts";
import { UploadReview, YouTube } from "./youtube.ts";

export const poll = Effect.fn("poll")(function* () {
  const telegram = yield* Telegram;
  const cursor = yield* getCursor();
  let page = yield* telegram.page();
  const newest = Math.max(...page.posts.map((post) => post.id));
  if (cursor === undefined) {
    yield* savePosts([], "live", newest);
    yield* Effect.logInfo(
      `Live polling initialized at #${newest}; use history to import older recordings`,
    );
    return;
  }
  const posts: Post[] = [];
  for (let count = 0; ; count++) {
    posts.push(...page.posts.filter((post) => post.id > cursor));
    if (page.posts.some((post) => post.id <= cursor) || page.before === undefined) break;
    if (count >= 1999)
      return yield* new AppError({
        message: "Live catch-up exceeded 2000 pages; cursor was preserved",
      });
    const previous = page.before;
    yield* Effect.sleep("300 millis");
    page = yield* telegram.page(previous);
    if (page.before !== undefined && page.before >= previous)
      return yield* new AppError({
        message: "Telegram pagination did not advance; cursor was preserved",
      });
  }
  const inserted = yield* savePosts(posts, "live", Math.max(newest, cursor));
  yield* Effect.logInfo(`Checked Telegram: ${inserted} new recording(s)`);
});

export function dateRange(
  since: string | undefined,
  until: string | undefined,
  months: number,
  now: DateTime.Utc,
) {
  if (!Number.isInteger(months) || months < 1 || months > 120)
    throw new Error("--months must be an integer from 1 to 120");
  const parseDay = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Use YYYY-MM-DD dates (UTC)");
    const parsed = Option.getOrUndefined(DateTime.make(`${value}T00:00:00Z`));
    if (!parsed || DateTime.formatIso(parsed).slice(0, 10) !== value)
      throw new Error("Invalid calendar date");
    return parsed;
  };
  const from = since ? parseDay(since) : DateTime.subtract(now, { months });
  const to = until ? DateTime.add(parseDay(until), { days: 1 }) : now;
  if (DateTime.toEpochMillis(from) >= DateTime.toEpochMillis(to))
    throw new Error("--since must be before --until");
  return { from: DateTime.formatIso(from), to: DateTime.formatIso(to) };
}

export const importHistory = Effect.fn("importHistory")(function* (
  since: string | undefined,
  until: string | undefined,
  months: number,
) {
  const telegram = yield* Telegram;
  const now = yield* DateTime.now;
  const range = yield* attempt("Validate history interval", async () =>
    dateRange(since, until, months, now),
  );
  yield* Effect.logInfo(`Importing [${range.from}, ${range.to})`);
  let before: number | undefined;
  let total = 0;
  for (let count = 0; count < 2000; count++) {
    const page = yield* telegram.page(before);
    const eligible = page.posts.filter((post) => post.date >= range.from && post.date < range.to);
    total += yield* savePosts(eligible, "history");
    if (page.posts.some((post) => post.date < range.from) || page.before === undefined) {
      yield* Effect.logInfo(`History imported: ${total} new recording(s); live cursor unchanged`);
      return total;
    }
    if (before !== undefined && page.before >= before)
      return yield* new AppError({ message: "Telegram history pagination did not advance" });
    before = page.before;
    yield* Effect.sleep("300 millis");
  }
  return yield* new AppError({
    message:
      "History exceeded 2000 pages; rerun with a narrower date interval. Already queued jobs are preserved.",
  });
});

const markUploaded = (id: string, videoId: string, now: string) =>
  runSql(
    "Save YouTube video ID",
    "UPDATE jobs SET status='uploaded', youtube_id=?, upload_session=NULL, error=NULL, updated_at=? WHERE id=?",
    [videoId, now, id],
  );

const ensureRendered = Effect.fn("ensureRendered")(function* (job: Job, now: string) {
  if (job.video_path) return job;
  const telegram = yield* Telegram;
  const media = yield* Media;
  const post = yield* telegram.post(Number(job.message_id));
  if (post.forwarded)
    return yield* new AppError({
      message: "Recording is now marked as forwarded; refusing to publish it as an original",
    });
  const rendered = yield* media.render(post, Number(job.audio_index), job.id);
  yield* runSql(
    "Save rendered video",
    "UPDATE jobs SET status='ready', video_path=?, video_sha256=?, video_size=?, updated_at=? WHERE id=?",
    [rendered.path, rendered.sha256, rendered.size, now, job.id],
  );
  return {
    ...job,
    status: "ready" as const,
    video_path: rendered.path,
    video_sha256: rendered.sha256,
    video_size: BigInt(rendered.size),
  };
});

const verifyRendered = Effect.fn("verifyRendered")(function* (job: Job) {
  const videoPath = job.video_path;
  if (!videoPath || job.video_size === null)
    return yield* new AppError({ message: "Job has no rendered video" });
  const info = yield* attempt("Check rendered video integrity", () => fingerprint(videoPath));
  if (info.sha256 !== job.video_sha256 || BigInt(info.size) !== job.video_size) {
    yield* runSql("Pause changed video", "UPDATE jobs SET status='review', error=? WHERE id=?", [
      "Rendered video changed; inspect it before resuming",
      job.id,
    ]);
    return yield* new AppError({ message: "Rendered video changed; job requires review" });
  }
  return { videoPath, size: info.size };
});

export const processJob = Effect.fn("processJob")(function* (
  initial: Job,
  privacy?: "private" | "public" | "unlisted",
) {
  const config = yield* Settings;
  const client = yield* (yield* YouTube).load();
  const now = DateTime.formatIso(yield* DateTime.now);
  if (privacy === "private" && initial.upload_session && initial.upload_privacy !== "private") {
    return yield* new AppError({
      message:
        "This session was started with non-private visibility. Resume without --test or review it in YouTube Studio.",
    });
  }
  yield* runSql(
    "Count upload attempt",
    "UPDATE jobs SET attempts=attempts+1, error=NULL, updated_at=? WHERE id=?",
    [now, initial.id],
  );
  const job = yield* ensureRendered(initial, now);
  const { videoPath, size } = yield* verifyRendered(job);
  let session = job.upload_session;
  if (!session) {
    session = yield* attempt("Start resumable YouTube upload", (signal) =>
      client.start(job, privacy ?? config.privacy, signal),
    );
    // This commit must precede every request that sends video bytes.
    yield* runSql(
      "Persist upload session",
      "UPDATE jobs SET status='uploading', upload_session=?, upload_privacy=?, updated_at=? WHERE id=?",
      [session, privacy ?? config.privacy, now, job.id],
    );
  }
  const sessionUrl = session;
  const outcome = yield* Effect.tryPromise({
    try: (signal) => client.resume(sessionUrl, videoPath, size, signal),
    catch: (cause) => cause,
  }).pipe(Effect.result);
  if (outcome._tag === "Failure") {
    if (outcome.failure instanceof UploadReview) {
      yield* runSql(
        "Pause uncertain upload",
        "UPDATE jobs SET status='review', error=? WHERE id=?",
        [outcome.failure.message, job.id],
      );
    }
    return yield* new AppError({
      message: safeMessage(outcome.failure),
    });
  }
  yield* markUploaded(job.id, outcome.success, now);
  yield* Effect.logInfo(`Uploaded ${job.id}: https://youtu.be/${outcome.success}`);
});

export const drainQueue = Effect.fn("drainQueue")(function* (limit: number, testMode = false) {
  const youtube = yield* YouTube;
  const client = yield* youtube.load();
  yield* attempt("Verify destination YouTube channel", (signal) => client.verifyChannel(signal));
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const eligible = (yield* listJobs())
    .filter(
      (job) =>
        job.status !== "uploaded" && job.status !== "review" && job.next_attempt <= BigInt(now),
    )
    .slice(0, limit);
  for (const job of eligible) {
    yield* processJob(job, testMode ? "private" : undefined).pipe(
      Effect.catch(
        Effect.fn(function* (error: AppError) {
          const delay = Math.min(24 * 3600_000, 60_000 * 2 ** Math.min(Number(job.attempts), 10));
          yield* runSql("Save upload error", "UPDATE jobs SET error=?, next_attempt=? WHERE id=?", [
            error.message,
            now + delay,
            job.id,
          ]);
          yield* Effect.logError(`${job.id}: ${error.message}; retry scheduled`);
        }),
      ),
    );
  }
});

export const previewPost = Effect.fn("previewPost")(function* (messageId: number) {
  const telegram = yield* Telegram;
  const media = yield* Media;
  const post = yield* telegram.post(messageId);
  const result = yield* media.render(post, 0, `preview-${messageId}`);
  console.log(
    json({
      ...result,
      source: post.url,
      publishedAt: post.date,
      attachedImages: post.images.length,
    }),
  );
});

export const resolveJob = Effect.fn("resolveJob")(function* (key: string, videoId: string) {
  const job = (yield* listJobs()).find((item) => item.id === key);
  if (!job) return yield* new AppError({ message: "Job not found" });
  const client = yield* (yield* YouTube).load();
  yield* attempt("Verify existing YouTube video", (signal) =>
    client.verifyVideo(job, videoId, signal),
  );
  yield* markUploaded(key, videoId, DateTime.formatIso(yield* DateTime.now));
});

export const retryJob = Effect.fn("retryJob")(function* (key: string, allowNew: boolean) {
  const job = (yield* listJobs()).find((item) => item.id === key);
  if (!job) return yield* new AppError({ message: "Job not found" });
  if (job.status === "uploaded") return yield* new AppError({ message: "Job is already uploaded" });
  if (job.status === "review" && !allowNew) {
    return yield* new AppError({
      message:
        "Inspect YouTube Studio first. Use resolve if uploaded; otherwise pass --allow-new-upload to explicitly authorize a new upload.",
    });
  }
  if (allowNew) {
    yield* runSql(
      "Authorize new upload",
      "UPDATE jobs SET status='pending', next_attempt=0, error=NULL, upload_session=NULL, upload_privacy=NULL, video_path=NULL, video_sha256=NULL, video_size=NULL WHERE id=?",
      [key],
    );
    return;
  }
  yield* runSql("Retry job", "UPDATE jobs SET next_attempt=0, error=NULL WHERE id=?", [key]);
});
