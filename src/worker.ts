import { DateTime, Effect, Option } from "effect";
import { AppError, attempt, json, safeMessage, Settings } from "./core.ts";
import { getCursor, listJobs, runSql, savePosts, type Job } from "./database.ts";
import { fingerprint, Media } from "./media.ts";
import { Telegram, type Post } from "./telegram.ts";
import {
  assertPublicationHead,
  completePublication,
  nextPublication,
  resumePublication,
} from "./publication.ts";
import { UploadReview, YouTube } from "./youtube.ts";
import {
  episodeDescription,
  episodeHead,
  episodeMember,
  episodeMetadata,
  formEpisodes,
  renderEpisodeVideo,
} from "./episode-queue.ts";
import { topicTitle } from "./topic.ts";
import { randomUUID } from "node:crypto";

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
  const now = yield* DateTime.now;
  const range = yield* attempt("Validate history interval", async () =>
    dateRange(since, until, months, now),
  );
  return yield* scanHistory(range);
});

export const importCatchup = Effect.fn("importCatchup")(function* (
  days: number,
  allowOutOfOrder: boolean,
) {
  if (!allowOutOfOrder || !Number.isInteger(days) || days < 1 || days > 31)
    return yield* new AppError({
      message: "Catch-up requires --allow-out-of-order and --days from 1 to 31",
    });
  const now = yield* DateTime.now;
  const range = {
    from: DateTime.formatIso(DateTime.add(now, { days: -days })),
    to: DateTime.formatIso(now),
  };
  return yield* scanHistory(range, randomUUID());
});

const scanHistory = Effect.fn("scanHistory")(function* (
  range: { from: string; to: string },
  catchupId?: string,
) {
  const telegram = yield* Telegram;
  yield* Effect.logInfo(`Importing [${range.from}, ${range.to})`);
  let before: number | undefined;
  const posts: Post[] = [];
  for (let count = 0; count < 2000; count++) {
    const page = yield* telegram.page(before);
    posts.push(...page.posts.filter((post) => post.date >= range.from && post.date < range.to));
    if (page.posts.some((post) => post.date < range.from) || page.before === undefined) {
      const total = yield* savePosts(
        posts,
        "history",
        undefined,
        catchupId ? { id: catchupId, ...range } : undefined,
      );
      yield* Effect.logInfo(`History imported: ${total} new recording(s); live cursor unchanged`);
      return total;
    }
    if (before !== undefined && page.before >= before)
      return yield* new AppError({ message: "Telegram history pagination did not advance" });
    before = page.before;
    yield* Effect.sleep("300 millis");
  }
  return yield* new AppError({
    message: "History exceeded 2000 pages; use a narrower interval. No partial import was queued.",
  });
});

