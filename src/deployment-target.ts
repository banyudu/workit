import type { LifecycleConfig } from "./lifecycle.js";

export interface DeploymentTarget {
  probe: string[];
  environment: string;
  target: string;
  dependency?: string;
}

/** Only caller-supplied trusted repository/host configuration defines argv. */
export function selectDeploymentTarget(config: LifecycleConfig, name?: string): LifecycleConfig {
  if (!name) return config;
  const target = Object.hasOwn(config.deploymentTargets ?? {}, name) ? config.deploymentTargets![name] : undefined;
  if (!target || !Array.isArray(target.probe) || !target.probe.length ||
      target.probe.some(value => typeof value !== "string" || !value || value.includes("\0")) ||
      typeof target.environment !== "string" || !target.environment.trim() ||
      typeof target.target !== "string" || !target.target.trim()) throw new Error("Unknown or invalid trusted deployment target");
  return { ...config, deploymentTarget: name, deploymentProbe: [...target.probe],
    deploymentDependency: target.dependency, deploymentBinding: { environment: target.environment, target: target.target } };
}
