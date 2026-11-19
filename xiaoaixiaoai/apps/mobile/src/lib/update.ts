/**
 * In-app update from GitHub Releases. Checks the latest release at most every 12 hours,
 * downloads its APK with progress and hands it to the system installer. Network trouble,
 * GitHub's rate limit and a release without an APK all stay quiet unless the person asked.
 * Demo mode never calls GitHub.
 *
 * In mainland China (by the phone's time zone) GitHub is slow or out of reach, so the
 * release's SHA256SUMS and APK come through a mirror first, GitHub after; elsewhere it is
 * the other way round. A download is checked against SHA256SUMS whichever way it came.
 */
import { Linking } from "react-native";
import Constants from "expo-constants";
import { create } from "zustand";
import {
  LATEST_SUMS_URL,
  RELEASE_REPO,
  RELEASES_PAGE,
  RELEASE_UPDATES_ENABLED,
  apkAssetName,
  compareVersions,
  inMainlandChina,
  releaseAssetUrl,
  releaseFromSums,
  releaseSources,
} from "@xiaoaixiaoai/protocol";
import { XiaoaiNative } from "../../modules/xiaoaixiaoai-native";
import { isMockServer } from "./mock";
import { useSettings, type ReleaseInfo } from "./store";
import { applog } from "./applog";
import { updatesConfigured, UPDATES_DISABLED_NOTE } from "./update-policy";

export type UpdatePhase = "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "permission";

interface UpdateState {
  phase: UpdatePhase;
  /** 0..1 while downloading. */
  progress: number;
  /** The downloaded APK, once it is there. */
  path: string | null;
  /** One quiet line for the settings row; null for the default wording. */
  note: string | null;
}

export const useUpdate = create<UpdateState>()(() => ({ phase: "idle", progress: 0, path: null, note: null }));

const CHECK_EVERY_MS = 4 * 3600_000;
const set = (patch: Partial<UpdateState>) => useUpdate.setState(patch);

function pairedRelayReleaseUrl(fileName: string): string | null {
  const srv = useSettings.getState().server?.trim().replace(/\/+$/, "");
  if (!srv || isMockServer(srv) || !/^https?:\/\//i.test(srv)) return null;
  return `${srv}/v1/releases/${fileName}`;
}

const releasesEnabled = () => updatesConfigured({
  enabled: RELEASE_UPDATES_ENABLED, repository: RELEASE_REPO, page: RELEASES_PAGE,
});

/** Fail closed even if an earlier build left a release or installer path cached. */
function applyDisabledPolicy(): boolean {
  if (releasesEnabled()) return false;
  XiaoaiNative?.cancelUpdate?.();
  useSettings.getState().set({ updateRelease: null, updatePrompted: null, updateCheckedAt: 0 });
  set({ phase: "latest", progress: 0, path: null, note: UPDATES_DISABLED_NOTE });
  return true;
}

/** The installed version (the APK's versionName), e.g. "0.1.0". */
export function currentVersion(): string {
  return XiaoaiNative?.appVersion?.() ?? Constants.expoConfig?.version ?? "0.0.0";
}

/** The newer release, if one is known. */
export function useNewRelease(): ReleaseInfo | null {
  const r = useSettings((s) => s.updateRelease);
  return releasesEnabled() && r && r.url && compareVersions(r.version, currentVersion()) > 0 ? r : null;
}

/** Drops headings and markdown marks; keeps a few lines for a quick look. */
function shortNotes(body: unknown): string {
  if (typeof body !== "string") return "";
  return body
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/^\s*[-*+]\s+|\*\*|`/g, "").trim())
    .filter(Boolean)
    .slice(0, 4)
    .join("\n")
    .slice(0, 280);
}

type Latest = { kind: "release"; release: ReleaseInfo } | { kind: "none" } | { kind: "unknown"; why: "offline" | "limited" };

/** `fetch` that gives up after `ms`. */
async function fetchWithin(url: string, ms: number, init: RequestInit = {}): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The latest release from its SHA256SUMS (no notes, no size): works through a mirror. */
async function fetchFromSums(url: string): Promise<Latest> {
  if (!releasesEnabled()) return { kind: "none" };
  let res: Response;
  try {
    res = await fetchWithin(url, 10_000);
  } catch {
    return { kind: "unknown", why: "offline" };
  }
  if (!res.ok) return { kind: "unknown", why: res.status === 404 ? "offline" : res.status === 403 || res.status === 429 ? "limited" : "offline" };
  const found = releaseFromSums(await res.text().catch(() => ""));
  if (!found) return { kind: "unknown", why: "offline" };
  const fileName = apkAssetName(found.version);
  const sha256 = found.sums[fileName];
  return {
    kind: "release",
    release: {
      version: found.version,
      url: sha256 ? releaseAssetUrl(found.version, fileName) ?? "" : "",
      fileName,
      size: 0,
      sha256,
      page: `https://github.com/${RELEASE_REPO}/releases/tag/v${found.version}`,
      notes: "",
    },
  };
}

