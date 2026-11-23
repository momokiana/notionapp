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

/** Result of a recorded push-to-talk voice note (16 kHz mono PCM16LE base64). */
export interface RecordedVoiceNote {
  audioBase64: string;
  sampleRate: number;
  durationMs: number;
}

/** Android-only native side: voice call audio, normal-chat voice note & TTS playback, background alert service, notifications, in-app updates, picking pictures. */
interface XiaoaiNativeModule {
  startCall(server: string, token: string): void;
  hangup(): void;
  setMuted(muted: boolean): void;
  callState(): { active: boolean; muted: boolean };
  /** Normal-chat push-to-talk + streaming TTS (absent in pre-0.3.1 APKs). */
  startVoiceNote?(): Promise<boolean>;
  stopVoiceNote?(): Promise<RecordedVoiceNote>;
  cancelVoiceNote?(): void;
  startSpeech?(utteranceId: string, sampleRate: number): void;
  feedSpeech?(utteranceId: string, pcmBase64: string): void;
  finishSpeech?(utteranceId: string): void;
  stopSpeech?(utteranceId: string | null): void;
  configureNotifier(server: string | null, token: string | null, enabled: boolean, kinds: string[], name: string | null): void;
  notifierState(): { enabled: boolean; connected: boolean; notificationsAllowed: boolean; channelSoundAllowed?: boolean; batteryUnrestricted: boolean };
  requestBatteryExemption(): void;
  openNotificationSettings(): void;
  openAlertChannelSettings?(): void;
  playAlertSound?(): void;
  openAppDetails?(): void;
  notificationAccessEnabled?(): boolean;
  openNotificationAccessSettings?(): void;
  setLedgerPluginEnabled?(enabled: boolean): void;
  syncLedgerCache?(snapshotJson: string): void;
  flushPendingLedger?(): void;
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
  addListener(event: "onNotifier", fn: (e: { connected: boolean; reason?: string }) => void): EventSubscription;
  addListener(event: "onUpdateProgress", fn: (e: { received: number; total: number }) => void): EventSubscription;
  addListener(event: "onSpeech", fn: (e: { utteranceId: string; state: "playing" | "ended" | "stopped" }) => void): EventSubscription;
  addListener(event: "onPttLevel", fn: (e: { level: number }) => void): EventSubscription;
  addListener(event: "onLedgerUpdated", fn: () => void): EventSubscription;
}

/** A matching native APK is required; Expo Go and pre-0.1.5 APKs have no XiaoaiNative bridge. */
export const XiaoaiNative = requireOptionalNativeModule<XiaoaiNativeModule>("XiaoaiNative");
