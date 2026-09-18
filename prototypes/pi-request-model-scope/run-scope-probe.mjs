#!/usr/bin/env node
/** PROTOTYPE — executable RPC harness for scope-probe.ts. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const tempDir = mkdtempSync(join(tmpdir(), "pi-request-model-scope-"));
const logPath = join(tempDir, "events.jsonl");
const extensionPath = join(here, "scope-probe.ts");

const child = spawn(
	"pi",
	[
		"--mode",
		"rpc",
		"--no-session",
		"--provider",
		"scope-probe",
		"--model",
		"baseline",
		"--extension",
		extensionPath,
	],
	{
		cwd: join(here, "../.."),
		env: { ...process.env, PI_SCOPE_PROBE_LOG: logPath },
		stdio: ["pipe", "pipe", "pipe"],
	},
);

let stdoutBuffer = "";
let stderr = "";
const queuedEvents = [];
const waitingReaders = [];

function deliver(event) {
	const reader = waitingReaders.shift();
	if (reader) reader.resolve(event);
	else queuedEvents.push(event);
}

child.stdout.on("data", (chunk) => {
	stdoutBuffer += chunk.toString("utf8");
	while (true) {
		const newline = stdoutBuffer.indexOf("\n");
		if (newline < 0) break;
		const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
		stdoutBuffer = stdoutBuffer.slice(newline + 1);
		if (!line) continue;
		try {
			deliver(JSON.parse(line));
		} catch (error) {
			throw new Error(`Invalid RPC JSON: ${line}\n${error}`);
		}
	}
});
child.stderr.on("data", (chunk) => {
	stderr += chunk.toString("utf8");
});

function nextEvent(timeoutMs = 10_000) {
	if (queuedEvents.length > 0) return Promise.resolve(queuedEvents.shift());
	return new Promise((resolve, reject) => {
		const reader = {
			resolve(event) {
				clearTimeout(timer);
				resolve(event);
			},
		};
		const timer = setTimeout(() => {
			const index = waitingReaders.indexOf(reader);
			if (index >= 0) waitingReaders.splice(index, 1);
			reject(new Error(`Timed out waiting for RPC event. stderr:\n${stderr}`));
		}, timeoutMs);
		waitingReaders.push(reader);
	});
}

function send(command) {
	child.stdin.write(`${JSON.stringify(command)}\n`);
}

let requestSequence = 0;
async function command(command) {
	const id = `command-${++requestSequence}`;
	send({ ...command, id });
	while (true) {
		const event = await nextEvent();
		if (event.type === "response" && event.id === id) {
			if (!event.success) throw new Error(`${event.command} failed: ${event.error}`);
			return event.data;
		}
	}
}

async function runPrompt(message, followUp) {
	const id = `prompt-${++requestSequence}`;
	send({ id, type: "prompt", message });
	let followUpSent = false;
	while (true) {
		const event = await nextEvent();
		if (event.type === "response" && event.id === id && !event.success) {
			throw new Error(`Prompt failed: ${event.error}`);
		}
		if (event.type === "agent_start" && followUp && !followUpSent) {
			followUpSent = true;
			// Use the normal prompt entry point with streamingBehavior so the
			// extension's input hook observes the queued message.
			send({ type: "prompt", message: followUp, streamingBehavior: "followUp" });
		}
		if (event.type === "agent_settled") return;
	}
}

function check(condition, success, failure) {
	if (!condition) throw new Error(`FAIL: ${failure}`);
	console.log(`PASS: ${success}`);
}

try {
	await runPrompt("[route] first idle request");
	const afterRouted = await command({ type: "get_state" });

	await runPrompt("second idle request");
	const afterSecond = await command({ type: "get_state" });

	await runPrompt("[route] request with queued continuation", "queued follow-up");
	const afterQueued = await command({ type: "get_state" });

	child.kill("SIGTERM");
	await new Promise((resolve) => child.once("exit", resolve));

	const events = readFileSync(logPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const providerRequests = events.filter((event) => event.event === "provider_request");
	const beforeStarts = events.filter((event) => event.event === "before_agent_start");
	const queuedInput = events.find(
		(event) => event.event === "input" && event.streamingBehavior === "followUp",
	);

	check(
		providerRequests[0]?.model === "scope-probe/routed",
		"the routed model served the first idle request",
		`first provider request used ${providerRequests[0]?.model ?? "nothing"}`,
	);
	check(
		afterRouted?.model?.id === "baseline",
		"agent_settled restored the baseline model",
		`state after routed request was ${afterRouted?.model?.id ?? "none"}`,
	);
	check(
		providerRequests[1]?.model === "scope-probe/baseline" && afterSecond?.model?.id === "baseline",
		"the next idle request was not polluted",
		`second provider request/state was ${providerRequests[1]?.model}/${afterSecond?.model?.id}`,
	);
	check(
		providerRequests[2]?.model === "scope-probe/routed" &&
			providerRequests[3]?.model === "scope-probe/routed",
		"a queued follow-up inherits the routed model (documented limitation reproduced)",
		`queued run models were ${providerRequests.slice(2).map((event) => event.model).join(", ")}`,
	);
	check(
		Boolean(queuedInput) && beforeStarts.length === 3 && providerRequests.length === 4,
		"queued input emitted input but no independent before_agent_start boundary",
		`queued input=${Boolean(queuedInput)}, before_agent_start=${beforeStarts.length}, provider requests=${providerRequests.length}`,
	);
	check(
		afterQueued?.model?.id === "baseline",
		"the baseline was restored after the routed run and its queued continuation settled",
		`final state was ${afterQueued?.model?.id ?? "none"}`,
	);

	console.log("\nVERDICT");
	console.log("Public Pi APIs support an idle-run scope: switch before the run, keep the model through continuations, then restore at agent_settled.");
	console.log("They do not provide strict per-message isolation: follow-up input queued during the run inherits the routed model.");
	console.log(`Event log: ${logPath}`);
} catch (error) {
	child.kill("SIGTERM");
	console.error(error instanceof Error ? error.stack : error);
	if (stderr) console.error(`\npi stderr:\n${stderr}`);
	process.exitCode = 1;
}
