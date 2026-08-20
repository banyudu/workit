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
    const output = execFileSync(command, args, {
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

export function fetchGithubIssue(
  identifier: string,
  config: WorkitConfig,
  cwd: string,
): IssueDetails {
  const number = issueNumber(identifier);
  const args = ["issue", "view", String(number), "--json", "title,body,labels,url"];
  const repo = config.repo ?? config.github?.repo;
  if (repo) args.push("--repo", repo);
  const value = commandJson("gh", args, cwd) as {
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
      `query Issue($id: String!) { issue(id: $id) { identifier title description url } }`,
      { id: normalized },
    );
    value = data?.issue;
  }

  const issue = value?.issue ?? value;
  if (!issue?.title) {
    throw new Error(`Unable to fetch Linear issue ${normalized}`);
  }
  return {
    backend: "linear",
    identifier: issue.identifier ?? normalized,
    title: issue.title,
    body: issue.description ?? issue.body ?? "No description provided.",
    labels: (issue.labels ?? []).map((label: { name?: string }) => label.name).filter(Boolean),
    url:
      issue.url ??
      `${(config.linear?.baseUrl ?? `https://linear.app/${config.linear?.org ?? "2en"}/issue`).replace(/\/$/, "")}/${normalized}`,
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

export async function transitionLinearIssue(
  issue: IssueDetails,
  config: WorkitConfig,
): Promise<void> {
  if (issue.backend !== "linear" || !process.env.LINEAR_API_KEY) return;
  const data = await linearApi(
    config,
    `query IssueState($id: String!) { issue(id: $id) { id state { name } team { states { nodes { id name } } } } }`,
    { id: issue.identifier },
  );
  const current = data?.issue;
  const currentName = String(current?.state?.name ?? "").toLowerCase();
  if (!current?.id || !["backlog", "todo", "on hold"].includes(currentName)) return;
  const next = current.team?.states?.nodes?.find((state: { name?: string }) => state.name === "In Progress");
  if (!next?.id) return;
  await linearApi(
    config,
    `mutation UpdateIssue($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`,
    { id: current.id, stateId: next.id },
  );
  console.log(`  → Status: ${current.state.name} → In Progress`);
}
