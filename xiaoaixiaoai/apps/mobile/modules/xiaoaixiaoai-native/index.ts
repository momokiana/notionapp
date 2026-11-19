import { requireOptionalNativeModule, type EventSubscription } from "expo";

/** A picture from `pickImages`. */
export interface PickedImage {
  name: string;
  mime: "image/jpeg";
  /** Base64, no line breaks. */
  data: string;
  width: number;
  height: number;
  bytes: number;
}

/** Android-only native side: voice call audio, the background alert service, notifications, in-app updates, picking pictures. */
interface XiaoaiNativeModule {
  startCall(server: string, token: string): void;
  hangup(): void;
  setMuted(muted: boolean): void;
  callState(): { active: boolean; muted: boolean };
  configureNotifier(server: string | null, token: string | null, enabled: boolean, kinds: string[], name: string | null): void;
  notifierState(): { enabled: boolean; connected: boolean; notificationsAllowed: boolean; batteryUnrestricted: boolean };
  requestBatteryExemption(): void;
  openNotificationSettings(): void;
  testNotice(title: string, body: string): void;
  /** In-app update (absent in builds before it existed). */
  appVersion?(): string | null;
  /** `sha256`: the APK's expected hash, or "" when unknown. */
  downloadUpdate?(url: string, fileName: string, size: number, sha256: string): Promise<string>;
  cancelUpdate?(): void;
  installUpdate?(path: string): "started" | "permission" | "missing";
  canInstallUpdates?(): boolean;
  /**
   * Picture picker (absent in builds before it existed): up to `max` pictures,
   * each a base64 JPEG whose longest side is at most `maxSide`. Cancelled: [].
   */
  pickImages?(max: number, maxSide: number, quality: number): Promise<PickedImage[]>;
  addListener(event: "onCall", fn: (e: { state: "connecting" | "ready" | "ended"; message?: string; muted?: boolean }) => void): EventSubscription;
  addListener(event: "onCallEvent", fn: (e: { json: string }) => void): EventSubscription;
  addListener(event: "onLevel", fn: (e: { mic: number; out: number }) => void): EventSubscription;
  addListener(event: "onNotice", fn: (e: { json: string }) => void): EventSubscription;
  addListener(event: "onNotifier", fn: (e: { connected: boolean }) => void): EventSubscription;
  addListener(event: "onUpdateProgress", fn: (e: { received: number; total: number }) => void): EventSubscription;
}

/** A matching native APK is required; Expo Go and pre-0.1.5 APKs have no XiaoaiNative bridge. */
export const XiaoaiNative = requireOptionalNativeModule<XiaoaiNativeModule>("XiaoaiNative");
