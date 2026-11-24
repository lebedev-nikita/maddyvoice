import { load } from "cheerio";
import { Config, Context, DateTime, Effect, Layer, Schema } from "effect";
import { AppError, attempt } from "./core.ts";
import { ThumbnailQuote, validateThumbnailQuote } from "./thumbnail-quote.ts";
import { VideoTags, validateVideoTags } from "./video-tags.ts";

export const titleGenerationVersion = 1;
// Five 6-minute extraction batches, three 3-minute generation/review pairs and Telegram reads.
export const topicGenerationTimeoutMs = 60 * 60_000;

const ordinal = String.raw`(?:перв|втор|трет|четв[её]рт|пят|шест|седьм)(?:ая|ой|ую|ый|ий|ое|ом|ым|ые|ых|ья|ью|ьей|ье|ьем|ьим)`;
const namedPart = String.raw`(?:san ?andreas|vice ?city|liberty ?city|chinatown|london|online|advance|trilogy|сан[- ]?андреас|вайс?[- ]?сити|либерти[- ]?сити|чайнатаун|лондон|онлайн|трилоги)\p{L}*|rp|рп`;
// GTA not already tied to a part: «пятую GTA», «части GTA», «старой GTA», GTA 5, GTA V, GTA Online.
const bareGta = new RegExp(
  String.raw`(?<!(?:${ordinal}|(?:стар|прошл|предыдущ|прежн|классическ|сери|част)\p{L}*)\s+)` +
    String.raw`(?<![\p{L}\p{N}])(?:GTA|ГТА)` +
    String.raw`(?![\p{L}\p{N}]|-[\p{L}\p{N}]|\s*[-:–—]?\s*(?:\d|(?:I{1,3}|IV|VI?|${namedPart})(?![\p{L}\p{N}])))`,
  "giu",
);

/** GTA 6 is the popular search, so a title's GTA means it unless another part is named. */
function withGtaPart(text: string) {
  return text.replace(bareGta, "$& 6");
}

/** The published title: what the speech supports, with the channel's wording rules applied. */
export function topicTitle(topic: string) {
  return spokenTitle(withGtaPart(topic));
}

/** The title as the speech supports it, before wording rules; reviewers check this one. */
export function spokenTitle(topic: string) {
  const prefix = "Мэддисон ";
  const clean =
    topic
      .replace(/[<>\r\n]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Голосовое сообщение";
  const [first = "", second = "", ...rest] = Array.from(clean);
  // An abbreviation such as GTA keeps its capital.
  const lead =
    second.toLocaleLowerCase("ru-RU") === second ? first.toLocaleLowerCase("ru-RU") : first;
  const text = lead + second + rest.join("");
  const budget = 100 - Array.from(prefix).length;
  return prefix + Array.from(text).slice(0, budget).join("").trim();
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
const GeneratedTopic = Schema.Struct({
  ...Topic.fields,
  ...ThumbnailQuote.fields,
  ...VideoTags.fields,
});
export type GeneratedTopic = typeof GeneratedTopic.Type;
export const Transcript = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(10), Schema.isMaxLength(200_000)),
});
const TopicSource = Schema.Struct({
  channel: Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/)),
  messageId: Schema.String.check(Schema.isPattern(/^[1-9]\d*$/)),
  publishedAt: Schema.String,
});
export type TopicSource = typeof TopicSource.Type;
export const TopicRequest = Schema.Struct({ text: Transcript.fields.text, source: TopicSource });

export function commentsReadyAt(publishedAt: string) {
  return DateTime.toEpochMillis(DateTime.add(DateTime.makeUnsafe(publishedAt), { hours: 1 }));
}

export function validateTopic(value: unknown) {
  const { topic } = Schema.decodeUnknownSync(Topic)(value);
  const clean = topic
    .replace(/[«»"<>\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[а-яё]/i.test(clean) || /голосовое сообщение|обсуждение разных тем/i.test(clean))
    throw new Error("Model returned a vague or non-Russian topic");
  if (/м[эе]дд?исон|maddyson/i.test(clean)) throw new Error("Topic repeats the author's name");
  return clean;
}

export class Topics extends Context.Service<
  Topics,
  {
    readonly enabled: boolean;
    summarize(text: string, source: TopicSource): Effect.Effect<GeneratedTopic, AppError>;
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
      const summarize = (text: string, source: TopicSource) =>
        attempt("Generate a video topic through the topic service", async (signal) => {
          if (!endpoint) throw new Error("Set TOPICS_URL to enable topic generation");
          const body = Schema.decodeUnknownSync(TopicRequest)({ text, source });
          const response = await fetch(`${endpoint.replace(/\/$/, "")}/topic`, {
            method: "POST",
            timeout: false,
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(topicGenerationTimeoutMs + 30_000),
            ]),
            body: JSON.stringify(body),
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Topic service HTTP ${response.status}`);
          }
          const result = Schema.decodeUnknownSync(GeneratedTopic)(await response.json());
          return {
            topic: validateTopic(result),
            thumbnailQuote: validateThumbnailQuote(result, text),
            tags: validateVideoTags(result),
          };
        });
      return Topics.of({ enabled: endpoint.length > 0, summarize });
    }),
  );
}
