import { DateTime, Effect, Schema } from "effect";
import { AppError, attempt, Settings } from "./core.ts";
import { listJobs, Store, type Job } from "./database.ts";
import { episodeGapMs } from "./episode.ts";
import { episodeAround } from "./episode-preview.ts";
import { chapterLines, EpisodeTitler } from "./episode-title.ts";
import { Media } from "./media.ts";
import { Telegram } from "./telegram.ts";
import { ThumbnailQuotes } from "./thumbnail-quote.ts";
import { Transcriber } from "./transcription.ts";
import { VideoTagGenerator } from "./video-tags.ts";
import type { EpisodeDescription } from "./youtube.ts";

/** Bump to regenerate the saved title, chapters, quote and tags of unpublished episodes. */
const episodeGenerationVersion = 1;

/** The first recording of an episode carries its upload and stands for it in the queue. */
export const episodeHead = (job: Job) => job.episode_id === job.id;
export const episodeMember = (job: Job) => job.episode_id !== null && job.episode_id !== job.id;

/** Recordings after this message id are published in episodes; none before the cutover. */
export const episodeCutover = Effect.fn("episodeCutover")(function* () {
  const { db } = yield* Store;
  const { channel } = yield* Settings;
  const row = yield* attempt("Read episode cutover", () =>
    db.query`SELECT episodes_after FROM sources WHERE channel=${channel}`.get(),
  );
  if (row === undefined) return undefined;
  return (
    Schema.decodeUnknownSync(Schema.Struct({ episodes_after: Schema.NullOr(Schema.BigInt) }))(row)
      .episodes_after ?? undefined
  );
});

export const inEpisodes = (job: Job, cutover: bigint | undefined) =>
  cutover !== undefined && job.message_id > cutover;

/**
 * Join waiting recordings into episodes once six hours of silence follow them. Recordings
 * keep feed order; consecutive episodes are numbered so each takes the next scene.
 */
export const formEpisodes = Effect.fn("formEpisodes")(function* (now: DateTime.Utc) {
  const cutover = yield* episodeCutover();
  if (cutover === undefined) return;
  const waiting = (yield* listJobs()).filter(
    (job) => inEpisodes(job, cutover) && job.episode_id === null && job.status !== "uploaded",
  );
  const groups: Job[][] = [];
  let last = -Infinity;
  for (const job of waiting) {
    const time = Date.parse(job.published_at);
    if (time - last >= episodeGapMs) groups.push([]);
    groups.at(-1)!.push(job);
    last = time;
  }
  const { db } = yield* Store;
  const iso = DateTime.formatIso(now);
  for (const [index, group] of groups.entries()) {
    const end = Date.parse(group.at(-1)!.published_at);
    // The newest run stays open while later voices may still join it.
    if (index === groups.length - 1 && DateTime.toEpochMillis(now) - end < episodeGapMs) break;
    const head = group[0]!;
    yield* attempt("Form an episode", async () => {
      await using tx = await db.begin();
      const row = await tx.query`SELECT COALESCE(MAX(number), 0) + 1 AS number FROM episodes`.get();
      const { number } = Schema.decodeUnknownSync(Schema.Struct({ number: Schema.BigInt }))(row);
      await tx.query`INSERT INTO episodes(id, number, created_at, updated_at)
        VALUES (${head.id}, ${number}, ${iso}, ${iso})`.run();
      for (const job of group)
        await tx.query`UPDATE jobs SET episode_id=${head.id}, updated_at=${iso}
          WHERE id=${job.id} AND episode_id IS NULL`.run();
      await tx.commit();
    });
    yield* Effect.logInfo(
      `Episode ${head.id}: ${group.length} recording(s) until ${group.at(-1)!.id}`,
    );
  }
});

const episodeMembers = Effect.fn("episodeMembers")(function* (head: Job) {
  return (yield* listJobs()).filter((job) => job.episode_id === head.id);
});

const Episode = Schema.Struct({
  number: Schema.BigInt,
  duration: Schema.NullOr(Schema.Number),
  topic: Schema.NullOr(Schema.String),
  thumbnail_quote: Schema.NullOr(Schema.String),
  tags: Schema.NullOr(Schema.fromJsonString(Schema.Array(Schema.String))),
  generation_version: Schema.BigInt,
});

const readEpisode = Effect.fn("readEpisode")(function* (head: Job) {
  const { db } = yield* Store;
  const row = yield* attempt("Read episode", () =>
    db.query`SELECT number, duration, topic, thumbnail_quote, tags, generation_version
      FROM episodes WHERE id=${head.id}`.get(),
  );
  if (row === undefined)
    return yield* new AppError({ message: `Episode ${head.id} is not formed` });
  return yield* attempt("Validate episode", async () => Schema.decodeUnknownSync(Episode)(row));
});

/** The episode's number, which picks its scene for the video and the thumbnail. */
export const episodeNumber = Effect.fn("episodeNumber")(function* (head: Job) {
  return Number((yield* readEpisode(head)).number);
});

