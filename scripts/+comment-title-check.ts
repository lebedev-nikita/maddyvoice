import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { ChildProcess } from "effect/process";
import { createHash, randomInt } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { AppError, attempt, json } from "../src/core.ts";
import {
  CommentTopics,
  commentBodies,
  extractionPrompt,
  titlePrompt,
  finalizeCommentTopic,
  type NickCandidate,
} from "../src/comment-topics.ts";
import { commandJson } from "../src/commands.ts";
import { Transcript, topicTitle } from "../src/topic.ts";
import { reviewedTopic, reviewPrompt, type TopicReview } from "../src/topic-review.ts";

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
    channel: { type: "string" },
    post: { type: "string" },
    transcript: { type: "string" },
    output: { type: "string" },
    repetitions: { type: "string", default: "3" },
    "source-video": { type: "string" },
  },
});
const options = Schema.decodeUnknownSync(
  Schema.Struct({
    profile: Schema.NonEmptyString,
    channel: Schema.String.check(Schema.isPattern(/^@[a-zA-Z0-9_]+$/)),
    post: Schema.String.check(Schema.isPattern(/^\d+$/)),
    transcript: Schema.NonEmptyString,
    output: Schema.NonEmptyString,
    repetitions: Schema.String.check(Schema.isPattern(/^[1-5]$/)),
    "source-video": Schema.optionalKey(
      Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{11}$/)),
    ),
  }),
)(values);
const Page = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
  page: Schema.Struct({ has_more: Schema.Boolean }),
  meta: Schema.Struct({ complete: Schema.Boolean }),
});
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const trial = Effect.fn("commentTitleTrial")(function* (
  transcript: string,
  candidates: readonly NickCandidate[],
  arm: string,
  round: number,
  repetitions: number,
) {
  console.log(`Round ${round}/${repetitions}: ${arm}; fresh isolated model session.`);
  const topics = yield* CommentTopics;
  const supplied = arm === "with-candidates" ? candidates : [];
  const attempts: Array<{
    draftTitle: string;
    title?: string;
    reviewPromptHash?: string;
    review?: TopicReview;
    error?: string;
  }> = [];
  const generate = Effect.fn("blindTitleDraft")(function* () {
    const result = yield* topics.generate(transcript, supplied);
    const item: (typeof attempts)[number] = { draftTitle: topicTitle(result.draft.topic) };
    attempts.push(item);
    const topic = yield* attempt("Finalize blind title draft", async () =>
      finalizeCommentTopic(result.draft, transcript, supplied),
    ).pipe(
      Effect.catch((error) => {
        item.error = error.message;
        return Effect.succeed(undefined);
      }),
    );
    if (!topic) return;
    item.title = topicTitle(topic);
    return topic;
  });
  const verify = Effect.fn("blindTitleReview")(function* (speech: string, topic: string) {
    const item = attempts.at(-1)!;
    item.reviewPromptHash = hash(reviewPrompt(speech, topicTitle(topic)));
    const review = yield* topics.verify(speech, topic);
    item.review = review;
    return review;
  });
  const result = yield* reviewedTopic(transcript, generate, verify).pipe(Effect.result);
  if (result._tag === "Failure")
    return { arm, round, accepted: false, attempts, error: result.failure.message };
  return {
    arm,
    round,
    title: topicTitle(result.success),
    accepted: true,
    attempts,
  };
});

const runTrials = Effect.fn("commentTitleTrials")(function* (
  transcript: string,
  supported: readonly NickCandidate[],
  repetitions: number,
) {
  const trials: Array<Effect.Success<ReturnType<typeof trial>>> = [];
  for (let round = 1; round <= repetitions; round++) {
    const arms = randomInt(2)
      ? ["transcript-only", "with-candidates"]
      : ["with-candidates", "transcript-only"];
    for (const arm of arms) {
      trials.push(yield* trial(transcript, supported, arm, round, repetitions));
    }
  }
  return trials;
});

const readComments = Effect.fn("readExperimentComments")(function* () {
  const raw = yield* commandJson(
    ChildProcess.make("tg", [
      options.profile,
      "messages",
      "comments",
      options.channel,
      options.post,
      "--limit",
      "100",
      "--json=id,text",
      "--no-input",
      "--no-record",
    ]),
  );
  const page = yield* attempt("Validate comments page", async () =>
    Schema.decodeUnknownSync(Page)(raw),
  );
  if (page.page.has_more || !page.meta.complete)
    return yield* new AppError({
      message: "Incomplete comment sample; refusing a misleading experiment (maximum 100 comments)",
    });
  const comments = commentBodies(page.items).map((entry, index) => ({
    id: `c${index + 1}`,
    text: entry.text,
  }));
  return { page, comments };
});

const program = Effect.gen(function* () {
  const transcript = (yield* attempt("Read source transcript", () =>
    readFile(options.transcript, "utf8"),
  )).trim();
  yield* attempt("Validate source transcript", async () =>
    Schema.decodeUnknownSync(Transcript)({ text: transcript }),
  );
  const { page, comments } = yield* readComments();
  const topics = yield* CommentTopics;
  const repetitions = Number(options.repetitions);
  // Commit the protocol and hashes before any model sees the data. Never persist raw messages.
  const protocol = {
    version: "comment-title-v4",
    sourceVideo: options["source-video"] ?? null,
    model: topics.model,
    reviewModel: topics.reviewModel,
    repetitions,
    webSearch: false,
    registry: false,
    authorMetadata: false,
    maxSemanticAttempts: 3,
    reviewerInputs: ["transcript", "topic"],
    reviewPromptHash: hash(reviewPrompt("", "")),
    comments: page.items.length,
    textualComments: comments.length,
    transcriptHash: hash(transcript),
    commentBodiesHash: hash(comments),
    extractionPromptHash: hash(extractionPrompt(comments)),
    controlPromptHash: hash(titlePrompt(transcript, [])),
  };
  yield* attempt("Record frozen experiment protocol", async () => {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, json({ protocol, status: "started" }) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  });
  console.log("Protocol frozen; extracting candidates from comment bodies only.");
  const extraction = yield* topics.extract(comments).pipe(Effect.result);
  if (extraction._tag === "Failure") {
    yield* attempt("Save extraction failure", () =>
      writeFile(
        options.output,
        json({
          protocol,
          status: "failed",
          stage: "extraction",
          error: extraction.failure.message,
        }) + "\n",
        { mode: 0o600 },
      ),
    );
    return yield* extraction.failure;
  }
  const { candidates, rejectedMentions, rejectedCandidates } = extraction.success;
  const supported = candidates.filter((entry) => entry.mentions.length >= 2);
  const trials = yield* runTrials(transcript, supported, repetitions);
  const report = {
    protocol,
    rejectedMentions,
    rejectedCandidates,
    treatmentPromptHash: hash(titlePrompt(transcript, supported)),
    candidates: candidates.map((candidate) => ({
      nick: candidate.nick,
      mentions: candidate.mentions.length,
      commentIds: candidate.mentions.map(
        (mention) =>
          page.items.find(
            (item) => item.text === comments.find((entry) => entry.id === mention.commentId)?.text,
          )?.id,
      ),
    })),
    trials,
  };
  yield* attempt("Save experiment outcomes", () =>
    writeFile(options.output, json(report) + "\n", { mode: 0o600 }),
  );
  console.log(json(report));
});

await Effect.runPromise(
  program.pipe(Effect.provide(CommentTopics.layer.pipe(Layer.provideMerge(BunServices.layer)))),
);
