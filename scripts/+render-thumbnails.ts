import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Schema } from "effect";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { attempt, Settings } from "../src/core.ts";
import { renderThumbnail, ThumbnailRowFields } from "../src/thumbnail.ts";

const Quotes = Schema.Struct({
  rows: Schema.Array(
    Schema.Struct({
      ...ThumbnailRowFields,
      thumbnailQuote: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    }),
  ),
});
const program = Effect.gen(function* () {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      quotes: { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values.quotes || !values.output)
    throw new Error("Use --quotes quotes.json --output data/thumbnails");
  const rows = yield* attempt("Read generated quotes", async () =>
    Schema.decodeUnknownSync(Quotes)(JSON.parse(await readFile(values.quotes!, "utf8"))),
  );
  for (const row of rows.rows) {
    const started = performance.now();
    const path = yield* renderThumbnail(
      row.thumbnailQuote,
      { messageId: row.messageId, publishedAt: row.publishedAt },
      join(resolve(values.output), `${row.video}.png`),
    );
    yield* Effect.logInfo(`${row.video}: ${Math.round(performance.now() - started)} ms -> ${path}`);
  }
}).pipe(Effect.provide(Settings.layer), Effect.provide(BunServices.layer));
BunRuntime.runMain(program);
