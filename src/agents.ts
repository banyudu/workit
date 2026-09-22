import { randomInt } from "node:crypto";
import type {
  AgentDefinition,
  TimeWeightRule,
  WeightedDefinition,
  WorkitConfig,
} from "./types.js";

/** Lookahead applied when an entry declares `timeWeights` but no `horizon`. */
export const DEFAULT_HORIZON_MINUTES = 60;

const MINUTES_PER_DAY = 1440;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const UNIT_MINUTES: Record<string, number> = { d: MINUTES_PER_DAY, h: 60, m: 1, s: 1 / 60 };

/**
 * Parse "60m", "1h30m", "0m" or a bare number of minutes into whole minutes,
 * rounding up so a partial minute never shortens a conservative lookahead.
 */
export function parseDurationMinutes(value: string | number, label: string): number {
  const text = String(value).trim().toLowerCase();
  const invalid = () =>
    new Error(`${label} must be a duration like '60m', '1h30m' or '0m', got '${String(value)}'`);
  if (!text) throw invalid();
  const token = /(\d+(?:\.\d+)?)(d|h|m|s)?/y;
  let minutes = 0;
  let cursor = 0;
  while (cursor < text.length) {
    token.lastIndex = cursor;
    const match = token.exec(text);
    if (!match) throw invalid();
    minutes += Number(match[1]) * UNIT_MINUTES[match[2] ?? "m"];
    cursor = token.lastIndex;
  }
  return Math.ceil(minutes);
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string, label: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(tz);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    throw new Error(`${label} has an unknown time zone '${tz}'`);
  }
  formatterCache.set(tz, formatter);
  return formatter;
}

/**
 * Wall-clock minutes since the civil epoch in `tz`. Two instants map onto a
 * contiguous local range, so a DST shift widens or narrows the local span
 * exactly the way the wall clock experienced it.
 */
function localMinutes(instant: Date, tz: string, label: string): number {
  const parts = formatterFor(tz, label).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  // Some ICU builds render midnight as hour 24 under hour12:false.
  return (
    Date.UTC(read("year"), read("month") - 1, read("day"), read("hour") % 24, read("minute")) /
    60_000
  );
}

interface DayRange {
  start: number;
  end: number;
}

function parseRange(text: string, label: string): DayRange {
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!match) {
    throw new Error(`${label} must look like '09:00-12:00', got '${String(text)}'`);
  }
  const minuteOfDay = (hour: number, minute: number): number => {
    if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) {
      throw new Error(`${label} has an out-of-range time in '${String(text)}'`);
    }
    return hour * 60 + minute;
  };
  const start = minuteOfDay(Number(match[1]), Number(match[2]));
  const end = minuteOfDay(Number(match[3]), Number(match[4]));
  if (start === end) {
    throw new Error(`${label} must span a non-empty window, got '${String(text)}'`);
  }
  // An end at or before the start wraps past midnight, e.g. "22:00-02:00".
  return { start, end: end < start ? end + MINUTES_PER_DAY : end };
}

function allowedWeekdays(rule: TimeWeightRule, label: string): Set<number> | undefined {
  const { weekdays } = rule;
  if (weekdays === undefined) return undefined;
  if (!Array.isArray(weekdays) || weekdays.length === 0) {
    throw new Error(`${label} weekdays must be a non-empty list like [mon, tue]`);
  }
  const days = new Set<number>();
  for (const day of weekdays) {
    const key = String(day).trim().slice(0, 3).toLowerCase() as (typeof WEEKDAYS)[number];
    const index = WEEKDAYS.indexOf(key);
    if (index < 0) throw new Error(`${label} has an unknown weekday '${String(day)}'; expected mon..sun`);
    days.add(index);
  }
  return days;
}

function rangesOf(rule: TimeWeightRule, label: string): DayRange[] {
  const { ranges } = rule;
  if (ranges === undefined) return [{ start: 0, end: MINUTES_PER_DAY }];
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new Error(`${label} ranges must be a non-empty list like ['09:00-12:00']`);
  }
  return ranges.map((range) => parseRange(range, label));
}

/**
 * True when `[now, now + horizon + bufferBefore]` overlaps any window the rule
 * describes, read in the rule's own time zone. Deliberately conservative: a
 * session that would merely bleed into the window already counts as inside it.
 */
function ruleApplies(
  rule: TimeWeightRule,
  now: Date,
  horizonMinutes: number,
  label: string,
): boolean {
  const tz = rule.tz ?? "UTC";
  const buffer =
    rule.bufferBefore === undefined
      ? 0
      : parseDurationMinutes(rule.bufferBefore, `${label} bufferBefore`);
  const days = allowedWeekdays(rule, label);
  const ranges = rangesOf(rule, label);

  // Nine days of lookahead covers seven whole local days even across a DST
  // shift, so every weekday and every minute of the day is traversed and the
  // rule necessarily matches. Bailing out here also keeps a typo'd horizon
  // from turning the day loop below into a hang.
  const spanMinutes = horizonMinutes + buffer;
  if (spanMinutes >= 9 * MINUTES_PER_DAY) return true;

  const start = localMinutes(now, tz, label);
  const end = localMinutes(new Date(now.getTime() + spanMinutes * 60_000), tz, label);

  // A wrapped window can open on the day before the one the check starts in.
  const firstDay = Math.floor(start / MINUTES_PER_DAY) - 1;
  const lastDay = Math.floor(end / MINUTES_PER_DAY);
  for (let day = firstDay; day <= lastDay; day += 1) {
    const dayStart = day * MINUTES_PER_DAY;
    if (days && !days.has(new Date(dayStart * 60_000).getUTCDay())) continue;
    for (const range of ranges) {
      // Windows are half-open, so 12:00 already reads as off-peak; the check
      // interval is closed, so touching a window's opening minute counts.
      if (start < dayStart + range.end && end >= dayStart + range.start) return true;
    }
  }
  return false;
}

