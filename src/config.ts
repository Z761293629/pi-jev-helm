import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const HELM_CONFIG_FILE = "pi-jev-helm.json";
export const DEFAULT_AUTOMATIC_ROUTING = true;
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;

export const ROUTES = ["fast", "coding", "reasoning", "research"] as const;
export type Route = (typeof ROUTES)[number];

/**
 * The Jev Clients a Classification Provider Selection can name, in the order
 * the parse error reports them (CONTEXT.md: Classification Provider Selection).
 */
export const CLASSIFICATION_PROVIDERS = ["openrouter", "typesafe"] as const;
export type ClassificationProviderSelection = (typeof CLASSIFICATION_PROVIDERS)[number];
export const DEFAULT_CLASSIFICATION_PROVIDER: ClassificationProviderSelection = "openrouter";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface RouteTarget {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

export interface HelmConfigV1 {
  schemaVersion: 1;
  automaticRouting: boolean;
  classificationProvider: ClassificationProviderSelection;
  confidenceThreshold: number;
  routes: Record<Route, RouteTarget>;
}

export type ConfigParseResult =
  | { ok: true; config: HelmConfigV1 }
  | { ok: false; errors: string[] };

export type ConfigLoadResult =
  | { ok: true; path: string; config: HelmConfigV1 }
  | { ok: false; path: string; errors: string[] };

const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "automaticRouting",
  "classificationProvider",
  "confidenceThreshold",
  "routes",
] as const;
const TARGET_KEYS = ["provider", "model", "thinkingLevel"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reportUnexpectedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  location: string,
  errors: string[],
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value).filter((candidate) => !allowed.has(candidate)).sort()) {
    errors.push(`${location} contains unsupported field ${JSON.stringify(key)}`);
  }
}

function parseRouteTarget(route: Route, value: unknown, errors: string[]): RouteTarget | undefined {
  const location = `routes.${route}`;
  if (!isObject(value)) {
    errors.push(`${location} must be a Route Target object`);
    return undefined;
  }

  reportUnexpectedKeys(value, TARGET_KEYS, location, errors);

  if (typeof value.provider !== "string" || value.provider.trim().length === 0) {
    errors.push(`${location}.provider must be a non-empty string`);
  }
  if (typeof value.model !== "string" || value.model.trim().length === 0) {
    errors.push(`${location}.model must be a non-empty string`);
  }
  if (typeof value.thinkingLevel !== "string" || !THINKING_LEVELS.includes(value.thinkingLevel as ThinkingLevel)) {
    errors.push(`${location}.thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`);
  }

  if (
    typeof value.provider !== "string" ||
    value.provider.trim().length === 0 ||
    typeof value.model !== "string" ||
    value.model.trim().length === 0 ||
    typeof value.thinkingLevel !== "string" ||
    !THINKING_LEVELS.includes(value.thinkingLevel as ThinkingLevel)
  ) {
    return undefined;
  }

  return {
    provider: value.provider,
    model: value.model,
    thinkingLevel: value.thinkingLevel as ThinkingLevel,
  };
}

export function parseHelmConfig(value: unknown): ConfigParseResult {
  if (!isObject(value)) {
    return { ok: false, errors: ["configuration must be a JSON object"] };
  }

  const errors: string[] = [];
  reportUnexpectedKeys(value, TOP_LEVEL_KEYS, "configuration", errors);

  if (value.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }

  if (value.automaticRouting !== undefined && typeof value.automaticRouting !== "boolean") {
    errors.push("automaticRouting must be a boolean");
  }

  if (
    value.classificationProvider !== undefined &&
    !CLASSIFICATION_PROVIDERS.includes(value.classificationProvider as ClassificationProviderSelection)
  ) {
    errors.push(`classificationProvider must be one of ${CLASSIFICATION_PROVIDERS.join(", ")}`);
  }

  if (
    value.confidenceThreshold !== undefined &&
    (typeof value.confidenceThreshold !== "number" ||
      !Number.isFinite(value.confidenceThreshold) ||
      value.confidenceThreshold < 0 ||
      value.confidenceThreshold > 1)
  ) {
    errors.push("confidenceThreshold must be a finite number between 0 and 1");
  }

  const parsedTargets = new Map<Route, RouteTarget>();
  if (!isObject(value.routes)) {
    errors.push("routes must be an object containing every standard Route");
  } else {
    reportUnexpectedKeys(value.routes, ROUTES, "routes", errors);
    for (const route of ROUTES) {
      if (!Object.hasOwn(value.routes, route)) {
        errors.push(`routes.${route} is required`);
        continue;
      }
      const target = parseRouteTarget(route, value.routes[route], errors);
      if (target) parsedTargets.set(route, target);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    config: {
      schemaVersion: 1,
      automaticRouting: (value.automaticRouting as boolean | undefined) ?? DEFAULT_AUTOMATIC_ROUTING,
      classificationProvider:
        (value.classificationProvider as ClassificationProviderSelection | undefined) ??
        DEFAULT_CLASSIFICATION_PROVIDER,
      confidenceThreshold:
        (value.confidenceThreshold as number | undefined) ?? DEFAULT_CONFIDENCE_THRESHOLD,
      routes: {
        fast: parsedTargets.get("fast")!,
        coding: parsedTargets.get("coding")!,
        reasoning: parsedTargets.get("reasoning")!,
        research: parsedTargets.get("research")!,
      },
    },
  };
}

export async function loadHelmConfig(): Promise<ConfigLoadResult> {
  const path = join(getAgentDir(), HELM_CONFIG_FILE);
  let source: string;

  try {
    source = await readFile(path, "utf8");
  } catch {
    return { ok: false, path, errors: ["configuration file could not be read"] };
  }

  let value: unknown;
  try {
    value = JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch {
    return { ok: false, path, errors: ["configuration file is not valid JSON"] };
  }

  const parsed = parseHelmConfig(value);
  return parsed.ok
    ? { ok: true, path, config: parsed.config }
    : { ok: false, path, errors: parsed.errors };
}