/** Render every recording of the episode into the head's video and record where each starts. */
export const renderEpisodeVideo = Effect.fn("renderEpisodeVideo")(function* (head: Job) {
  const telegram = yield* Telegram;
  const media = yield* Media;
  const members = yield* episodeMembers(head);
  const recordings = yield* Effect.forEach(members, (job) =>
    telegram.post(Number(job.message_id)).pipe(
      Effect.flatMap((post) =>
        post.forwarded
          ? new AppError({
              message: `Recording ${job.id} is now marked as forwarded; refusing to publish it as an original`,
            })
          : Effect.succeed({ post, audioIndex: Number(job.audio_index) }),
      ),
    ),
  );
  const rendered = yield* media.renderEpisode(recordings, yield* episodeNumber(head), head.id);
  const { db } = yield* Store;
  const iso = DateTime.formatIso(yield* DateTime.now);
  yield* attempt("Save rendered episode", async () => {
    await using tx = await db.begin();
    await tx.query`UPDATE jobs SET status='ready', video_path=${rendered.path},
      video_sha256=${rendered.sha256}, video_size=${rendered.size}, updated_at=${iso}
      WHERE id=${head.id}`.run();
    await tx.query`UPDATE episodes SET duration=${rendered.duration}, updated_at=${iso}
      WHERE id=${head.id}`.run();
    for (const [index, job] of members.entries())
      await tx.query`UPDATE jobs SET episode_offset=${rendered.starts[index]!}
        WHERE id=${job.id}`.run();
    await tx.commit();
  });
  return rendered;
});

/**
 * Transcribe the episode and generate its title, chapters, thumbnail quote and tags once;
 * later calls read them back. Rendering must come first: chapters start where the
 * recordings do.
 */
export const episodeMetadata = Effect.fn("episodeMetadata")(function* (head: Job) {
  const saved = yield* readEpisode(head);
  let members = yield* episodeMembers(head);
  if (members.some((job) => job.episode_offset === null))
    return yield* new AppError({ message: `Render episode ${head.id} before titling it` });
  if (
    saved.generation_version !== BigInt(episodeGenerationVersion) ||
    !saved.topic ||
    !saved.thumbnail_quote ||
    members.some((job) => job.chapter === null)
  ) {
    const telegram = yield* Telegram;
    const transcriber = yield* Transcriber;
    const titler = yield* EpisodeTitler;
    const { nearby } = yield* episodeAround(Number(head.message_id));
    const transcripts = yield* Effect.forEach(members, (job) =>
      telegram
        .post(Number(job.message_id))
        .pipe(
          Effect.flatMap((post) => transcriber.transcribe(post, Number(job.audio_index), nearby)),
        ),
    );
    const voices = members.map((job, index) => ({
      start: job.episode_offset!,
      transcript: transcripts[index]!,
    }));
    const { topic, title, chapters } = yield* titler.title(voices);
    const speech = transcripts.join("\n\n");
    const thumbnailQuote = yield* (yield* ThumbnailQuotes).generate(speech);
    const tags = yield* (yield* VideoTagGenerator).generate(speech, { title, people: [] });
    const { db } = yield* Store;
    const iso = DateTime.formatIso(yield* DateTime.now);
    yield* attempt("Save episode metadata", async () => {
      await using tx = await db.begin();
      await tx.query`UPDATE episodes SET topic=${topic}, thumbnail_quote=${thumbnailQuote},
        tags=${JSON.stringify(tags)}, generation_version=${episodeGenerationVersion},
        updated_at=${iso} WHERE id=${head.id}`.run();
      for (const [index, job] of members.entries())
        await tx.query`UPDATE jobs SET chapter=${chapters[index]!.title} WHERE id=${job.id}`.run();
      await tx.commit();
    });
    yield* Effect.logInfo(`Episode ${head.id}: ${title}`);
    members = yield* episodeMembers(head);
    return { topic, thumbnailQuote, tags, members, duration: saved.duration ?? Infinity };
  }
  return {
    topic: saved.topic,
    thumbnailQuote: saved.thumbnail_quote,
    tags: saved.tags ?? [],
    members,
    duration: saved.duration ?? Infinity,
  };
});

/** The video's description: chapters and the original messages. */
export const episodeDescription = (
  title: string,
  members: readonly Job[],
  duration: number,
): EpisodeDescription => ({
  title,
  chapters: chapterLines(
    members.map((job) => ({ start: job.episode_offset ?? 0, title: job.chapter ?? "" })),
    duration,
  ),
  recordings: members,
});

/** Make the next generation of every unpublished episode's metadata. */
export const regenerateEpisodes = Effect.fn("regenerateEpisodes")(function* () {
  const { db } = yield* Store;
  yield* attempt("Queue episode metadata regeneration", () =>
    db.execute(
      `UPDATE episodes SET generation_version=0
        WHERE id IN (SELECT id FROM jobs WHERE status!='uploaded')`,
    ),
  );
});
