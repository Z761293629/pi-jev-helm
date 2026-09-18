/**
 * PROTOTYPE — throw away after issue #6 is resolved.
 *
 * This extension probes whether Pi's public extension API can route one idle
 * agent run to another model and restore the baseline before the next run.
 */
import { appendFileSync } from "node:fs";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "scope-probe";
const BASELINE_MODEL = "baseline";
const ROUTED_MODEL = "routed";
const LOG_PATH = process.env.PI_SCOPE_PROBE_LOG ?? "/tmp/pi-request-model-scope.jsonl";
const ROUTE_PREFIX = "[route]";

let sequence = 0;

function modelName(model: Model<Api> | undefined): string | null {
	return model ? `${model.provider}/${model.id}` : null;
}

function record(event: string, details: Record<string, unknown> = {}): void {
	appendFileSync(
		LOG_PATH,
		`${JSON.stringify({ sequence: ++sequence, event, ...details })}\n`,
		"utf8",
	);
}

function latestUserText(context: Context): string {
	const user = [...context.messages].reverse().find((message) => message.role === "user");
	if (!user) return "";
	if (typeof user.content === "string") return user.content;
	return user.content
		.filter((part) => part.type === "text")
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n");
}

function streamProbeModel(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
	const stream = createAssistantMessageEventStream();

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const prompt = latestUserText(context);
			record("provider_request", { model: modelName(model), prompt });
			stream.push({ type: "start", partial: output });

			// Keep the provider active long enough for the RPC harness to enqueue a
			// follow-up while the first request is still running.
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, 150);
				options?.signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			});

			const text = `served-by:${model.id}`;
			output.content.push({ type: "text", text });
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
			output.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface RouteSnapshot {
	baselineModel: Model<Api>;
	baselineThinking: ThinkingLevel;
}

export default function scopeProbe(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER, {
		name: "Request-scope probe",
		baseUrl: "http://scope-probe.invalid",
		apiKey: "prototype",
		api: "openai-completions",
		models: [
			{
				id: BASELINE_MODEL,
				name: "Probe baseline",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 16_384,
				maxTokens: 1_024,
			},
			{
				id: ROUTED_MODEL,
				name: "Probe routed",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 16_384,
				maxTokens: 1_024,
			},
		],
		streamSimple: streamProbeModel,
	});

	let route: RouteSnapshot | undefined;

	pi.on("session_start", (_event, ctx) => {
		record("session_start", { model: modelName(ctx.model) });
		ctx.ui.setStatus("scope-probe", `probe baseline: ${ctx.model?.id ?? "none"}`);
	});

	pi.on("input", async (event, ctx) => {
		record("input", {
			text: event.text,
			streamingBehavior: event.streamingBehavior ?? null,
			model: modelName(ctx.model),
		});

		if (event.streamingBehavior) {
			record("queued_input_not_routed", { streamingBehavior: event.streamingBehavior });
			return;
		}
		if (!event.text.startsWith(ROUTE_PREFIX) || route || !ctx.model) return;

		const routedModel = ctx.modelRegistry.find(PROVIDER, ROUTED_MODEL);
		if (!routedModel) throw new Error("Probe routed model is unavailable");

		route = {
			baselineModel: ctx.model,
			baselineThinking: pi.getThinkingLevel(),
		};
		const switched = await pi.setModel(routedModel);
		if (!switched) {
			route = undefined;
			throw new Error("Could not switch to the probe routed model");
		}
		record("route_applied", {
			baseline: modelName(route.baselineModel),
			routed: modelName(routedModel),
		});
		ctx.ui.setStatus("scope-probe", `probe routed: ${routedModel.id}`);
	});

	pi.on("before_agent_start", (event, ctx) => {
		record("before_agent_start", { prompt: event.prompt, model: modelName(ctx.model) });
	});

	pi.on("model_select", (event) => {
		record("model_select", {
			from: modelName(event.previousModel),
			to: modelName(event.model),
			source: event.source,
		});
	});

	pi.on("agent_settled", async (_event, ctx) => {
		record("agent_settled_enter", {
			model: modelName(ctx.model),
			hasPendingMessages: ctx.hasPendingMessages(),
			hasRoute: Boolean(route),
		});
		if (!route) return;

		const snapshot = route;
		const restored = await pi.setModel(snapshot.baselineModel);
		if (restored) pi.setThinkingLevel(snapshot.baselineThinking);
		route = undefined;
		record("route_restored", {
			restored,
			model: modelName(ctx.model),
			thinkingLevel: pi.getThinkingLevel(),
		});
		ctx.ui.setStatus(
			"scope-probe",
			restored ? `probe baseline: ${ctx.model?.id ?? "none"}` : "probe restore failed",
		);
	});
}
