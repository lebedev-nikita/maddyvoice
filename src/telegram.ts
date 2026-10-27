import { load } from "cheerio";
import { Context, Effect, Layer, Schema } from "effect";
import { AppError, attempt, checkedFetch, Settings } from "./core.ts";

const PostSchema = Schema.Struct({
  id: Schema.Int,
  url: Schema.String,
  date: Schema.String,
  text: Schema.String,
  audio: Schema.Array(Schema.String),
  images: Schema.Array(Schema.String),
  forwarded: Schema.Boolean,
});
export type Post = typeof PostSchema.Type;
export type Page = { posts: readonly Post[]; before: number | undefined };

export function parsePage(html: string, channel: string): Page {
  const $ = load(html);
  const posts: Post[] = [];
  $(".tgme_widget_message[data-post]").each((_, element) => {
    const node = $(element);
    const reference = node.attr("data-post") ?? "";
    if (!reference.startsWith(`${channel}/`)) return;
    const id = Number(reference.split("/")[1]);
    const date = node.find(".tgme_widget_message_date time").attr("datetime");
    if (!Number.isSafeInteger(id) || id <= 0 || !date || !Number.isFinite(Date.parse(date))) {
      throw new Error("Telegram changed its message markup: missing ID or date");
    }
    const audio = node
      .find(".tgme_widget_message_voice_player audio, audio.tgme_widget_message_voice")
      .toArray()
      .flatMap((audioNode) => {
        const source = $(audioNode).attr("src") ?? $(audioNode).find("source").attr("src");
        return source ? [source] : [];
      });
    if (node.find(".tgme_widget_message_voice_player").length > 0 && audio.length === 0) {
      throw new Error(`Voice #${id} has no downloadable audio in the public preview`);
    }
    const images = node
      .find(".tgme_widget_message_photo_wrap")
      .toArray()
      .filter(
        (image) =>
          $(image).parents(".tgme_widget_message_link_preview, .tgme_widget_message_reply")
            .length === 0,
      )
      .flatMap((image) => {
        const style = $(image).attr("style") ?? "";
        const source = /background-image\s*:\s*url\(['"]?(.*?)['"]?\)/i.exec(style)?.[1];
        return source ? [source] : [];
      });
    const body = node.find(".tgme_widget_message_text").first().clone();
    body.find("br").replaceWith("\n");
    posts.push(
      Schema.decodeUnknownSync(PostSchema)({
        id,
        url: `https://t.me/${channel}/${id}`,
        date: new Date(date).toISOString(),
        text: body.text().trim(),
        audio: [...new Set(audio)],
        images: [...new Set(images)],
        forwarded: node.find(".tgme_widget_message_forwarded_from").length > 0,
      }),
    );
  });
  if (posts.length === 0)
    throw new Error("No messages found: the channel is unavailable or Telegram changed its markup");
  const beforeText = $("a.tme_messages_more[data-before]").attr("data-before");
  const before = beforeText ? Number(beforeText) : undefined;
  if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) {
    throw new Error("Invalid Telegram pagination cursor");
  }
  return { posts: posts.sort((a, b) => a.id - b.id), before };
}

export class Telegram extends Context.Service<
  Telegram,
  {
    page(before?: number): Effect.Effect<Page, AppError>;
    post(id: number): Effect.Effect<Post, AppError>;
  }
>()("maddyvoice/Telegram") {
  static readonly layer = Layer.effect(
    Telegram,
    Effect.gen(function* () {
      const config = yield* Settings;
      const page = (before?: number) =>
        attempt("Read Telegram feed", async (signal) => {
          const url = new URL(`https://t.me/s/${config.channel}`);
          if (before !== undefined) url.searchParams.set("before", String(before));
          const response = await checkedFetch(url.href, {
            signal,
            headers: { "User-Agent": "maddyvoice/0.1" },
          });
          return parsePage(await response.text(), config.channel);
        });
      const post = Effect.fn("Telegram.post")(function* (id: number) {
        const result = yield* page(id + 1);
        const message = result.posts.find((item) => item.id === id);
        if (!message)
          return yield* new AppError({ message: `Telegram post #${id} is unavailable` });
        return message;
      });
      return Telegram.of({ page, post });
    }),
  );
}
