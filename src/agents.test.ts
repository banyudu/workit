import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chooseAgent,
  effectiveWeight,
  explainWeight,
  parseDurationMinutes,
  validateAgents,
} from "./agents.js";

const config = {
  default: "codex",
  agents: {
    claude: { command: "claude", weight: 3 },
    codex: { command: "codex", weight: 2 },
  },
};

test("zero weights fall back to the configured default", () => {
  const selected = chooseAgent({ default: "codex", agents: { codex: { command: "codex", weight: 0 } } });
  assert.equal(selected.name, "codex");
});

test("weighted selection is independent of the previous choice", () => {
  assert.equal(chooseAgent(config, undefined, () => 0).name, "claude");
  assert.equal(chooseAgent(config, undefined, () => 2).name, "claude");
  assert.equal(chooseAgent(config, undefined, () => 3).name, "codex");
  assert.equal(chooseAgent(config, undefined, () => 4).name, "codex");
});

test("explicit selection resolves aliases to the canonical agent", () => {
  const aliased = {
    default: "codex",
    agents: {
      hy3: { command: "opencode --agent hy3", weight: 0, aliases: ["hy", "hunyuan"] },
    },
  };
  const selected = chooseAgent(aliased, "hy", undefined as never, { hy: "hy3" });
  assert.equal(selected.name, "hy3");
  assert.equal(selected.definition.command, "opencode --agent hy3");
  assert.throws(() => chooseAgent(aliased, "unknown", undefined as never), /not configured/);
});

test("unknown explicit agent falls back only with allowFallback", () => {
  assert.throws(() => chooseAgent(config, "unknown", () => 0), /not configured/);
  assert.equal(chooseAgent(config, "unknown", () => 0, {}, new Date(), true).name, "claude");
  assert.equal(chooseAgent(config, "unknown", () => 3, {}, new Date(), true).name, "codex");
});



test("agentDefinitionsByTag projects tagged registry entries", async () => {
  const { agentDefinitionsByTag } = await import("./config.js");
  const config = {
    codingAgents: {
      agents: {
        muse: { command: "opencode --agent muse-spark", weight: 10, tags: ["daily", "banyan"] },
        claude: { command: "claude", weight: 5, tags: ["coding"] },
        hy3: { command: "opencode --agent hy3", weight: 0, tags: ["daily"] },
        broken: { command: "  ", tags: ["daily"] },
      },
    },
  } as never;
  const daily = agentDefinitionsByTag(config, "daily");
  assert.deepEqual(Object.keys(daily), ["muse", "hy3"]);
  assert.equal(daily.muse.command, "opencode --agent muse-spark");
  assert.equal(daily.hy3.weight, 0);
});

test("headlessPromptCommand converts registry commands for non-interactive runs", async () => {
  const { headlessPromptCommand } = await import("./launch.js");
  assert.equal(
    headlessPromptCommand("opencode --agent muse-spark", "hello world"),
    "opencode run --agent muse-spark 'hello world'",
  );
  assert.equal(
    headlessPromptCommand("opencode run --agent hy3", "hi"),
    "opencode run --agent hy3 'hi'",
  );
  assert.equal(
    headlessPromptCommand("claude --dangerously-skip-permissions --model opus", "do it"),
    "claude -p --dangerously-skip-permissions --model opus 'do it'",
  );
  assert.equal(headlessPromptCommand("claude -p", "q"), "claude -p 'q'");
  assert.equal(
    headlessPromptCommand("codex -p terra --dangerously-bypass-approvals-and-sandbox", "go"),
    "codex exec -p terra --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check 'go'",
  );
  assert.equal(
    headlessPromptCommand("codex exec --skip-git-repo-check", "q"),
    "codex exec --skip-git-repo-check 'q'",
  );
  assert.equal(headlessPromptCommand("someagent --flag", "x"), "someagent --flag 'x'");
});

// ---------------------------------------------------------------------------
// Time-sensitive weights
// ---------------------------------------------------------------------------

/** A dpsk-flash-shaped entry: half price off-peak, 2x during Beijing peak. */
const flash = {
  command: "opencode --agent dpsk-v4-flash",
  weight: 4,
  horizon: "60m",
  timeWeights: [
    {
      tz: "Asia/Shanghai",
      weekdays: ["mon", "tue", "wed", "thu", "fri"],
      ranges: ["09:00-12:00", "14:00-18:00"],
      weight: 1,
      bufferBefore: "0m",
    },
  ],
};

