import { expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { AppError } from "../src/core.ts";
import {
  reviewPrompt,
  reviewedTopic,
  validateReview,
  type TopicReview,
} from "../src/topic-review.ts";

const transcript = "Ворон пытается доказать свою правоту в споре о новой игре.";
const accepted: TopicReview = {
  supported: true,
  claims: [{ claim: "Ворон пытается доказать свою правоту", quote: transcript }],
  reason: "Утверждение подтверждается полной расшифровкой.",
};
const rejected: TopicReview = {
  supported: false,
  claims: [{ claim: "Ворон прекратил стримить и возвращается", quote: null }],
  reason: "Речь не подтверждает изменение деятельности героя.",
};

it("requires literal speech evidence for every approved claim and preserves rejection reasons", () => {
  expect(validateReview(accepted, transcript)).toEqual(accepted);
  expect(validateReview(rejected, transcript)).toEqual(rejected);
  expect(() => validateReview({ ...accepted, claims: [] }, transcript)).toThrow("every claim");
  expect(() => validateReview({ ...rejected, supported: true }, transcript)).toThrow("every claim");
  expect(() => validateReview(accepted, "Другая речь без этой цитаты.")).toThrow("absent");
});

it("sends the reviewer only speech and the title, without generation evidence or hints", () => {
  const prompt = reviewPrompt(transcript, "Попытки Ворона доказать свою правоту");
  expect(JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1))).toEqual({
    transcript,
    topic: "Попытки Ворона доказать свою правоту",
  });
  expect(reviewPrompt("", "")).not.toMatch(/Зио|репутац|стриминг|commentIds|candidates/);
});

it("discards an unsupported title and checks a fresh generation before returning it", async () => {
  const drafts = ["Возвращение Ворона в стриминг", "Попытки Ворона доказать свою правоту"];
  const checked: string[] = [];
  let generations = 0;
  const result = await Effect.runPromise(
    reviewedTopic(
      transcript,
      () => Effect.succeed(drafts[generations++]!),
      (speech, topic) => {
        expect(speech).toBe(transcript);
        checked.push(topic);
        return Effect.succeed(checked.length === 1 ? rejected : accepted);
      },
    ),
  );
  expect(result).toBe(drafts[1]);
  expect(checked).toEqual(drafts);
  expect(generations).toBe(2);
});

it("fails closed after three rejections and never retries a failed model call immediately", async () => {
  let generations = 0;
  const generate = () => {
    generations++;
    return Effect.succeed("Возвращение Ворона в стриминг");
  };
  await expect(
    Effect.runPromise(reviewedTopic(transcript, generate, () => Effect.succeed(rejected))),
  ).rejects.toThrow("after 3 independent attempts");
  expect(generations).toBe(3);
  generations = 0;
  await expect(
    Effect.runPromise(
      reviewedTopic(transcript, generate, () =>
        Effect.fail(new AppError({ message: "Model usage limit" })),
      ),
    ),
  ).rejects.toThrow("usage limit");
  expect(generations).toBe(1);
});

it("counts malformed drafts as attempts and reviews only a structurally valid title", async () => {
  let calls = 0;
  let reviews = 0;
  const topic = await Effect.runPromise(
    reviewedTopic(
      transcript,
      () => Effect.succeed(++calls === 1 ? undefined : "Ворон доказывает свою правоту"),
      () => {
        reviews++;
        return Effect.succeed(accepted);
      },
    ),
  );
  expect(topic).toBe("Ворон доказывает свою правоту");
  expect(calls).toBe(2);
  expect(reviews).toBe(1);
});
