#!/usr/bin/env bun
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { CodexTopics } from "./codex.ts";
import { CommentTopics } from "./comment-topics.ts";
import { TelegramComments } from "./telegram-comments.ts";
import { commentsReadyAt, TopicRequest } from "./topic.ts";

const runtime = ManagedRuntime.make(
  CodexTopics.layer.pipe(
    Layer.provide(Layer.mergeAll(CommentTopics.layer, TelegramComments.layer)),
    Layer.provide(BunServices.layer),
  ),
);
let busy = false;
async function generateTopic(body: typeof TopicRequest.Type) {
  if (busy) return new Response("A topic is already being generated", { status: 503 });
  busy = true;
  try {
    const topic = await runtime.runPromise(
      CodexTopics.use((service) => service.summarize(body.text, body.source)),
    );
    return Response.json({ topic });
  } catch {
    console.error(
      "Topic failed; check Telegram profile, Codex login, model access and usage limits",
    );
    return new Response("Codex topic generation failed", { status: 502 });
  } finally {
    busy = false;
  }
}
async function acceptTranscript(request: Request) {
  let body: typeof TopicRequest.Type;
  try {
    body = Schema.decodeUnknownSync(TopicRequest)(await request.json());
    commentsReadyAt(body.source.publishedAt);
  } catch {
    return new Response("Invalid transcript", { status: 400 });
  }
  return generateTopic(body);
}
const routes: Record<string, (request: Request) => Promise<Response>> = {
  "GET /health": async () => {
    const model = await runtime.runPromise(
      CodexTopics.use((service) => Effect.succeed(service.model)),
    );
    return Response.json({ ready: true, model });
  },
  "POST /topic": acceptTranscript,
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 11435,
  maxRequestBodySize: 256 * 1024,
  idleTimeout: 255,
  fetch(request, server) {
    const route = routes[`${request.method} ${new URL(request.url).pathname}`];
    if (request.method === "POST" && new URL(request.url).pathname === "/topic")
      server.timeout(request, 0);
    return route ? route(request) : new Response("Not found", { status: 404 });
  },
});
const shutdown = async () => {
  await server.stop(true);
  await runtime.dispose();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
console.log("Codex topic service listening on 127.0.0.1:11435");