/** 2026-09-14 is a Monday; Beijing is UTC+8 year-round. */
const beijing = (hhmm: string, day = 14): Date => {
  const [hour, minute, second = "00"] = hhmm.split(":");
  const utcHour = Number(hour) - 8;
  return new Date(Date.UTC(2026, 8, day, utcHour, Number(minute), Number(second)));
};

test("a session that would bleed into peak is already priced as peak", () => {
  // 13:59 + 60m horizon reaches 14:59, overlapping the 14:00-18:00 window.
  assert.equal(effectiveWeight(flash, beijing("13:59")), 1);
  assert.equal(beijing("13:59").toISOString(), "2026-09-14T05:59:00.000Z");
});

test("peak windows are half-open, so the minute they close is off-peak", () => {
  assert.equal(effectiveWeight(flash, beijing("12:00:01")), 4);
  assert.equal(effectiveWeight(flash, beijing("12:00:00")), 4);
  assert.equal(effectiveWeight(flash, beijing("11:59:59")), 1);
});

test("starting inside a peak tail stays peak-weighted", () => {
  // 11:59 is inside 09:00-12:00 even though the horizon runs past its close.
  assert.equal(effectiveWeight(flash, beijing("11:59")), 1);
});

test("the check interval is an overlap test, not an endpoint test", () => {
  // 08:00 + 60m lands exactly on the 09:00 opening minute.
  assert.equal(effectiveWeight(flash, beijing("08:00")), 1);
  // 07:59 + 60m stops one minute short.
  assert.equal(effectiveWeight(flash, beijing("07:59")), 4);
  // 12:30 + 60m sits entirely in the lunch gap.
  assert.equal(effectiveWeight(flash, beijing("12:30")), 4);
});

test("bufferBefore widens the lookahead past the horizon", () => {
  const buffered = {
    ...flash,
    timeWeights: [{ ...flash.timeWeights[0], bufferBefore: "30m" }],
  };
  assert.equal(effectiveWeight(flash, beijing("12:45")), 4);
  assert.equal(effectiveWeight(buffered, beijing("12:45")), 1);
});

test("the weekday boundary is read in the vendor time zone, not UTC", () => {
  // Fri 16:00 UTC is already Saturday in Beijing: weekend, so off-peak.
  const fridayEvening = new Date("2026-09-18T16:00:00Z");
  assert.equal(fridayEvening.getUTCDay(), 5);
  assert.equal(effectiveWeight(flash, fridayEvening), 4);
  // One minute earlier is still Friday 23:59 in Beijing, outside every window.
  assert.equal(effectiveWeight(flash, new Date("2026-09-18T15:59:00Z")), 4);
  // Friday 09:30 Beijing is a weekday peak.
  assert.equal(effectiveWeight(flash, beijing("09:30", 18)), 1);
  // Sunday 16:00 UTC is Monday 00:00 Beijing: back on a weekday, still off-peak
  // at midnight, but a 09:00 Monday check is peak again.
  assert.equal(effectiveWeight(flash, new Date("2026-09-20T16:00:00Z")), 4);
  assert.equal(effectiveWeight(flash, beijing("09:00", 21)), 1);
});

test("the horizon defaults to 60m when timeWeights omit it", () => {
  const { horizon, ...noHorizon } = flash;
  assert.equal(effectiveWeight(noHorizon, beijing("13:59")), 1);
  assert.equal(effectiveWeight(noHorizon, beijing("12:30")), 4);
  // An explicit zero horizon checks the current instant only.
  assert.equal(effectiveWeight({ ...flash, horizon: "0m" }, beijing("13:59")), 4);
});

test("ranges may wrap past midnight", () => {
  const overnight = {
    command: "x",
    weight: 5,
    horizon: "0m",
    timeWeights: [{ tz: "Asia/Shanghai", ranges: ["22:00-02:00"], weight: 1 }],
  };
  assert.equal(effectiveWeight(overnight, beijing("23:30")), 1);
  // 01:30 belongs to the window that opened the previous evening.
  assert.equal(effectiveWeight(overnight, beijing("01:30")), 1);
  assert.equal(effectiveWeight(overnight, beijing("03:00")), 5);
});

