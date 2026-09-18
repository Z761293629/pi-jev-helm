export const completeRoutes = {
  fast: { provider: "openrouter", model: "fast/model", thinkingLevel: "off" },
  coding: { provider: "anthropic", model: "coding/model", thinkingLevel: "high" },
  reasoning: { provider: "openai", model: "reasoning/model", thinkingLevel: "xhigh" },
  research: { provider: "google", model: "research/model", thinkingLevel: "medium" },
};

export function restoreAgentDirectory(originalAgentDir: string | undefined): void {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
}
