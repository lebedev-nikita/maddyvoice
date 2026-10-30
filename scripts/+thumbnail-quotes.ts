import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { attempt } from "../src/core.ts";
import {
  ThumbnailQuotes,
  thumbnailQuotePrompt,
  thumbnailReviewPrompt,
} from "../src/thumbnail-quote.ts";
import { ModelProxy, topicModel } from "../src/model.ts";

const Source = Schema.Struct({
  rows: Schema.Array(
    Schema.Struct({
      video: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{11}$/)),
      originalTitle: Schema.String,
      transcript: Schema.String.check(Schema.isMinLength(10), Schema.isMaxLength(200_000)),
    }),
  ),
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const program = Effect.gen(function* () {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      source: { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values.source || !values.output)
    throw new Error("Use --source sources.json --output data/thumbnail-quotes");
  const output = resolve(values.output);
  const source = yield* attempt("Read transcript sources", async () =>
    Schema.decodeUnknownSync(Source)(JSON.parse(await readFile(values.source!, "utf8"))),
  );
  const service = yield* ThumbnailQuotes;
  const model = yield* topicModel;
  yield* attempt("Create quote directory", () => mkdir(output, { recursive: true }));
  const rows = yield* Effect.forEach(
    source.rows,
    (row) =>
      Effect.gen(function* () {
        const thumbnailQuote = yield* service.generate(row.transcript);
        const result = {
          video: row.video,
          title: row.originalTitle,
          thumbnailQuote,
          model,
          transcriptHash: hash(row.transcript),
          promptHash: hash(thumbnailQuotePrompt(row.transcript)),
          reviewPromptHash: hash(thumbnailReviewPrompt(row.transcript, thumbnailQuote)),
        };
        yield* attempt("Save generated quote", () =>
          writeFile(join(output, `${row.video}.json`), JSON.stringify(result, null, 2) + "\n", {
            mode: 0o600,
          }),
        );
        yield* Effect.logInfo(`${row.video}: ${thumbnailQuote}`);
        return result;
      }),
    { concurrency: 2 },
  );
  yield* attempt("Save quote manifest", () =>
    writeFile(join(output, "quotes.json"), JSON.stringify({ rows }, null, 2) + "\n", {
      mode: 0o600,
    }),
  );
}).pipe(
  Effect.provide(ThumbnailQuotes.layer.pipe(Layer.provide(ModelProxy.layer))),
  Effect.provide(BunServices.layer),
);
BunRuntime.runMain(program);
