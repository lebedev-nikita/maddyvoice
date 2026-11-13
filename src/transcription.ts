import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import OpenAI, { toFile } from "openai";
import { AppError, attempt, Paths, safeMessage, Settings } from "./core.ts";
import { downloadMedia } from "./media.ts";
import { autocorrect, findTriggers, keywordsFor, NameChecker, readNames } from "./names.ts";
import type { Post } from "./telegram.ts";

// The transcription endpoint accepts files up to 25 MB.
const maxAudioBytes = 25 * 1024 * 1024;

function apiError(cause: unknown) {
  if (cause instanceof OpenAI.AuthenticationError)
    return new AppError({
      message: "OpenAI rejected the transcription key; check OPENAI_TRANSCRIPTION_API_KEY",
    });
  if (cause instanceof OpenAI.RateLimitError)
    return new AppError({ message: "OpenAI transcription rate or spending limit reached" });
  if (cause instanceof OpenAI.APIError)
    return new AppError({
      message: `OpenAI transcription error ${cause.status}: ${safeMessage(cause)}`,
    });
  return new AppError({ message: `Transcription request failed: ${safeMessage(cause)}` });
}

// Transcribes voices through the OpenAI API with a key restricted to /v1/audio, hinting the
// names from assets/names.json. Each transcript is paid for once and then read from
// DATA_DIR/transcripts/<model>. The saved text is what the recogniser heard; names are
// corrected on every read, so a new alias also fixes transcripts made before it.
export class Transcriber extends Context.Service<
  Transcriber,
  {
    /** `nearby` are the author's posts around the recording; their names are hinted first. */
    transcribe(
      post: Post,
      audioIndex: number,
      nearby?: readonly string[],
    ): Effect.Effect<string, AppError>;
  }
>()("maddyvoice/Transcriber") {
  static readonly layer = Layer.effect(
    Transcriber,
    Effect.gen(function* () {
      const config = yield* Settings;
      const checker = yield* NameChecker;
      const apiKey = yield* Config.Redacted("OPENAI_TRANSCRIPTION_API_KEY");
      const model = yield* Config.String("TRANSCRIPTION_MODEL").pipe(
        Config.withDefault("gpt-transcribe"),
      );
      // The SDK would otherwise pick up OPENAI_BASE_URL, which points at the model proxy.
      const client = new OpenAI({
        baseURL: "https://api.openai.com/v1",
        apiKey: Redacted.value(apiKey),
        maxRetries: 2,
      });
      // Only gpt-transcribe takes keyword hints; other models reject the field.
      const hints = model.startsWith("gpt-transcribe");
      const directory = join(config.dataDir, "transcripts", model);
      const recognise = Effect.fn("Transcriber.recognise")(function* (
        post: Post,
        audioIndex: number,
        keywords: readonly string[],
      ) {
        const audioUrl = post.audio[audioIndex];
        if (!audioUrl)
          return yield* new AppError({ message: "Recording has no downloadable audio" });
        const name = `${config.channel}-${post.id}-${audioIndex}`;
        const saved = join(directory, `${name}.txt`);
        const cached = yield* Effect.promise(() => readFile(saved, "utf8").catch(() => undefined));
        if (cached !== undefined) return cached;
        yield* attempt("Create transcript directory", () =>
          mkdir(directory, { recursive: true, mode: 0o700 }),
        );
        const audio = yield* Effect.acquireRelease(
          Effect.succeed(join(directory, `.${name}.audio`)),
          (path) => Effect.promise(() => rm(path, { force: true })),
        );
        yield* attempt("Download Telegram audio", (signal) =>
          downloadMedia(audioUrl, audio, maxAudioBytes, signal),
        );
        const { text } = yield* Effect.tryPromise({
          try: async (signal) =>
            client.audio.transcriptions.create(
              {
                // Telegram serves Opus in Ogg as .oga; the API recognises the format by .ogg.
                file: await toFile(await readFile(audio), "voice.ogg", { type: "audio/ogg" }),
                model,
                language: "ru",
                ...(hints ? { keywords: [...keywords] } : {}),
                response_format: "json",
              },
              { signal },
            ),
          catch: apiError,
        });
        yield* attempt("Save transcript", async () => {
          await writeFile(`${saved}.new`, text.trim(), { mode: 0o600 });
          await rename(`${saved}.new`, saved);
        });
        return text.trim();
      }, Effect.scoped);
      // Verdicts on common words that may be names are kept beside the transcript, so the
      // model is asked once per word occurrence.
      const Verdicts = Schema.Record(Schema.String, Schema.Boolean);
      const transcribe = Effect.fn("Transcriber.transcribe")(function* (
        post: Post,
        audioIndex: number,
        nearby: readonly string[] = [],
      ) {
        const names = yield* readNames(Paths.names);
        const heard = yield* recognise(post, audioIndex, keywordsFor(names, nearby));
        const triggers = findTriggers(heard, names);
        const saved = join(directory, `${config.channel}-${post.id}-${audioIndex}.names.json`);
        const known = yield* Effect.promise(() =>
          readFile(saved, "utf8")
            .then((text) => Schema.decodeUnknownSync(Verdicts)(JSON.parse(text)))
            .catch(() => ({}) as Record<string, boolean>),
        );
        const unknown = triggers.filter((trigger) => !(trigger.key in known));
        const verdicts = { ...known, ...Object.fromEntries(yield* checker.judge(unknown)) };
        if (unknown.length)
          yield* attempt("Save name verdicts", async () => {
            await writeFile(`${saved}.new`, JSON.stringify(verdicts), { mode: 0o600 });
            await rename(`${saved}.new`, saved);
          });
        const confirmed = new Set(
          triggers.filter((trigger) => verdicts[trigger.key]).map((trigger) => trigger.key),
        );
        return autocorrect(heard, names, confirmed);
      });
      return Transcriber.of({ transcribe });
    }),
  );
}
