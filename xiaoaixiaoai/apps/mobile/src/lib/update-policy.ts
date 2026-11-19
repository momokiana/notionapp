/** Pure policy seam: no network, React Native, storage, or account IO. */
export const UPDATES_DISABLED_NOTE = "尚未配置小爱小爱的发布源，应用内更新已关闭";

export interface ReleaseSourcePolicy {
  enabled: boolean;
  repository: string | null;
  page: string | null;
}

/** Every updater entry point must pass this before using even a cached release. */
export function updatesConfigured(policy: ReleaseSourcePolicy): boolean {
  return policy.enabled && typeof policy.repository === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy.repository) &&
    policy.repository.toLowerCase() !== "crosery/herdr-pocket" &&
    policy.page === `https://github.com/${policy.repository}/releases/latest`;
}