const ensureRendered = Effect.fn("ensureRendered")(function* (job: Job, now: string) {
  if (job.video_path) return job;
  if (episodeHead(job)) {
    const rendered = yield* renderEpisodeVideo(job);
    return {
      ...job,
      status: "ready" as const,
      video_path: rendered.path,
      video_sha256: rendered.sha256,
      video_size: BigInt(rendered.size),
    };
  }
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
  const current = yield* assertPublicationHead(initial.id);
  const config = yield* Settings;
  const target = current.publication_privacy ?? current.upload_privacy ?? privacy ?? config.privacy;
  if (privacy === "private" && target !== "private")
    return yield* new AppError({
      message: "This job was committed for non-private publication; resume without --test",
    });
  if (current.youtube_id) return yield* completePublication(current);
  const client = yield* (yield* YouTube).load();
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* runSql(
    "Count upload attempt",
    "UPDATE jobs SET attempts=attempts+1, publication_privacy=?, error=NULL, updated_at=? WHERE id=?",
    [target, now, current.id],
  );
  const job = { ...(yield* ensureRendered(current, now)), publication_privacy: target };
  const { videoPath, size } = yield* verifyRendered(job);
  let session = job.upload_session;
  if (!session) {
    // An episode is uploaded with its final title, chapters and sources.
    const episode = episodeHead(job) ? yield* episodeMetadata(job) : undefined;
    const description =
      episode && episodeDescription(topicTitle(episode.topic), episode.members, episode.duration);
    session = yield* attempt("Start resumable YouTube upload", (signal) =>
      client.start(job, "private", signal, description),
    );
    // This commit must precede every request that sends video bytes.
    yield* runSql(
      "Persist upload session",
      "UPDATE jobs SET status='uploading', upload_session=?, upload_privacy=?, updated_at=? WHERE id=?",
      [session, "private", now, job.id],
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
  yield* runSql(
    "Persist accepted private upload",
    `UPDATE jobs SET status='uploading', youtube_id=?,
    upload_session=NULL, updated_at=? WHERE id=?`,
    [outcome.success, DateTime.formatIso(yield* DateTime.now), job.id],
  );
  return yield* completePublication({ ...job, youtube_id: outcome.success, upload_session: null });
});

export const drainQueue = Effect.fn("drainQueue")(function* (limit: number, testMode = false) {
  const youtube = yield* YouTube;
  const client = yield* youtube.load();
  yield* attempt("Verify destination YouTube channel", (signal) => client.verifyChannel(signal));
  yield* formEpisodes(yield* DateTime.now);
  for (let completed = 0; completed < limit; completed++) {
    const job = yield* nextPublication();
    if (!job) return;
    if (job.status === "review") {
      yield* Effect.logWarning(`${job.id}: publication queue blocked for review`);
      return;
    }
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (job.next_attempt > BigInt(now)) return;
    const result = yield* processJob(job, testMode ? "private" : undefined).pipe(Effect.result);
    if (result._tag === "Success") {
      if (!result.success) return;
      continue;
    }
    const failedAt = DateTime.toEpochMillis(yield* DateTime.now);
    const delay = Math.min(24 * 3600_000, 60_000 * 2 ** Math.min(Number(job.attempts), 10));
    yield* runSql("Save upload error", "UPDATE jobs SET error=?, next_attempt=? WHERE id=?", [
      result.failure.message,
      failedAt + delay,
      job.id,
    ]);
    yield* Effect.logError(`${job.id}: ${result.failure.message}; later recordings remain blocked`);
    return;
  }
});

export const scanAndPublish = Effect.fn("scanAndPublish")(function* (
  limit: number,
  testMode = false,
) {
  yield* poll();
  yield* drainQueue(limit, testMode);
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

/** A recording an operator may act on: a single one or an episode's first. */
const operableJob = Effect.fn("operableJob")(function* (jobs: readonly Job[], key: string) {
  const job = jobs.find((item) => item.id === key);
  if (!job) return yield* new AppError({ message: "Job not found" });
  if (episodeMember(job))
    return yield* new AppError({
      message: `Act on the episode's first recording, ${job.episode_id}`,
    });
  return job;
});

export const resolveJob = Effect.fn("resolveJob")(function* (key: string, videoId: string) {
  const jobs = yield* listJobs();
  const job = yield* operableJob(jobs, key);
  if (job.status === "uploaded")
    return yield* new AppError({ message: "Job is already published" });
  const head = jobs.find((item) => item.status !== "uploaded" && !episodeMember(item));
  if (head?.id !== job.id)
    return yield* new AppError({ message: "Reconcile the earliest unfinished recording first" });
  return yield* resumePublication(job, videoId);
});

export const retryJob = Effect.fn("retryJob")(function* (key: string, allowNew: boolean) {
  const job = yield* operableJob(yield* listJobs(), key);
  if (job.status === "uploaded") return yield* new AppError({ message: "Job is already uploaded" });
  if (job.status === "review" && !allowNew) {
    return yield* new AppError({
      message:
        "Inspect YouTube Studio first. Use resolve if uploaded; otherwise pass --allow-new-upload to explicitly authorize a new upload.",
    });
  }
  if (allowNew && job.youtube_id)
    return yield* new AppError({
      message:
        "A YouTube video ID is already recorded; inspect and resolve that video instead of creating a duplicate",
    });
  if (allowNew) {
    yield* runSql(
      "Authorize new upload",
      "UPDATE jobs SET status='pending', next_attempt=0, error=NULL, upload_session=NULL, upload_privacy=NULL, publication_privacy=NULL, video_path=NULL, video_sha256=NULL, video_size=NULL WHERE id=?",
      [key],
    );
    return;
  }
  yield* runSql("Retry job", "UPDATE jobs SET next_attempt=0, error=NULL WHERE id=?", [key]);
  // A staged upload can be waiting on its title's own backoff; retry that too.
  yield* runSql(
    "Retry pending metadata",
    "UPDATE video_titles SET next_attempt=0, error=NULL WHERE job_id=? AND status='pending'",
    [key],
  );
});
