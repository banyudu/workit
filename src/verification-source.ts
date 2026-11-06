import { SourceProvenanceError, sha, observesExistingDeployment, type Deployment, type Job, type LifecycleAdapter } from "./lifecycle.js";

export const investigation = (job: Job): boolean => job.config.delivery === "investigation";
export const verificationSource = (job: Job): string | undefined => investigation(job) ? job.observedSourceSha : job.mergeSha;
export class VerificationReadError extends Error {}
export async function observe<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (error) {
    if (error instanceof SourceProvenanceError) throw error;
    throw new VerificationReadError("Current verification facts unavailable");
  }
}

/** Both CLI and automatic verification establish the same source contract. */
export async function assertVerificationSource(adapter: LifecycleAdapter, job: Job): Promise<void> {
  if (investigation(job)) {
    if (!sha(job.observedSourceSha) || !adapter.observedSource ||
        await observe(() => adapter.observedSource!(job)) !== job.observedSourceSha) {
      throw new Error("Investigation source changed; inspect and correct its pinned observed source before verifying");
    }
  } else {
    const pr = await observe(() => adapter.pr(job));
    if (!pr.merged || !sha(job.mergeSha) || pr.mergeSha !== job.mergeSha) throw new Error("GitHub does not establish the expected merged source");
  }
}

export async function assertVerificationDeployment(adapter: LifecycleAdapter, job: Job): Promise<void> {
  observesExistingDeployment(job);
  if (job.config.verification === "local") return;
  const deployment = await observe(() => adapter.deployment(job));
  if (!deployment || !job.deployment ||
      !(["environment", "target", "sourceSha", "version"] as const).every(key => deployment[key] === job.deployment![key])) {
    throw new Error("Serving deployment changed; rerun applicable verification");
  }
  await assertDeploymentSourceRelation(adapter, job, deployment);
}

/** The observer stays pinned independently; only explicit observations omit ancestry. */
export async function assertDeploymentSourceRelation(adapter: LifecycleAdapter, job: Job, deployment: Deployment): Promise<void> {
  if (!sha(deployment.sourceSha) || !deployment.environment?.trim() || !deployment.target?.trim() || !deployment.version?.trim())
    throw new SourceProvenanceError("Deployment observation needs environment, target, full source SHA and version");
  if (job.config.deploymentBinding && (deployment.environment !== job.config.deploymentBinding.environment ||
      deployment.target !== job.config.deploymentBinding.target))
    throw new SourceProvenanceError("Deployment observation differs from the named target");
  if (!observesExistingDeployment(job) && !await observe(() => adapter.containsMerge(job, deployment.sourceSha)))
    throw new Error("Serving deployment does not contain the expected source");
}
