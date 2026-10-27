#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer, Option, Schedule, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { mkdir } from "node:fs/promises";
import { attempt, json, Settings } from "./core.ts";
import { getCursor, listJobs, Store, withWorkerLock } from "./database.ts";
import { Media } from "./media.ts";
import { manageService } from "./service.ts";
import { Telegram } from "./telegram.ts";
import { drainQueue, importHistory, poll, previewPost, resolveJob, retryJob } from "./worker.ts";
import { authorizeYouTube, YouTube } from "./youtube.ts";
import { Topics } from "./topic.ts";
import { drainTitles, listTitles } from "./titles.ts";

const services = Layer.mergeAll(
  Store.layer,
  Telegram.layer,
  Media.layer,
  YouTube.layer,
  Topics.layer,
).pipe(Layer.provideMerge(Settings.layer), Layer.provideMerge(BunServices.layer));
const app = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(services));
const positive = Schema.Int.check(Schema.isGreaterThan(0));
const limit = Flag.Int("limit").pipe(Flag.withSchema(positive), Flag.withDefault(10));
const test = Flag.Boolean("test").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Upload privately for testing"),
);
const root = Command.make("maddyvoice").pipe(
  Command.withDescription("Archive Maddyson's new Telegram voice messages on YouTube"),
);

const run = Command.make(
  "run",
  { once: Flag.Boolean("once").pipe(Flag.withDefault(false)), limit, test },
  ({ once, limit, test }) =>
    app(
      withWorkerLock(
        Effect.gen(function* () {
          const settings = yield* Settings;
          if (once) {
            yield* poll();
            yield* drainQueue(limit, test);
            yield* drainTitles(1);
            return;
          }
          yield* Effect.logInfo(
            `Watching https://t.me/${settings.channel} every ${settings.pollSeconds}s`,
          );
          const cycle = Effect.gen(function* () {
            yield* poll().pipe(Effect.catch((error) => Effect.logError(error.message)));
            yield* drainQueue(limit, test).pipe(
              Effect.catch((error) => Effect.logWarning(error.message)),
            );
          });
          const titleCycle = drainTitles(1).pipe(
            Effect.catch((error) => Effect.logWarning(error.message)),
          );
          yield* Effect.all(
            [
              cycle.pipe(Effect.repeat(Schedule.spaced(`${settings.pollSeconds} seconds`))),
              titleCycle.pipe(Effect.repeat(Schedule.spaced("5 minutes"))),
            ],
            { concurrency: "unbounded", discard: true },
          );
        }),
      ),
    ),
).pipe(
  Command.withDescription("Poll continuously and publish queued audio; --once performs one cycle"),
);

const scan = Command.make("scan", {}, () => app(withWorkerLock(poll()))).pipe(
  Command.withDescription("Check new posts and queue recordings without uploading"),
);

const history = Command.make(
  "history",
  {
    since: Flag.String("since").pipe(Flag.optional),
    until: Flag.String("until").pipe(Flag.optional),
    months: Flag.Int("months").pipe(Flag.withSchema(positive), Flag.withDefault(2)),
  },
  ({ since, until, months }) =>
    app(importHistory(Option.getOrUndefined(since), Option.getOrUndefined(until), months)),
).pipe(
  Command.withDescription(
    "Queue historical recordings (default: last two calendar months); --until is inclusive, dates are UTC",
  ),
);

const upload = Command.make("upload", { limit, test }, ({ limit, test }) =>
  app(withWorkerLock(drainQueue(limit, test))),
).pipe(Command.withDescription("Publish queued recordings without checking the feed"));

const titles = Command.make(
  "titles",
  {
    limit,
    now: Flag.Boolean("now").pipe(Flag.withDefault(false)),
  },
  ({ limit, now }) => app(withWorkerLock(drainTitles(limit, now))),
).pipe(
  Command.withDescription(
    "Name uploaded videos from YouTube captions; --now ignores retry times, not the daily quota",
  ),
);

const preview = Command.make(
  "preview",
  { message: Argument.Int("message-id").pipe(Argument.withSchema(positive)) },
  ({ message }) => app(previewPost(message)),
).pipe(
  Command.withDescription(
    "Render a real Telegram post to a local MP4 without publishing or changing the queue",
  ),
);

const status = Command.make("status", {}, () =>
  app(
    Effect.gen(function* () {
      const jobs = yield* listJobs();
      const cursor = yield* getCursor();
      const config = yield* Settings;
      const titles = yield* listTitles();
      const counts: Record<string, number> = {};
      for (const job of jobs) counts[job.status] = (counts[job.status] ?? 0) + 1;
      yield* Console.log(
        json({
          channel: config.channel,
          liveCursor: cursor ?? null,
          counts,
          titles: titles.map(({ job_id, status, topic, title, attempts, next_attempt, error }) => ({
            job_id,
            status,
            topic,
            title,
            attempts,
            next_attempt,
            error,
          })),
          jobs: jobs.map(
            ({ id, status, origin, source_url, published_at, attempts, error, youtube_id }) => ({
              id,
              status,
              origin,
              source_url,
              published_at,
              attempts,
              error,
              youtube_id,
            }),
          ),
        }),
      );
    }),
  ),
).pipe(Command.withDescription("Show the live boundary, queue, failures, and published video IDs"));

const youtubeAuth = Command.make(
  "youtube",
  { client: Flag.String("client"), channel: Flag.String("channel") },
  ({ client, channel }) =>
    app(
      Effect.gen(function* () {
        const config = yield* Settings;
        yield* attempt("Create authorization directory", () =>
          mkdir(config.dataDir, { recursive: true, mode: 0o700 }),
        );
        const result = yield* authorizeYouTube(client, channel);
        yield* Console.log(`Connected ${result.title}: https://youtube.com/channel/${result.id}`);
      }),
    ),
).pipe(
  Command.withDescription(
    "Authorize a Google Desktop OAuth client for the dedicated YouTube channel",
  ),
);
const auth = Command.make("auth").pipe(Command.withSubcommands([youtubeAuth]));

const resolve = Command.make(
  "resolve",
  { job: Argument.String("job-id"), video: Flag.String("video") },
  ({ job, video }) => app(withWorkerLock(resolveJob(job, video))),
).pipe(Command.withDescription("Reconcile a completed upload after checking YouTube Studio"));

const retry = Command.make(
  "retry",
  {
    job: Argument.String("job-id"),
    allowNew: Flag.Boolean("allow-new-upload").pipe(Flag.withDefault(false)),
  },
  ({ job: key, allowNew }) => app(withWorkerLock(retryJob(key, allowNew))),
).pipe(
  Command.withDescription(
    "Retry a failed job; ambiguous expired sessions require explicit reconciliation",
  ),
);

const service = Command.make(
  "service",
  {
    action: Argument.Literals("action", ["install", "start", "stop", "status", "uninstall"]),
  },
  ({ action }) => app(manageService(action)),
).pipe(Command.withDescription("Install or manage the macOS background worker"));

root.pipe(
  Command.withSubcommands([
    run,
    scan,
    history,
    upload,
    titles,
    preview,
    status,
    auth,
    resolve,
    retry,
    service,
  ]),
  Command.run({ version: "0.1.0" }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
