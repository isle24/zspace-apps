export type RuntimeKind =
  | "start"
  | "stop"
  | "install"
  | "update"
  | "backup"
  | "restore"
  | "archive"
  | "reactivate"
  | "restart";
export type RuntimeService = {
  id: string;
  image?: string;
  userMode?: string;
  dependsOn?: string[];
  entry?: boolean;
  containerPort?: number;
  volumes?: { name: string; target: string; role: string }[];
};
export type RuntimeApp = {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  latestVersion?: string;
  installable: boolean;
  defaultPort: number;
  requiresMedia: boolean;
  sourceUrl?: string;
  documentation?: string;
  icon?: string;
  recipeRevision?: string;
  license?: string;
  minimumMemoryBytes?: number;
  migrationStrategy?: string;
  platforms?: string[];
  services?: RuntimeService[];
  availableVersions?: string[];
  upgradeAllowed?: boolean;
  sourceStatus?: string;
  sourceError?: string;
  checkedAt?: string;
};
export type RuntimeInstance = {
  id: string;
  appId: string;
  name: string;
  activeGenerationId: string;
  version: string;
  state: string;
  health: string;
  initialization: string;
  accessUrl: string;
  dataPath: string;
  hostPort: number;
  archived?: boolean;
  legacy?: boolean;
  updateAvailable?: boolean;
  ignoredVersion?: string;
};
export type RuntimeImage = {
  serviceId: string;
  tagReference?: string;
  reference: string;
  digest: string;
  platform: string;
  publisher: string;
  deliverySource: string;
};
export type RuntimeGeneration = {
  id: string;
  instanceId: string;
  appId: string;
  version: string;
  recipeRevision: string;
  rootPath: string;
  dataPath: string;
  mediaPath?: string;
  networkId?: string;
  state: string;
  hostPort: number;
  peerPort?: number;
  discoveryPort?: number;
  recipe: { services: RuntimeService[] };
  images: RuntimeImage[];
  containers: { serviceId: string; id: string; name: string; image: string; state: string }[];
};
export type RuntimePlan = {
  secretParameterNames?: string[];
  id: string;
  kind: RuntimeKind;
  appId: string;
  retryOfJobId?: string;
  retryOfPlanId?: string;
  instanceId?: string;
  generationId?: string;
  sourceGenerationId?: string;
  sourceVersion?: string;
  targetVersion: string;
  dataPath: string;
  rootPath?: string;
  snapshotId?: string;
  sourceSnapshotId?: string;
  snapshotRootPath?: string;
  snapshotRequired?: boolean;
  newDataCopy?: boolean;
  stopServices?: string[];
  hostPort: number;
  peerPort?: number;
  discoveryPort?: number;
  accessUrl?: string;
  mediaPath?: string;
  expiresAt: string;
  images: RuntimeImage[];
  recipe: {
    appId?: string;
    name?: string;
    version?: string;
    services: RuntimeService[];
  };
};
export type RuntimeJob = {
  id: string;
  planId?: string;
  kind?: string;
  appId: string;
  instanceId: string;
  status: string;
  stage: string;
  stages?: unknown;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
};
export type RuntimeSnapshot = {
  id: string;
  instanceId: string;
  generationId: string;
  appId: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  path: string;
};
export type RuntimeSettings = {
  defaultRootId: string;
  theme: "light" | "dark" | "system";
  updateCheckEnabled: boolean;
  updateCheckHours: number;
};
export type PlanRequest = {
  kind: RuntimeKind;
  appId?: string;
  instanceId?: string;
  targetVersion?: string;
  snapshotId?: string;
  rootId?: string;
  directory?: string;
  hostPort?: number;
  peerPort?: number;
  discoveryPort?: number;
  mediaRootId?: string;
  mediaPath?: string;
};
export const operationLabel: Record<RuntimeKind, string> = {
  start: "启动",
  stop: "停止",
  install: "安装",
  update: "更新",
  backup: "备份",
  restore: "恢复",
  archive: "归档",
  reactivate: "重新启用",
  restart: "重启",
};
export function initializationLabel(value?: string) {
  if (value === "completed") return "已完成";
  if (value === "not_required") return "无需配置";
  if (value === "required" || value === "pending") return "待完成";
  return "待核验";
}
export function safeAppURL(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}
