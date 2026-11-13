import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import OpenAI, { toFile } from "openai";
import { AppError, attempt, Paths, safeMessage, Settings } from "./core.ts";
import { Store } from "./database.ts";
import { downloadMedia } from "./media.ts";
import { NameAdditions } from "./name-additions.ts";
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

const Verdicts = Schema.Record(Schema.String, Schema.Boolean);
type Verdicts = typeof Verdicts.Type;

/**
 * Where transcripts and name verdicts are kept, per recording (`channel-message-index`) and
 * model. The worker keeps them in BoxDB beside its queue, a preview in DATA_DIR/transcripts.
 */
export class TranscriptStore extends Context.Service<
  TranscriptStore,
  {
    read(id: string, model: string): Effect.Effect<string | undefined, AppError>;
    write(id: string, model: string, text: string): Effect.Effect<void, AppError>;
    verdicts(id: string, model: string): Effect.Effect<Verdicts, AppError>;
    saveVerdicts(id: string, model: string, verdicts: Verdicts): Effect.Effect<void, AppError>;
  }
>()("maddyvoice/TranscriptStore") {
  static readonly files = Layer.effect(
    TranscriptStore,
    Effect.gen(function* () {
      const { dataDir } = yield* Settings;
      const path = (id: string, model: string, suffix: string) =>
        join(dataDir, "transcripts", model, `${id}${suffix}`);
      const save = (target: string, text: string) =>
        attempt("Save transcript file", async () => {
          await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
          await writeFile(`${target}.new`, text, { mode: 0o600 });
          await rename(`${target}.new`, target);
        });
      return TranscriptStore.of({
        read: (id, model) =>
          Effect.promise(() => readFile(path(id, model, ".txt"), "utf8").catch(() => undefined)),
        write: (id, model, text) => save(path(id, model, ".txt"), text),
        verdicts: (id, model) =>
          Effect.promise(() =>
            readFile(path(id, model, ".names.json"), "utf8")
              .then((text) => Schema.decodeUnknownSync(Verdicts)(JSON.parse(text)))
              .catch((): Verdicts => ({})),
          ),
        saveVerdicts: (id, model, verdicts) =>
          save(path(id, model, ".names.json"), JSON.stringify(verdicts)),
      });
    }),
  );

  static readonly database = Layer.effect(
    TranscriptStore,
    Effect.gen(function* () {
      const { db } = yield* Store;
      return TranscriptStore.of({
        read: (id, model) =>
          attempt("Read saved transcript", async () => {
            const row = await db.query`SELECT text FROM transcripts
              WHERE job_id=${id} AND model=${model}`.get();
            return row === undefined
              ? undefined
              : Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(row).text;
          }),
        write: (id, model, text) =>
          attempt("Save transcript", async () => {
            await db.query`INSERT INTO transcripts(job_id, model, text, created_at)
              VALUES (${id}, ${model}, ${text}, ${new Date().toISOString()})
              ON CONFLICT DO NOTHING`.run();
          }),
        verdicts: (id, model) =>
          attempt("Read name verdicts", async () => {
            const rows = Schema.decodeUnknownSync(
              // BOOLEAN columns read back as 0 or 1.
              Schema.Array(Schema.Struct({ trigger: Schema.String, name: Schema.BigInt })),
            )(
              await db.query`SELECT trigger, name FROM name_verdicts WHERE job_id=${id} AND model=${model}`,
            );
            return Object.fromEntries(rows.map((row) => [row.trigger, row.name === 1n]));
          }),
        saveVerdicts: (id, model, verdicts) =>
          attempt("Save name verdicts", async () => {
            await using tx = await db.begin();
            for (const [trigger, name] of Object.entries(verdicts))
              await tx.query`INSERT INTO name_verdicts(job_id, model, trigger, name)
                VALUES (${id}, ${model}, ${trigger}, ${name}) ON CONFLICT DO NOTHING`.run();
            await tx.commit();
          }),
      });
    }),
  );
}

// Transcribes voices through the OpenAI API with a key restricted to /v1/audio, hinting the
// names from assets/names.json and the worker's additions to it. Each transcript is paid for once and kept in the
// TranscriptStore. The kept text is what the recogniser heard; names are corrected on every
// read, so a new alias also fixes transcripts made before it.
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
      const store = yield* TranscriptStore;
      const additions = yield* NameAdditions;
      // Commands that never transcribe run without the key.
      const apiKey = yield* Config.Redacted("OPENAI_TRANSCRIPTION_API_KEY").pipe(Config.option);
      const model = yield* Config.String("TRANSCRIPTION_MODEL").pipe(
        Config.withDefault("gpt-transcribe"),
      );
      // The SDK would otherwise pick up OPENAI_BASE_URL, which points at the model proxy.
      const client = Option.map(
        apiKey,
        (key) =>
          new OpenAI({
            baseURL: "https://api.openai.com/v1",
            apiKey: Redacted.value(key),
            maxRetries: 2,
          }),
      );
      // Only gpt-transcribe takes keyword hints; other models reject the field.
      const hints = model.startsWith("gpt-transcribe");
      const directory = join(config.dataDir, "transcripts");
      const recognise = Effect.fn("Transcriber.recognise")(function* (
        id: string,
        post: Post,
        audioIndex: number,
        keywords: readonly string[],
      ) {
        const audioUrl = post.audio[audioIndex];
        if (!audioUrl)
          return yield* new AppError({ message: "Recording has no downloadable audio" });
        const cached = yield* store.read(id, model);
        if (cached !== undefined) return cached;
        if (Option.isNone(client))
          return yield* new AppError({
            message: "Set OPENAI_TRANSCRIPTION_API_KEY to transcribe voices",
          });
        yield* attempt("Create transcript directory", () =>
          mkdir(directory, { recursive: true, mode: 0o700 }),
        );
        const audio = yield* Effect.acquireRelease(
          Effect.succeed(join(directory, `.${id}.audio`)),
          (path) => Effect.promise(() => rm(path, { force: true })),
        );
        yield* attempt("Download Telegram audio", (signal) =>
          downloadMedia(audioUrl, audio, maxAudioBytes, signal),
        );
        const { text } = yield* Effect.tryPromise({
          try: async (signal) =>
            client.value.audio.transcriptions.create(
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
        yield* store.write(id, model, text.trim());
        return text.trim();
      }, Effect.scoped);
      // Verdicts on common words that may be names are kept with the transcript, so the
      // model is asked once per word occurrence.
      const transcribe = Effect.fn("Transcriber.transcribe")(function* (
        post: Post,
        audioIndex: number,
        nearby: readonly string[] = [],
      ) {
        const id = `${config.channel}-${post.id}-${audioIndex}`;
        const names = yield* readNames(Paths.names);
        const added = (yield* additions.list()).map((addition) => addition.name);
        const heard = yield* recognise(id, post, audioIndex, keywordsFor(names, nearby, added));
        const triggers = findTriggers(heard, names);
        const known = yield* store.verdicts(id, model);
        const unknown = triggers.filter((trigger) => !(trigger.key in known));
        const fresh = Object.fromEntries(yield* checker.judge(unknown));
        if (unknown.length) yield* store.saveVerdicts(id, model, fresh);
        const verdicts = { ...known, ...fresh };
        const confirmed = new Set(
          triggers.filter((trigger) => verdicts[trigger.key]).map((trigger) => trigger.key),
        );
        return autocorrect(heard, names, confirmed);
      });
      return Transcriber.of({ transcribe });
    }),
  );
}
