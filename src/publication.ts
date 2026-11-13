import { DateTime, Effect } from "effect";
import { AppError, attempt, safeMessage, Settings } from "./core.ts";
import { listJobs, runSql, Store, type Job } from "./database.ts";
import { episodeCutover, episodeHead, episodeMember, inEpisodes } from "./episode-queue.ts";
import { UploadReview, YouTube } from "./youtube.ts";
import { preparePublicationMetadata } from "./titles.ts";

const pause = (job: Job, message: string) =>
  runSql("Pause unsafe publication", "UPDATE jobs SET status='review', error=? WHERE id=?", [
    message,
    job.id,
  ]);

/**
 * The earliest unfinished publication: a single recording, or an episode under its first
 * recording. The rest of an episode's recordings are published with it.
 */
export const nextPublication = Effect.fn("nextPublication")(function* () {
  const jobs = (yield* listJobs()).filter((job) => !episodeMember(job));
  const legacy = jobs.find(
    (job) =>
      job.status !== "uploaded" &&
      ((job.upload_session && job.upload_privacy !== "private") ||
        (job.youtube_id && job.publication_privacy === null)),
  );
  if (legacy) {
    const error =
      "Legacy upload may already be visible; reconcile it before publishing any more videos";
    yield* pause(legacy, error);
    return { ...legacy, status: "review" as const, error };
  }
  const head = jobs.find((job) => job.status !== "uploaded");
  if (!head) return undefined;
  // A recording waits until six hours of silence close its episode.
  if (head.episode_id === null && inEpisodes(head, yield* episodeCutover())) return undefined;
  const frontier = jobs.findLast(
    (job) => job.status === "uploaded" || (job.youtube_id && job.publication_privacy !== "private"),
  );
  if (
    !head.catchup_batch &&
    frontier &&
    (head.message_id < frontier.message_id ||
      (head.message_id === frontier.message_id && head.audio_index < frontier.audio_index))
  ) {
    const error = `A later Telegram recording (${frontier.id}) is published or potentially visible; chronological rebuild is required`;
    yield* pause(head, error);
    return { ...head, status: "review" as const, error };
  }
  return head;
});

export const completePublication = Effect.fn("completePublication")(function* (initial: Job) {
  const job = yield* assertPublicationHead(initial.id);
  const { privacy: configured } = yield* Settings;
  const privacy = job.publication_privacy ?? configured;
  if (!(yield* preparePublicationMetadata(job))) return false;
  const client = yield* (yield* YouTube).load();
  const result = yield* Effect.tryPromise({
    try: (signal) => client.publish(job, privacy, signal),
    catch: (cause) => cause,
  }).pipe(Effect.result);
  if (result._tag === "Failure") {
    if (result.failure instanceof UploadReview) yield* pause(job, result.failure.message);
    return yield* new AppError({ message: safeMessage(result.failure) });
  }
  if (!result.success) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    yield* runSql(
      "Wait for YouTube processing",
      "UPDATE jobs SET next_attempt=?, error=NULL WHERE id=?",
      [now + 60_000, job.id],
    );
    yield* Effect.logInfo(
      `${job.id}: waiting for YouTube processing; later recordings remain blocked`,
    );
    return false;
  }
  // Complete this barrier before committing the row, including when recovering a lost response.
  // It prevents consecutive public releases from sharing YouTube's second-resolution timestamp.
  if (privacy !== "private") yield* Effect.sleep("2 seconds");
  const { db } = yield* Store;
  const iso = DateTime.formatIso(yield* DateTime.now);
  yield* attempt("Confirm ordered publication", async () => {
    await using tx = await db.begin();
    await tx.query`UPDATE jobs SET status='uploaded', upload_session=NULL,
      error=NULL, next_attempt=0, updated_at=${iso} WHERE id=${job.id}`.run();
    // An episode's other recordings are published in the same video.
    if (episodeHead(job))
      await tx.query`UPDATE jobs SET status='uploaded', youtube_id=${job.youtube_id},
        publication_privacy=${privacy}, error=NULL, next_attempt=0, updated_at=${iso}
        WHERE episode_id=${job.id} AND id!=${job.id}`.run();
    await tx.commit();
  });
  yield* Effect.logInfo(`Published ${job.id}: https://youtu.be/${job.youtube_id}`);
  return true;
});

export const assertPublicationHead = Effect.fn("assertPublicationHead")(function* (id: string) {
  const head = yield* nextPublication();
  if (!head || head.id !== id)
    return yield* new AppError({
      message: "Only the earliest unfinished recording may be published",
    });
  if (head.status === "review")
    return yield* new AppError({ message: head.error ?? "The earliest recording requires review" });
  return head;
});

export const resumePublication = Effect.fn("resumePublication")(function* (
  job: Job,
  videoId: string,
) {
  const client = yield* (yield* YouTube).load();
  yield* attempt("Verify existing YouTube video", (signal) =>
    client.verifyVideo(job, videoId, signal),
  );
  const { privacy } = yield* Settings;
  const target = job.publication_privacy ?? job.upload_privacy ?? privacy;
  yield* runSql(
    "Adopt existing upload for publication",
    `UPDATE jobs SET status='uploading', youtube_id=?,
    upload_session=NULL, publication_privacy=?, next_attempt=0, error=NULL WHERE id=?`,
    [videoId, target, job.id],
  );
  const head = yield* assertPublicationHead(job.id);
  return yield* completePublication(head);
});
