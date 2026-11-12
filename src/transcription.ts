import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Config, Context, Effect, Layer, Redacted } from "effect";
import OpenAI, { toFile } from "openai";
import { AppError, attempt, safeMessage, Settings } from "./core.ts";
import { downloadMedia } from "./media.ts";
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

// Transcribes voices through the OpenAI API with a key restricted to /v1/audio. Each
// transcript is paid for once and then read from DATA_DIR/transcripts.
export class Transcriber extends Context.Service<
  Transcriber,
  {
    transcribe(post: Post, audioIndex: number): Effect.Effect<string, AppError>;
  }
>()("maddyvoice/Transcriber") {
  static readonly layer = Layer.effect(
    Transcriber,
    Effect.gen(function* () {
      const config = yield* Settings;
      const apiKey = yield* Config.Redacted("OPENAI_TRANSCRIPTION_API_KEY");
      const model = yield* Config.String("TRANSCRIPTION_MODEL").pipe(
        Config.withDefault("gpt-4o-transcribe"),
      );
      // The SDK would otherwise pick up OPENAI_BASE_URL, which points at the model proxy.
      const client = new OpenAI({
        baseURL: "https://api.openai.com/v1",
        apiKey: Redacted.value(apiKey),
        maxRetries: 2,
      });
      const directory = join(config.dataDir, "transcripts");
      const transcribe = Effect.fn("Transcriber.transcribe")(function* (
        post: Post,
        audioIndex: number,
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
      return Transcriber.of({ transcribe });
    }),
  );
}
