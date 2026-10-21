import { execFileSync } from "node:child_process";
import type {
  Backend,
  IssueDetails,
  ProviderMode,
  WorkitConfig,
} from "./types.js";

export function normalizeIdentifier(raw: string): string {
  return raw.trim().replace(/^#/, "");
}

export function inferBackend(
  raw: string,
  configured: ProviderMode | undefined = "auto",
): Backend {
  if (configured && configured !== "auto") return configured;

  const identifier = normalizeIdentifier(raw);
  if (/^\d+$/.test(identifier)) return "github";
  if (/^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+$/.test(identifier)) {
    return "linear";
  }
  throw new Error(
    `Cannot infer issue provider from '${raw}'. Use --linear, --github, or provider: auto with a numeric GitHub issue or PROJECT-123 identifier.`,
  );
}

export function issueNumber(identifier: string): number {
  const normalized = normalizeIdentifier(identifier);
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`GitHub issue '${identifier}' must be a number`);
  }
  const number = Number(normalized);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`Invalid GitHub issue number '${identifier}'`);
  }
  return number;
}

export function slugify(value: string, maxLength = 50): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "issue";
}

function commandJson(
  command: string,
  args: string[],
  cwd: string,
): unknown {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", CLICOLOR: "0" };
    delete env.CLICOLOR_FORCE; delete env.FORCE_COLOR; delete env.GH_FORCE_TTY;
    const output = execFileSync(command, args, {
      env,
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(output);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to fetch issue metadata with ${command}: ${detail}`);
  }
}

/** Run a mutating CLI command whose success output is human text, not JSON. */
function commandQuiet(command: string, args: string[], cwd: string): void {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", CLICOLOR: "0" };
    delete env.CLICOLOR_FORCE; delete env.FORCE_COLOR; delete env.GH_FORCE_TTY;
    execFileSync(command, args, { env, cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to update the issue with ${command}: ${detail}`);
  }
}

export function fetchGithubIssue(
  identifier: string,
  config: WorkitConfig,
  cwd: string,
): IssueDetails {
  const number = issueNumber(identifier);
  const args = ["issue", "view", String(number), "--json", "title,body,labels,url,state"];
  const repo = config.repo ?? config.github?.repo;
  if (repo) args.push("--repo", repo);
  const value = commandJson("gh", args, cwd) as {
    state?: string;
    title?: string;
    body?: string;
    labels?: Array<{ name?: string }>;
    url?: string;
  };
  if (!value.title || !value.url) {
    throw new Error(`GitHub returned incomplete metadata for issue #${number}`);
  }
  return {
    backend: "github",
    identifier: String(number),
    number,
    ...(value.state ? { state: value.state } : {}),
    title: value.title,
    body: value.body || "No description provided.",
    labels: (value.labels ?? []).map((label) => label.name).filter(Boolean) as string[],
    url: value.url,
  };
}

