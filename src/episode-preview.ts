import { DateTime, Effect } from "effect";
import { AppError, json } from "./core.ts";
import { episodeGapMs, groupEpisodes } from "./episode.ts";
import { Media } from "./media.ts";
import { Telegram, type Post } from "./telegram.ts";
import { Transcriber } from "./transcription.ts";

const time = (post: Post) => Date.parse(post.date);

/** The episode containing a voice among the posts read so far, with the edges of both. */
function episodeOf(posts: Iterable<Post>, messageId: number) {
  const feed = [...posts].sort((a, b) => a.id - b.id);
  const episode = groupEpisodes(feed).find((recordings) =>
    recordings.some((recording) => recording.post.id === messageId),
  );
  return (
    episode && {
      episode,
      first: time(episode[0]!.post),
      last: time(episode.at(-1)!.post),
      oldest: feed[0]!,
      latest: feed.at(-1)!,
    }
  );
}

/**
 * The episode containing a voice. Reads the feed outwards from the voice until a full gap
 * without voices lies on both sides; `complete` is false while later voices may still join.
 */
export const episodeAround = Effect.fn("episodeAround")(function* (messageId: number) {
  const telegram = yield* Telegram;
  const newest = Math.max(...(yield* telegram.page()).posts.map((post) => post.id));
  const posts = new Map<number, Post>();
  // Set once the page holding the channel's first messages has been read.
  let start = false;
  const load = Effect.fn("episodeAround.load")(function* (before: number) {
    yield* Effect.sleep("300 millis");
    const page = yield* telegram.page(before);
    const fresh = page.posts.filter((post) => !posts.has(post.id));
    for (const post of fresh) posts.set(post.id, post);
    start ||= page.before === undefined;
    return { fresh: fresh.length > 0, lowest: Math.min(...page.posts.map((post) => post.id)) };
  });
  // Read pages from `before` back down to the known posts so none between is missed.
  const loadDownTo = Effect.fn("episodeAround.loadDownTo")(function* (
    before: number,
    known: number,
  ) {
    for (let cursor = before; ;) {
      const page = yield* load(cursor);
      if (!page.fresh || page.lowest <= known) return;
      cursor = page.lowest;
    }
  });
  yield* load(messageId + 1);
  let ahead = messageId;
  for (let pages = 0; pages < 100; pages++) {
    const found = episodeOf(posts.values(), messageId);
    if (!found)
      return yield* new AppError({
        message: `Telegram post #${messageId} is not an original voice message`,
      });
    const { episode, first, last, oldest, latest } = found;
    if (!start && time(oldest) > first - episodeGapMs) yield* load(oldest.id);
    else if (latest.id < newest && time(latest) < last + episodeGapMs) {
      ahead = Math.min(Math.max(ahead, latest.id) + 21, newest + 1);
      yield* loadDownTo(ahead, latest.id);
    } else {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      return { episode, complete: latest.id < newest || now - last >= episodeGapMs };
    }
  }
  return yield* new AppError({ message: `The episode around #${messageId} is too long to load` });
});

export const previewEpisode = Effect.fn("previewEpisode")(function* (messageId: number) {
  const media = yield* Media;
  const transcriber = yield* Transcriber;
  const { episode, complete } = yield* episodeAround(messageId);
  const transcripts = yield* Effect.forEach(episode, (recording) =>
    transcriber.transcribe(recording.post, recording.audioIndex),
  );
  const first = episode[0]!.post;
  // Published episodes will take the scene from their own number; until then the first
  // voice stands in for it.
  const result = yield* media.renderEpisode(episode, first.id, `preview-episode-${first.id}`);
  console.log(
    json({
      path: result.path,
      sha256: result.sha256,
      size: result.size,
      duration: result.duration,
      complete,
      voices: episode.map((recording, index) => ({
        source: recording.post.url,
        publishedAt: recording.post.date,
        start: result.starts[index],
        transcript: transcripts[index],
      })),
    }),
  );
});
