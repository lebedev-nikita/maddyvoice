import { load } from "cheerio";
import { Config, Context, Effect, Layer, Schema } from "effect";
import { AppError, attempt } from "./core.ts";

export function topicTitle(topic: string) {
  const suffix = " | Мэддисон";
  const clean =
    topic
      .replace(/[<>\r\n]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Голосовое сообщение";
  const [first, ...rest] = Array.from(clean);
  const text = (first ?? "").toLocaleUpperCase("ru-RU") + rest.join("");
  const budget = 100 - Array.from(suffix).length;
  return Array.from(text).slice(0, budget).join("").trim() + suffix;
}

export function captionText(srt: string) {
  const result: string[] = [];
  for (const block of srt.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const time = lines.findIndex((line) => /\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->/.test(line));
    if (time < 0) continue;
    const text = load(lines.slice(time + 1).join(" "))
      .text()
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const words = text.split(" ");
    // ASR tracks can repeat the previous cue while adding new words.
    let overlap = Math.min(result.length, words.length);
    while (overlap > 0 && result.slice(-overlap).join(" ") !== words.slice(0, overlap).join(" "))
      overlap--;
    result.push(...words.slice(overlap));
  }
  const text = result.join(" ");
  if (text.length < 10) throw new Error("Caption track contains no usable speech");
  return text;
}

const Topic = Schema.Struct({
  topic: Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(75)),
});
export const Transcript = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(10), Schema.isMaxLength(200_000)),
});

export function validateTopic(value: unknown) {
  const { topic } = Schema.decodeUnknownSync(Topic)(value);
  const clean = topic
    .replace(/[«»"<>\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[а-яё]/i.test(clean) || /голосовое сообщение|обсуждение разных тем/i.test(clean))
    throw new Error("Model returned a vague or non-Russian topic");
  return clean;
}

export class Topics extends Context.Service<
  Topics,
  {
    readonly enabled: boolean;
    summarize(text: string): Effect.Effect<string, AppError>;
  }
>()("maddyvoice/Topics") {
  static readonly layer = Layer.effect(
    Topics,
    Effect.gen(function* () {
      const endpoint = yield* Config.String("TOPICS_URL").pipe(Config.withDefault(""));
      if (endpoint && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(endpoint))
        return yield* new AppError({
          message: "TOPICS_URL must be a local loopback HTTP endpoint",
        });
      const summarize = (text: string) =>
        attempt("Generate a video topic through Codex", async (signal) => {
          if (!endpoint) throw new Error("Set TOPICS_URL to enable topic generation");
          const body = Schema.decodeUnknownSync(Transcript)({ text });
          const response = await fetch(`${endpoint.replace(/\/$/, "")}/topic`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.any([signal, AbortSignal.timeout(200_000)]),
            body: JSON.stringify(body),
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Codex topic service HTTP ${response.status}`);
          }
          return validateTopic(await response.json());
        });
      return Topics.of({ enabled: endpoint.length > 0, summarize });
    }),
  );
}
