import { randomInt } from "node:crypto";
import type { AgentDefinition, WorkitConfig } from "./types.js";

export function validateAgents(config: WorkitConfig): void {
  const agents = config.agents ?? {};
  for (const [name, definition] of Object.entries(agents)) {
    const weight = definition.weight ?? 0;
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new Error(
        `Agent '${name}' has invalid weight '${String(weight)}'; expected a non-negative integer`,
      );
    }
    if (!definition.command?.trim()) {
      throw new Error(`Agent '${name}' must define a non-empty command`);
    }
  }
}

export function chooseAgent(
  config: WorkitConfig,
  explicit?: string,
  random: (max: number) => number = randomInt,
): { name: string; definition: AgentDefinition } {
  const agents = config.agents ?? {};
  validateAgents(config);

  const requested = explicit ?? undefined;
  if (requested) {
    const definition = agents[requested];
    if (!definition) {
      throw new Error(`Agent '${requested}' is not configured`);
    }
    return { name: requested, definition };
  }

  const weighted = Object.entries(agents).filter(
    ([, definition]) => (definition.weight ?? 0) > 0,
  );
  if (weighted.length === 0) {
    const fallback = config.default ?? Object.keys(agents)[0];
    if (!fallback || !agents[fallback]) {
      throw new Error("No agent is configured; add agents and a default agent");
    }
    return { name: fallback, definition: agents[fallback] };
  }

  const total = weighted.reduce(
    (sum, [, definition]) => sum + (definition.weight ?? 0),
    0,
  );
  const selected = random(total);
  let cursor = 0;
  for (const [name, definition] of weighted) {
    cursor += definition.weight ?? 0;
    if (selected < cursor) return { name, definition };
  }

  throw new Error("Unable to select an agent");
}