test("the first matching rule wins", () => {
  const layered = {
    command: "x",
    weight: 9,
    horizon: "0m",
    timeWeights: [
      { tz: "UTC", ranges: ["09:00-10:00"], weight: 1 },
      { tz: "UTC", ranges: ["00:00-24:00"], weight: 5 },
    ],
  };
  assert.equal(effectiveWeight(layered, new Date("2026-09-14T09:30:00Z")), 1);
  assert.equal(effectiveWeight(layered, new Date("2026-09-14T11:30:00Z")), 5);
});

test("explainWeight reports the static weight untouched when no rule applies", () => {
  assert.deepEqual(explainWeight({ weight: 3 }, beijing("09:30")), {
    base: 3,
    weight: 3,
    reason: "static weight",
  });
  const off = explainWeight(flash, beijing("21:00"), "dpsk-flash");
  assert.equal(off.weight, 4);
  assert.equal(off.rule, undefined);
  assert.match(off.reason, /no window within 60m horizon/);
  const peak = explainWeight(flash, beijing("09:30"), "dpsk-flash");
  assert.equal(peak.rule?.weight, 1);
  assert.equal(
    peak.reason,
    "09:00-12:00,14:00-18:00 mon/tue/wed/thu/fri Asia/Shanghai within 60m horizon",
  );
  // A non-zero buffer is spelled out; the common "bufferBefore: 0m" is not.
  const buffered = { ...flash, timeWeights: [{ ...flash.timeWeights[0], bufferBefore: "30m" }] };
  assert.match(explainWeight(buffered, beijing("09:30")).reason, /within 60m horizon \+30m buffer$/);
});

test("chooseAgent samples on effective weights", () => {
  const pool = {
    default: "claude",
    agents: {
      claude: { command: "claude", weight: 2 },
      flash,
    },
  };
  // Off-peak: claude 2 + flash 4, so draws 0..1 pick claude and 2..5 pick flash.
  const offPeak = beijing("21:00");
  assert.equal(chooseAgent(pool, undefined, () => 1, {}, offPeak).name, "claude");
  assert.equal(chooseAgent(pool, undefined, () => 5, {}, offPeak).name, "flash");
  // Peak: claude 2 + flash 1, so only draw 2 reaches flash.
  const peak = beijing("09:30");
  assert.equal(chooseAgent(pool, undefined, () => 1, {}, peak).name, "claude");
  assert.equal(chooseAgent(pool, undefined, () => 2, {}, peak).name, "flash");
});

test("an effective weight of zero drops the agent from the pool", () => {
  const pool = {
    default: "claude",
    agents: {
      claude: { command: "claude", weight: 1 },
      flash: { ...flash, timeWeights: [{ ...flash.timeWeights[0], weight: 0 }] },
    },
  };
  const peak = beijing("09:30");
  assert.equal(chooseAgent(pool, undefined, () => 0, {}, peak).name, "claude");
  // The whole pool zeroing out still falls back to the configured default.
  const onlyFlash = { default: "flash", agents: { flash: pool.agents.flash } };
  assert.equal(chooseAgent(onlyFlash, undefined, () => 0, {}, peak).name, "flash");
});

test("static weight configs behave exactly as before when no rules are present", () => {
  const now = beijing("09:30");
  assert.equal(chooseAgent(config, undefined, () => 0, {}, now).name, "claude");
  assert.equal(chooseAgent(config, undefined, () => 2, {}, now).name, "claude");
  assert.equal(chooseAgent(config, undefined, () => 3, {}, now).name, "codex");
  assert.equal(chooseAgent(config, undefined, () => 4, {}, now).name, "codex");
});

test("parseDurationMinutes accepts compound and bare values", () => {
  assert.equal(parseDurationMinutes("60m", "x"), 60);
  assert.equal(parseDurationMinutes("1h30m", "x"), 90);
  assert.equal(parseDurationMinutes("2h", "x"), 120);
  assert.equal(parseDurationMinutes("0m", "x"), 0);
  assert.equal(parseDurationMinutes(45, "x"), 45);
  assert.equal(parseDurationMinutes("1d", "x"), 1440);
  // Sub-minute values round up so a lookahead is never silently shortened.
  assert.equal(parseDurationMinutes("90s", "x"), 2);
  for (const bad of ["", "soon", "-5m", "1h m", "5x"]) {
    assert.throws(() => parseDurationMinutes(bad, "horizon"), /horizon must be a duration/);
  }
});

