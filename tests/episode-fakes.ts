import { Effect, Layer } from "effect";
import { EpisodeTitler } from "../src/episode-title.ts";
import { ThumbnailQuotes } from "../src/thumbnail-quote.ts";
import { Transcriber } from "../src/transcription.ts";
import { VideoTagGenerator } from "../src/video-tags.ts";

/** Calls made to the fake episode metadata services. */
export type EpisodeCalls = { transcripts: string[]; titles: number; nearby: string[][] };

/** Deterministic stand-ins for transcription and the model-backed episode metadata. */
export function episodeFakes(calls: EpisodeCalls = { transcripts: [], titles: 0, nearby: [] }) {
  return Layer.mergeAll(
    Layer.succeed(
      Transcriber,
      Transcriber.of({
        transcribe: (post, audioIndex, nearby = []) =>
          Effect.sync(() => {
            calls.transcripts.push(`${post.id}-${audioIndex}`);
            calls.nearby.push([...nearby]);
            return `Рассказ из голосового ${post.id}.`;
          }),
      }),
    ),
    Layer.succeed(
      EpisodeTitler,
      EpisodeTitler.of({
        title: (voices) =>
          Effect.sync(() => {
            calls.titles++;
            return {
              topic: "о голосовании за участников",
              title: "Мэддисон о голосовании за участников",
              chapters: voices.map((voice, index) => ({
                start: voice.start,
                title: `Глава ${index + 1}`,
              })),
            };
          }),
      }),
    ),
    Layer.succeed(
      ThumbnailQuotes,
      ThumbnailQuotes.of({ generate: () => Effect.succeed("Большой рассказ") }),
    ),
    Layer.succeed(
      VideoTagGenerator,
      VideoTagGenerator.of({ generate: () => Effect.succeed(["голосование"]) }),
    ),
  );
}
