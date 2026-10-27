#!/usr/bin/env bun
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { CodexTopics } from "./codex.ts";
import { Transcript } from "./topic.ts";

const runtime = ManagedRuntime.make(CodexTopics.layer.pipe(Layer.provide(BunServices.layer)));
let busy = false;
async function generateTopic(text: string) {
  if (busy) return new Response("A topic is already being generated", { status: 503 });
  busy = true;
  try {
    const topic = await runtime.runPromise(CodexTopics.use((service) => service.summarize(text)));
    return Response.json({ topic });
  } catch {
    console.error("Codex topic failed; check login, model access and usage limits");
    return new Response("Codex topic generation failed", { status: 502 });
  } finally {
    busy = false;
  }
}
async function acceptTranscript(request: Request) {
  let body: typeof Transcript.Type;
  try {
    body = Schema.decodeUnknownSync(Transcript)(await request.json());
  } catch {
    return new Response("Invalid transcript", { status: 400 });
  }
  return generateTopic(body.text);
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
  fetch(request) {
    const route = routes[`${request.method} ${new URL(request.url).pathname}`];
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