async function linearApi(
  config: WorkitConfig,
  query: string,
  variables?: Record<string, unknown>,
): Promise<any> {
  const apiUrl = config.linear?.apiUrl ?? "https://api.linear.app/graphql";
  const token = process.env.LINEAR_API_KEY;
  if (!token) return undefined;
  const response = await fetch(apiUrl, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      authorization: token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Linear API returned HTTP ${response.status}`);
  const payload = (await response.json()) as { data?: any; errors?: Array<{ message?: string }> };
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).filter(Boolean).join("; "));
  }
  return payload.data;
}

export interface LinearWorkflowState { id: string; name: string; type: string; position: number; archivedAt?: string | null }
export interface TrackerIssue extends IssueDetails {
  linear?: { id: string; teamID: string; stateID: string; updatedAt: string; completedStateID?: string;
    archivedAt?: string | null; snoozedUntilAt?: string | null };
}

export function completedLinearState(states: LinearWorkflowState[], current: LinearWorkflowState): string | undefined {
  if (current.type === "completed") return current.id;
  return states.filter(state => state.type === "completed" && !state.archivedAt)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))[0]?.id;
}

/** Closeout uses the public API directly so revision/workflow metadata is never lost in CLI formatting. */
export async function fetchLinearCloseoutIssue(identifier: string, config: WorkitConfig): Promise<TrackerIssue> {
  if (!process.env.LINEAR_API_KEY) throw new Error("Linear closeout requires LINEAR_API_KEY for the supported GraphQL API");
  const data = await linearApi(config, `query CloseoutIssue($id: String!) {
    issue(id: $id) { id identifier title description url updatedAt archivedAt snoozedUntilAt
      state { id name type position }
      labels(first: 250) { nodes { name } pageInfo { hasNextPage } }
      team { id states(first: 250) { nodes { id name type position archivedAt } pageInfo { hasNextPage } } }
    }
  }`, { id: identifier });
  const issue = data?.issue;
  if (!issue?.id || !issue.identifier || !issue.title || !issue.url || !issue.updatedAt || !issue.state?.id ||
      !issue.state.type || !issue.team?.id || !Array.isArray(issue.team.states?.nodes) ||
      !Array.isArray(issue.labels?.nodes) || issue.labels.pageInfo?.hasNextPage !== false ||
      issue.team.states.pageInfo?.hasNextPage !== false) throw new Error("Linear closeout metadata is incomplete; cannot resolve current workflow/holds");
  return { backend: "linear", identifier: issue.identifier, title: issue.title, body: issue.description ?? "",
    url: issue.url, labels: issue.labels.nodes.map((label: { name: string }) => label.name),
    state: issue.state.name, stateType: issue.state.type,
    linear: { id: issue.id, teamID: issue.team.id, stateID: issue.state.id, updatedAt: issue.updatedAt,
      completedStateID: completedLinearState(issue.team.states.nodes, issue.state),
      archivedAt: issue.archivedAt, snoozedUntilAt: issue.snoozedUntilAt } };
}

export async function updateLinearCloseoutIssue(config: WorkitConfig, id: string, input: { description?: string; stateId?: string }): Promise<void> {
  if (!process.env.LINEAR_API_KEY) throw new Error("Linear closeout requires LINEAR_API_KEY");
  const data = await linearApi(config, `mutation CloseoutUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success }
  }`, { id, input });
  if (data?.issueUpdate?.success !== true) throw new Error("Linear did not acknowledge the closeout mutation; reconcile by readback before retrying");
}

function linearProject(value: any): string {
  const issue = value?.issue ?? value;
  const project = issue?.project;
  if (typeof project === "string") return project;
  if (project && typeof project === "object" && typeof project.name === "string") {
    return project.name;
  }
  return "";
}

export async function fetchLinearIssue(
  identifier: string,
  config: WorkitConfig,
  cwd: string,
): Promise<IssueDetails> {
  const normalized = normalizeIdentifier(identifier);
  let value: any;
  try {
    value = commandJson(
      "linear",
      ["issue", "view", normalized, "--json", "--no-download", "--show-resolved-threads"],
      cwd,
    );
  } catch {
    const data = await linearApi(
      config,
      `query Issue($id: String!) { issue(id: $id) { identifier title description url state { name type } project { name } } }`,
      { id: normalized },
    );
    value = data?.issue;
  }

  const issue = value?.issue ?? value;
  if (!issue?.title) {
    throw new Error(`Unable to fetch Linear issue ${normalized}`);
  }
  const project = linearProject(value);
  return {
    backend: "linear",
    identifier: issue.identifier ?? normalized,
    state: typeof issue.state === "string" ? issue.state : issue.state?.name ?? issue.status?.name,
    stateType: issue.state?.type ?? issue.status?.type,
    title: issue.title,
    body: issue.description ?? issue.body ?? "No description provided.",
    labels: (issue.labels ?? []).map((label: { name?: string }) => label.name).filter(Boolean),
    url:
      issue.url ??
      `${(config.linear?.baseUrl ?? `https://linear.app/${config.linear?.org ?? "2en"}/issue`).replace(/\/$/, "")}/${normalized}`,
    ...(project ? { project } : {}),
  };
}

export async function fetchIssue(
  backend: Backend,
  identifier: string,
  config: WorkitConfig,
  cwd: string,
): Promise<IssueDetails> {
  return backend === "github"
    ? fetchGithubIssue(identifier, config, cwd)
    : fetchLinearIssue(identifier, config, cwd);
}

interface LinearTransition {
  /** Workflow states this handoff is allowed to leave. */
  from: readonly string[];
  /** Target workflow state, matched by name. */
  to: string;
}

/**
 * Tracker handoffs workit owns. `inProgress` is the launch-time claim on queued
 * work; `inReview` is the post-merge handoff; `done` follows accepted independent
 * verification. A hold or reopened issue is not overridden by completion sync.
 */
const linearTransitions: Record<"inProgress" | "inReview" | "done", LinearTransition> = {
  inProgress: { from: ["backlog", "todo", "on hold"], to: "In Progress" },
  inReview: { from: ["in progress", "rework", "merging"], to: "In Review" },
  done: { from: ["in review"], to: "Done" },
};

const LINEAR_STATE_QUERY =
  `query IssueState($id: String!) { issue(id: $id) { id state { name } team { states { nodes { id name } } } } }`;
const LINEAR_STATE_MUTATION =
  `mutation UpdateIssue($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`;

/**
 * Move a Linear issue between workflow states, leaving it alone unless it
 * currently sits in one of the transition's source states. Returns the previous
 * state name when a transition happened. Prefers the authenticated `linear` CLI
 * when no API key is present, so the launchd heartbeat works without one.
 */
async function setLinearState(
  config: WorkitConfig,
  identifier: string,
  transition: LinearTransition,
  cwd: string,
): Promise<string | undefined> {
  if (process.env.LINEAR_API_KEY) {
    const data = await linearApi(config, LINEAR_STATE_QUERY, { id: identifier });
    const current = data?.issue;
    const previous = String(current?.state?.name ?? "");
    if (!current?.id || !transition.from.includes(previous.toLowerCase())) return undefined;
    const next = current.team?.states?.nodes?.find((state: { name?: string }) => state.name === transition.to);
    if (!next?.id) return undefined;
    await linearApi(config, LINEAR_STATE_MUTATION, { id: current.id, stateId: next.id });
    return previous;
  }
  const value = commandJson(
    "linear",
    ["issue", "view", identifier, "--json", "--no-download"],
    cwd,
  ) as { state?: { name?: string } };
  const previous = String(value?.state?.name ?? "");
  if (!previous || !transition.from.includes(previous.toLowerCase())) return undefined;
  commandQuiet("linear", ["issue", "update", identifier, "--state", transition.to], cwd);
  return previous;
}

/** Launch-time claim: queued work becomes In Progress before an agent starts. */
export async function transitionLinearIssue(
  issue: IssueDetails,
  config: WorkitConfig,
  cwd = process.cwd(),
): Promise<void> {
  if (issue.backend !== "linear") return;
  const previous = await setLinearState(config, issue.identifier, linearTransitions.inProgress, cwd);
  if (previous) console.log(`  → Status: ${previous} → In Progress`);
}

/**
 * Post-merge handoff. Merge alone does not establish acceptance.
 */
export async function markLinearIssueInReview(
  issue: IssueDetails,
  config: WorkitConfig,
  cwd = process.cwd(),
): Promise<void> {
  if (issue.backend !== "linear") return;
  await setLinearState(config, issue.identifier, linearTransitions.inReview, cwd);
}

/** Called only after workit accepts independent verification evidence. */
export async function markLinearIssueDone(
  issue: IssueDetails,
  config: WorkitConfig,
  cwd = process.cwd(),
): Promise<void> {
  if (issue.backend !== "linear") return;
  await setLinearState(config, issue.identifier, linearTransitions.done, cwd);
}