function describeRule(rule: TimeWeightRule, horizonMinutes: number): string {
  const ranges = (rule.ranges ?? ["00:00-24:00"]).join(",");
  const days = rule.weekdays?.length ? ` ${rule.weekdays.join("/")}` : "";
  // A declared-but-zero buffer (the common "bufferBefore: 0m") adds no signal.
  const bufferMinutes =
    rule.bufferBefore === undefined ? 0 : parseDurationMinutes(rule.bufferBefore, "bufferBefore");
  const buffer = bufferMinutes > 0 ? ` +${bufferMinutes}m buffer` : "";
  return `${ranges}${days} ${rule.tz ?? "UTC"} within ${horizonMinutes}m horizon${buffer}`;
}

export interface WeightExplanation {
  /** Static weight from the config. */
  base: number;
  /** Weight actually used for sampling at the evaluated instant. */
  weight: number;
  /** The rule that took effect, if any. */
  rule?: TimeWeightRule;
  /** Human-readable reason, shown by --verbose and `workit agents`. */
  reason: string;
}

/** Resolve a definition's weight at `now`, explaining which rule decided it. */
export function explainWeight(
  definition: WeightedDefinition,
  now: Date = new Date(),
  name = "agent",
): WeightExplanation {
  const base = definition.weight ?? 0;
  const rules = definition.timeWeights;
  if (!rules?.length) return { base, weight: base, reason: "static weight" };

  const label = `Agent '${name}'`;
  const horizonMinutes =
    definition.horizon === undefined
      ? DEFAULT_HORIZON_MINUTES
      : parseDurationMinutes(definition.horizon, `${label} horizon`);

  for (const rule of rules) {
    if (!ruleApplies(rule, now, horizonMinutes, label)) continue;
    return { base, weight: rule.weight, rule, reason: describeRule(rule, horizonMinutes) };
  }
  return { base, weight: base, reason: `no window within ${horizonMinutes}m horizon` };
}

/** The weight `chooseAgent` samples on at `now`. Equals `weight` when no rules apply. */
export function effectiveWeight(
  definition: WeightedDefinition,
  now: Date = new Date(),
  name = "agent",
): number {
  return explainWeight(definition, now, name).weight;
}

/** Validate `horizon` and `timeWeights` up front so a bad registry fails loudly. */
export function validateTimeWeights(name: string, definition: WeightedDefinition): void {
  const label = `Agent '${name}'`;
  if (definition.horizon !== undefined) {
    parseDurationMinutes(definition.horizon, `${label} horizon`);
  }
  const rules = definition.timeWeights;
  if (rules === undefined) return;
  if (!Array.isArray(rules)) {
    throw new Error(`${label} timeWeights must be a list of rules`);
  }
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") {
      throw new Error(`${label} has an invalid timeWeights entry`);
    }
    if (!Number.isSafeInteger(rule.weight) || rule.weight < 0) {
      throw new Error(
        `${label} timeWeights weight '${String(rule.weight)}' must be a non-negative integer`,
      );
    }
    if (rule.tz !== undefined) formatterFor(rule.tz, label);
    if (rule.bufferBefore !== undefined) {
      parseDurationMinutes(rule.bufferBefore, `${label} bufferBefore`);
    }
    allowedWeekdays(rule, label);
    rangesOf(rule, label);
  }
}

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
    validateTimeWeights(name, definition);
  }
}

/** One `name  weight=base→effective  reason` line per agent, for --verbose. */
export function describeEffectiveWeights(
  agents: Record<string, AgentDefinition>,
  now: Date = new Date(),
): string[] {
  return Object.entries(agents).map(([name, definition]) => {
    const { base, weight, reason } = explainWeight(definition, now, name);
    const shown = weight === base ? String(weight) : `${base}→${weight}`;
    return `  ${name}  weight=${shown}  ${reason}`;
  });
}

export function chooseAgent(
  config: WorkitConfig,
  explicit?: string,
  random: (max: number) => number = randomInt,
  aliasIndex: Record<string, string> = {},
  now: Date = new Date(),
  allowFallback = false,
): { name: string; definition: AgentDefinition } {
  const agents = config.agents ?? {};
  validateAgents(config);

  const requested = explicit ?? undefined;
  if (requested) {
    const name = aliasIndex[requested] ?? requested;
    const definition = agents[name];
    if (definition) return { name, definition };
    if (!allowFallback) {
      throw new Error(`Agent '${requested}' is not configured`);
    }
    // --allow-fallback: treat the unusable name as no input and fall
    // through to the weighted pool.
    console.error(`workit: agent '${requested}' is not configured; ignoring and selecting from the weighted pool`);
  }

  const weighted = Object.entries(agents)
    .map(
      ([name, definition]) =>
        [name, definition, effectiveWeight(definition, now, name)] as const,
    )
    .filter(([, , weight]) => weight > 0);
  if (weighted.length === 0) {
    const fallback = config.default ?? Object.keys(agents)[0];
    if (!fallback || !agents[fallback]) {
      throw new Error("No agent is configured; add agents and a default agent");
    }
    return { name: fallback, definition: agents[fallback] };
  }

  const total = weighted.reduce((sum, [, , weight]) => sum + weight, 0);
  const selected = random(total);
  let cursor = 0;
  for (const [name, definition, weight] of weighted) {
    cursor += weight;
    if (selected < cursor) return { name, definition };
  }

  throw new Error("Unable to select an agent");
}