test("invalid time rules are rejected with the offending agent named", () => {
  const invalid = (timeWeights: unknown, extra: Record<string, unknown> = {}) =>
    () =>
      validateAgents({
        agents: { flash: { command: "x", weight: 1, ...extra, timeWeights } },
      } as never);

  assert.throws(invalid([{ tz: "Mars/Olympus", weight: 1 }]), /unknown time zone 'Mars\/Olympus'/);
  assert.throws(invalid([{ ranges: ["9-12"], weight: 1 }]), /must look like '09:00-12:00'/);
  assert.throws(invalid([{ ranges: ["25:00-26:00"], weight: 1 }]), /out-of-range time/);
  assert.throws(invalid([{ ranges: ["09:00-09:00"], weight: 1 }]), /non-empty window/);
  assert.throws(invalid([{ ranges: [], weight: 1 }]), /ranges must be a non-empty list/);
  assert.throws(invalid([{ weekdays: ["funday"], weight: 1 }]), /unknown weekday 'funday'/);
  assert.throws(invalid([{ weekdays: [], weight: 1 }]), /weekdays must be a non-empty list/);
  assert.throws(invalid([{ weight: -1 }]), /must be a non-negative integer/);
  assert.throws(invalid([{ weight: 1.5 }]), /must be a non-negative integer/);
  assert.throws(invalid([{}]), /must be a non-negative integer/);
  assert.throws(invalid("nope"), /timeWeights must be a list of rules/);
  assert.throws(invalid([null]), /invalid timeWeights entry/);
  assert.throws(invalid([{ weight: 1 }], { horizon: "later" }), /horizon must be a duration/);
  assert.throws(
    invalid([{ weight: 1, bufferBefore: "soon" }]),
    /bufferBefore must be a duration/,
  );
  // Weekday spellings are forgiving.
  validateAgents({
    agents: { flash: { command: "x", weight: 1, timeWeights: [{ weekdays: ["Monday", "TUE"], weight: 1 }] } },
  } as never);
});

test("registry projection carries horizon and timeWeights into the agent pool", async () => {
  const { agentDefinitionsByTag } = await import("./config.js");
  const registry = {
    codingAgents: {
      agents: {
        flash: {
          command: "opencode --agent dpsk-v4-flash",
          weight: 4,
          horizon: "60m",
          tags: ["coding"],
          timeWeights: [
            { tz: "Asia/Shanghai", weekdays: ["mon"], ranges: ["09:00-12:00"], weight: 1 },
          ],
        },
        plain: { command: "claude", weight: 3, tags: ["coding"] },
      },
    },
  } as never;
  const pool = agentDefinitionsByTag(registry, "coding");
  assert.equal(pool.flash.horizon, "60m");
  assert.equal(pool.flash.timeWeights?.[0].weight, 1);
  assert.equal(effectiveWeight(pool.flash, beijing("09:30")), 1);
  assert.equal(effectiveWeight(pool.flash, beijing("21:00")), 4);
  // An entry without rules keeps neither key, so its weight stays static.
  assert.equal("timeWeights" in pool.plain, false);
  assert.equal("horizon" in pool.plain, false);
  assert.equal(effectiveWeight(pool.plain, beijing("09:30")), 3);
});

test("a horizon of more than a week matches every rule without walking the days", () => {
  const narrow = {
    command: "x",
    weight: 5,
    timeWeights: [{ tz: "Asia/Shanghai", weekdays: ["sun"], ranges: ["03:00-03:01"], weight: 1 }],
  };
  // A week-plus lookahead necessarily meets the window, whenever it starts.
  assert.equal(effectiveWeight({ ...narrow, horizon: "10d" }, beijing("09:30")), 1);
  // And a nonsense horizon resolves instead of looping over a million days.
  const started = Date.now();
  assert.equal(effectiveWeight({ ...narrow, horizon: 999_999_999 }, beijing("09:30")), 1);
  assert.ok(Date.now() - started < 1000);
});
