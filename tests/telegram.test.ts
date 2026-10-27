import { describe, expect, it } from "vite-plus/test";
import { parsePage } from "../src/telegram.ts";

const message = (
  content: string,
  id = 42,
) => `<div class="tgme_widget_message" data-post="maddysontg/${id}">
  <a class="tgme_widget_message_date"><time datetime="2026-10-26T02:05:50+00:00"></time></a>${content}</div>`;

describe("public Telegram feed", () => {
  it("reads voice audio, grouped images, captions and original publication time", () => {
    const html =
      `<a class="tme_messages_more" data-before="42"></a>` +
      message(`
      <audio class="tgme_widget_message_voice" src="https://cdn4.telesco.pe/file/a.ogg?token=abc&amp;x=1"></audio>
      <div class="tgme_widget_message_grouped">
        <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn4.cdn-telegram.org/a.jpg')"></a>
        <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn4.cdn-telegram.org/b.jpg')"></a>
      </div>
      <div class="tgme_widget_message_link_preview"><a class="tgme_widget_message_photo_wrap" style="background-image:url('https://bad.example/preview.jpg')"></a></div>
      <div class="tgme_widget_message_text">Hello &amp; friends<br>Second line</div>`);
    const page = parsePage(html, "maddysontg");
    expect(page.before).toBe(42);
    expect(page.posts[0]).toMatchObject({
      id: 42,
      date: "2026-10-26T02:05:50.000Z",
      url: "https://t.me/maddysontg/42",
      text: "Hello & friends\nSecond line",
      forwarded: false,
      audio: ["https://cdn4.telesco.pe/file/a.ogg?token=abc&x=1"],
      images: ["https://cdn4.cdn-telegram.org/a.jpg", "https://cdn4.cdn-telegram.org/b.jpg"],
    });
  });

  it("marks forwarded audio and does not turn videos into voice messages", () => {
    const page = parsePage(
      message(
        '<div class="tgme_widget_message_forwarded_from">Other author</div><audio class="tgme_widget_message_voice" src="https://cdn4.telesco.pe/a.ogg"></audio>',
        3,
      ) + message('<video src="https://cdn4.telesco.pe/video.mp4"></video>', 4),
      "maddysontg",
    );
    expect(page.posts[0]?.forwarded).toBe(true);
    expect(page.posts[1]?.audio).toEqual([]);
  });

  it("fails visibly when voices lose their download source or feed markup changes", () => {
    expect(() =>
      parsePage(message('<div class="tgme_widget_message_voice_player"></div>'), "maddysontg"),
    ).toThrow("no downloadable audio");
    expect(() => parsePage("<html>temporarily unavailable</html>", "maddysontg")).toThrow(
      "No messages",
    );
  });
});