/** Sources in order until one answers; paired relay first, mirrors/GitHub after. */
async function fetchLatest(): Promise<Latest> {
  if (!releasesEnabled()) return { kind: "none" };
  const china = inMainlandChina();
  const sums = releaseSources(LATEST_SUMS_URL, china).map((u) => () => fetchFromSums(u));
  const relaySumsUrl = pairedRelayReleaseUrl("SHA256SUMS");
  const tries = [
    ...(relaySumsUrl ? [() => fetchFromSums(relaySumsUrl)] : []),
    ...(china ? [...sums.slice(0, -1), fetchFromApi, sums[sums.length - 1]!] : [fetchFromApi, ...sums]),
  ];
  let last: Latest = { kind: "unknown", why: "offline" };
  for (const attempt of tries) {
    last = await attempt();
    if (last.kind !== "unknown") return last;
  }
  return last;
}

/** The GitHub API: release notes and sizes, but rate-limited and slow from mainland China. */
async function fetchFromApi(): Promise<Latest> {
  if (!releasesEnabled() || !RELEASE_REPO) return { kind: "none" };
  let res: Response;
  try {
    res = await fetchWithin(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, 12_000, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
  } catch {
    return { kind: "unknown", why: "offline" };
  }
  if (res.status === 404) return { kind: "none" };
  if (!res.ok) return { kind: "unknown", why: res.status === 403 || res.status === 429 ? "limited" : "offline" };
  const json = (await res.json().catch(() => null)) as {
    tag_name?: string;
    html_url?: string;
    body?: string;
    assets?: { name?: string; browser_download_url?: string; size?: number; digest?: string | null }[];
  } | null;
  const version = json?.tag_name?.trim().replace(/^v/i, "");
  if (!version) return { kind: "unknown", why: "offline" };
  const assets = json?.assets ?? [];
  const want = apkAssetName(version);
  const apk = assets.find((a) => a.name === want);
  return {
    kind: "release",
    release: {
      version,
      url: apk?.browser_download_url ?? "",
      fileName: apk?.name ?? want,
      size: apk?.size ?? 0,
      sha256: /^sha256:([0-9a-f]{64})$/i.exec(apk?.digest ?? "")?.[1]?.toLowerCase(),
      page: RELEASES_PAGE ?? "",
      notes: shortNotes(json?.body),
    },
  };
}

/**
 * `manual`: the person tapped "检查更新" and wants an answer. Otherwise this is the quiet
 * background check, which runs at most every 12 hours.
 */
export async function checkForUpdate(manual = false): Promise<void> {
  if (applyDisabledPolicy()) return;
  const s = useSettings.getState();
  const { phase } = useUpdate.getState();
  if (phase === "checking" || phase === "downloading") return;
  if (isMockServer(s.server)) {
    if (manual) set({ phase: "latest", note: "演示模式不检查更新" });
    return;
  }
  if (!manual && Date.now() - s.updateCheckedAt < CHECK_EVERY_MS) {
    syncPhase();
    return;
  }
  if (manual) set({ phase: "checking", note: null });
  const latest = await fetchLatest();
  if (latest.kind === "unknown") {
    applog("info", "update", `update check failed: ${latest.why}`);
    // Try again on the next start rather than in 12 hours.
    syncPhase(manual ? (latest.why === "limited" ? "请求太频繁了，过一会儿再试" : "暂时连不上更新服务器，过会儿再试") : null);
    return;
  }
  const release = latest.kind === "release" ? latest.release : null;
  const newer = !!release && compareVersions(release.version, currentVersion()) > 0;
  useSettings.getState().set({
    updateCheckedAt: Date.now(),
    updateRelease: newer ? release : null,
    // Found by hand in Settings: the person is already looking at it, so no extra prompt.
    ...(manual && newer && release?.url ? { updatePrompted: release.version } : {}),
  });
  const waiting = newer && !release?.url;
  syncPhase(manual && waiting ? `v${release?.version} 已发布，安卓安装包还没传上来` : null);
}

/** Phase from what is known, keeping a download that is under way. */
function syncPhase(note: string | null = null): void {
  const { phase } = useUpdate.getState();
  if (phase === "downloading" || phase === "ready" || phase === "permission") return;
  const r = useSettings.getState().updateRelease;
  const newer = !!r?.url && compareVersions(r.version, currentVersion()) > 0;
  set({ phase: newer ? "available" : note || phase !== "idle" ? "latest" : "idle", note });
}

/** Downloads the newer APK, then opens the installer. Without the native updater, opens the release page. */
export async function downloadUpdate(): Promise<void> {
  if (applyDisabledPolicy()) return;
  const r = useSettings.getState().updateRelease;
  if (!r) return;
  const native = XiaoaiNative;
  if (!r.url || !native?.downloadUpdate || !native.installUpdate) {
    await Linking.openURL(r.page).catch(() => undefined);
    return;
  }
  if (useUpdate.getState().phase === "downloading") return;
  set({ phase: "downloading", progress: 0, note: null });
  const sub = native.addListener("onUpdateProgress", (e) => {
    if (e.total > 0) set({ progress: Math.min(1, e.received / e.total) });
  });
  try {
    let path: string | null = null;
    let failed: unknown;
    const relayApk = pairedRelayReleaseUrl(r.fileName);
    const urls = [...new Set([...(relayApk ? [relayApk] : []), ...releaseSources(r.url, inMainlandChina())])];
    for (const url of urls) {
      try {
        path = await native.downloadUpdate(url, r.fileName, r.size, r.sha256 ?? "");
        break;
      } catch (e) {
        failed = e;
        applog("info", "update", `download of ${r.version} from ${url.replace(/^https?:\/\/([^/]+).*$/, "$1")} failed: ${(e as Error)?.message ?? String(e)}`);
        set({ progress: 0 });
      }
    }
    if (!path) throw failed;
    set({ phase: "ready", path, progress: 1 });
    installUpdate();
  } catch (e) {
    applog("warn", "update", `download of ${r.version} failed: ${(e as Error)?.message ?? String(e)}`);
    // The release may have changed since it was looked up: look again next time.
    useSettings.getState().set({ updateCheckedAt: 0 });
    set({ phase: "available", progress: 0, note: "下载没成功，检查一下网络再试" });
  } finally {
    sub.remove();
  }
}

/** Opens the system installer; the first time, Android asks to allow installing from this app. */
export function installUpdate(): void {
  if (applyDisabledPolicy()) return;
  const { path } = useUpdate.getState();
  if (!path || !XiaoaiNative?.installUpdate) return;
  const r = XiaoaiNative.installUpdate(path);
  if (r === "permission") set({ phase: "permission", note: null });
  else if (r === "missing") set({ phase: "available", path: null, note: null });
  else set({ phase: "ready", note: "按系统提示完成安装" });
}

/** Back from the "install unknown apps" settings page: carry on if it was allowed. */
export function resumeInstallIfAllowed(): void {
  if (applyDisabledPolicy()) return;
  if (useUpdate.getState().phase === "permission" && XiaoaiNative?.canInstallUpdates?.()) installUpdate();
}
