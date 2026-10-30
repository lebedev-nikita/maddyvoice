import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import OpenAI from "openai";
import { AppError, attempt, safeMessage } from "./core.ts";

export type Effort = "low" | "medium";

export interface ModelRequest {
  readonly prompt: string;
  readonly schema: Record<string, unknown>;
  readonly model?: string;
  readonly effort?: Effort;
  readonly webSearch?: boolean;
}

export const topicModel = Config.String("TOPIC_MODEL").pipe(Config.withDefault("gpt-6.1-sol"));

// Calls models through an OpenAI-compatible CLI proxy (CLIProxyAPI) with the Responses API.
export class ModelProxy extends Context.Service<
  ModelProxy,
  {
    readonly model: string;
    json(request: ModelRequest): Effect.Effect<unknown, AppError>;
  }
>()("maddyvoice/ModelProxy") {
  static readonly layer = Layer.effect(
    ModelProxy,
    Effect.gen(function* () {
      const model = yield* topicModel;
      const baseURL = yield* Config.String("OPENAI_BASE_URL").pipe(
        Config.withDefault("http://127.0.0.1:8317/v1"),
      );
      const apiKey = yield* Config.Redacted("OPENAI_API_KEY");
      const client = new OpenAI({ baseURL, apiKey: Redacted.value(apiKey), maxRetries: 2 });
      const json = Effect.fn("ModelProxy.json")(function* (request: ModelRequest) {
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            client.responses.create(
              {
                model: request.model ?? model,
                input: request.prompt,
                store: false,
                reasoning: { effort: request.effort ?? "low" },
                text: {
                  format: {
                    type: "json_schema",
                    name: "output",
                    strict: true,
                    schema: request.schema,
                  },
                },
                tools: request.webSearch ? [{ type: "web_search" }] : undefined,
              },
              { signal },
            ),
          catch: apiError,
        });
        if (response.status !== "completed")
          return yield* new AppError({
            message: `Model response ${response.status ?? "has no status"}${
              response.incomplete_details?.reason ? `: ${response.incomplete_details.reason}` : ""
            }`,
          });
        return yield* attempt(
          "Decode model JSON",
          async () => JSON.parse(response.output_text) as unknown,
        );
      });
      return ModelProxy.of({ model, json });
    }),
  );
}

function apiError(cause: unknown) {
  if (cause instanceof OpenAI.AuthenticationError)
    return new AppError({ message: "Model proxy rejected the API key; check OPENAI_API_KEY" });
  if (cause instanceof OpenAI.RateLimitError)
    return new AppError({ message: "Model proxy rate or usage limit reached" });
  if (cause instanceof OpenAI.APIError)
    return new AppError({ message: `Model proxy error ${cause.status}: ${safeMessage(cause)}` });
  return new AppError({ message: `Model proxy request failed: ${safeMessage(cause)}` });
}

export const isolatedModel = Effect.gen(function* () {
  const proxy = yield* ModelProxy;
  return Effect.fn("isolatedModel")(
    function* (
      prompt: string,
      schema: Schema.Constraint,
      options: { model?: string; reasoningEffort?: Effort; timeoutMs?: number } = {},
    ) {
      return yield* proxy
        .json({
          prompt,
          schema: Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
            .schema as Record<string, unknown>,
          model: options.model,
          effort: options.reasoningEffort,
        })
        .pipe(Effect.timeout(options.timeoutMs ?? 3 * 60_000));
    },
    Effect.mapError((error) =>
      error instanceof AppError
        ? error
        : new AppError({ message: "Isolated model call timed out" }),
    ),
  );
});
