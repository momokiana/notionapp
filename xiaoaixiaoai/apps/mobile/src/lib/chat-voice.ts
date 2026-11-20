/**
 * Normal-chat voice controller: streams relay `assistant_speech` frames to native playback
 * and drives WeChat-style push-to-talk recording outside live voice calls.
 */
import { AppState, PermissionsAndroid, Platform } from "react-native";
import { create } from "zustand";
import type { ServerFrame } from "@xiaoaixiaoai/protocol";
import { XiaoaiNative } from "../../modules/xiaoaixiaoai-native";
import { applog } from "./applog";
import {
  requestAssistantSpeak,
  sendVoiceToAssistant,
  stopAssistantSpeakRemote,
  warmupAssistantVoice,
} from "./assistant";
import { isMockServer } from "./mock";
import { useSettings } from "./store";
import { useVoice } from "./voice";

export type PttState = "idle" | "recording" | "transcribing";

interface ChatVoiceStore {
  speakingItemId: string | null;
  activeUtteranceId: string | null;
  pttState: PttState;
  pttLevel: number;
}

export const useChatVoice = create<ChatVoiceStore>()(() => ({
  speakingItemId: null,
  activeUtteranceId: null,
  pttState: "idle",
  pttLevel: 0,
}));

const utteranceToItem = new Map<string, string>();
let pttSeq = 0;
let pttStarting = false;
let pttCancelledSeq = 0;
let pttFinishRequestedSeq = 0;

function inLiveCall(): boolean {
  const s = useVoice.getState().status;
  return s === "connecting" || s === "ready";
}

function wire(): void {
  if (XiaoaiNative) {
    XiaoaiNative.addListener("onSpeech", (e) => {
      if (e.state === "ended" || e.state === "stopped") {
        utteranceToItem.delete(e.utteranceId);
        const cur = useChatVoice.getState();
        if (cur.activeUtteranceId === e.utteranceId) {
          useChatVoice.setState({ speakingItemId: null, activeUtteranceId: null });
        }
      }
    });
    XiaoaiNative.addListener("onPttLevel", (e) => {
      if (useChatVoice.getState().pttState === "recording") {
        useChatVoice.setState({ pttLevel: Math.max(0, Math.min(1, e.level)) });
      }
    });
  }

  AppState.addEventListener("change", (next) => {
    if (next !== "active") {
      if (useChatVoice.getState().speakingItemId || useChatVoice.getState().activeUtteranceId) {
        stopAssistantSpeech();
      }
      if (useChatVoice.getState().pttState === "recording" || pttStarting) {
        abortVoiceNote();
      }
    }
  });

  useVoice.subscribe((s, prev) => {
    const active = s.status === "connecting" || s.status === "ready";
    const wasActive = prev.status === "connecting" || prev.status === "ready";
    if (active && !wasActive) {
      if (useChatVoice.getState().speakingItemId || useChatVoice.getState().activeUtteranceId) {
        stopAssistantSpeech();
      }
      if (useChatVoice.getState().pttState === "recording" || pttStarting) {
        abortVoiceNote();
      }
    }
  });
}
wire();

export function onAssistantSpeechFrame(f: ServerFrame): boolean {
  if (f.type !== "assistant_speech") return false;
  if (f.phase === "stop") {
    utteranceToItem.delete(f.utteranceId);
    XiaoaiNative?.stopSpeech?.(f.utteranceId);
    const cur = useChatVoice.getState();
    if (!cur.activeUtteranceId || cur.activeUtteranceId === f.utteranceId) {
      useChatVoice.setState({ speakingItemId: null, activeUtteranceId: null });
    }
    if (f.error) applog("warn", "voice", `chat speech stopped: ${f.error}`);
    return true;
  }

  if (inLiveCall() || AppState.currentState !== "active") {
    return true;
  }

  if (f.phase === "start") {
    utteranceToItem.set(f.utteranceId, f.itemId);
    useChatVoice.setState({ speakingItemId: f.itemId, activeUtteranceId: f.utteranceId });
    XiaoaiNative?.startSpeech?.(f.utteranceId, f.sampleRate ?? 48_000);
    return true;
  }

  if (f.phase === "chunk") {
    if (!f.pcmBase64) return true;
    const mappedItem = utteranceToItem.get(f.utteranceId) ?? f.itemId;
    utteranceToItem.set(f.utteranceId, mappedItem);
    const cur = useChatVoice.getState();
    if (cur.activeUtteranceId !== f.utteranceId) {
      useChatVoice.setState({ speakingItemId: mappedItem, activeUtteranceId: f.utteranceId });
    }
    XiaoaiNative?.feedSpeech?.(f.utteranceId, f.pcmBase64);
    return true;
  }

  if (f.phase === "done") {
    if (XiaoaiNative?.finishSpeech) {
      XiaoaiNative.finishSpeech(f.utteranceId);
    } else {
      utteranceToItem.delete(f.utteranceId);
      const cur = useChatVoice.getState();
      if (cur.activeUtteranceId === f.utteranceId) {
        useChatVoice.setState({ speakingItemId: null, activeUtteranceId: null });
      }
    }
    return true;
  }

  return true;
}

export async function playAssistantItem(itemId: string, text?: string): Promise<string | null> {
  const server = useSettings.getState().server;
  if (isMockServer(server)) {
    stopAssistantSpeech();
    const utt = `demo-${Date.now()}`;
    useChatVoice.setState({ speakingItemId: itemId, activeUtteranceId: utt });
    setTimeout(() => {
      if (useChatVoice.getState().activeUtteranceId === utt) {
        useChatVoice.setState({ speakingItemId: null, activeUtteranceId: null });
      }
    }, 1800);
    return null;
  }
  if (inLiveCall()) return "通话中没法播放聊天语音";
  if (!XiaoaiNative?.startSpeech) return "这个版本的 App 还不支持聊天语音播报，装一下新版";
  stopAssistantSpeech();
  try {
    const utteranceId = await requestAssistantSpeak(itemId, text);
    if (utteranceId) {
      utteranceToItem.set(utteranceId, itemId);
      useChatVoice.setState({ speakingItemId: itemId, activeUtteranceId: utteranceId });
    }
    return null;
  } catch (e) {
    useChatVoice.setState({ speakingItemId: null, activeUtteranceId: null });
    return (e as Error).message || "语音播报失败";
  }
}

export function stopAssistantSpeech(): void {
  const prevUtt = useChatVoice.getState().activeUtteranceId;
  if (prevUtt) utteranceToItem.delete(prevUtt);
  useChatVoice.setState({ speakingItemId: null, activeUtteranceId: null });
  XiaoaiNative?.stopSpeech?.(null);
  void stopAssistantSpeakRemote();
}

export async function beginVoiceNote(): Promise<string | null> {
  const server = useSettings.getState().server;
  if (isMockServer(server)) {
    const seq = ++pttSeq;
    pttCancelledSeq = 0;
    pttFinishRequestedSeq = 0;
    useChatVoice.setState({ pttState: "recording", pttLevel: 0.35 });
    void seq;
    return null;
  }
  if (inLiveCall()) return "通话中不能录语音消息";
  if (!XiaoaiNative?.startVoiceNote || Platform.OS !== "android") {
    return "这个版本的 App 还不支持按住说话，装一下新版";
  }
  if (AppState.currentState !== "active") return null;

  const seq = ++pttSeq;
  pttStarting = true;
  pttCancelledSeq = 0;
  pttFinishRequestedSeq = 0;
  try {
    const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
      title: "用麦克风发送语音消息",
      message: "按住说话时录音并转成文字发给爱弥斯。",
      buttonPositive: "允许",
    });
    if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
      return "没有麦克风权限，可以在系统设置里打开";
    }
    if (seq !== pttSeq || pttCancelledSeq === seq || pttFinishRequestedSeq === seq) {
      return null;
    }
    stopAssistantSpeech();
    void warmupAssistantVoice();
    await XiaoaiNative.startVoiceNote();
    if (seq !== pttSeq || pttCancelledSeq === seq) {
      XiaoaiNative.cancelVoiceNote?.();
      useChatVoice.setState({ pttState: "idle", pttLevel: 0 });
      return null;
    }
    if (pttFinishRequestedSeq === seq) {
      XiaoaiNative.cancelVoiceNote?.();
      useChatVoice.setState({ pttState: "idle", pttLevel: 0 });
      return "说话时间太短啦";
    }
    useChatVoice.setState({ pttState: "recording", pttLevel: 0 });
    return null;
  } catch (e) {
    useChatVoice.setState({ pttState: "idle", pttLevel: 0 });
    return (e as Error).message || "无法启动录音";
  } finally {
    if (seq === pttSeq) pttStarting = false;
  }
}

export function abortVoiceNote(): void {
  pttCancelledSeq = pttSeq;
  XiaoaiNative?.cancelVoiceNote?.();
  if (useChatVoice.getState().pttState === "recording") {
    useChatVoice.setState({ pttState: "idle", pttLevel: 0 });
  }
}

export async function finishVoiceNote(): Promise<string | null> {
  const server = useSettings.getState().server;
  if (isMockServer(server)) {
    useChatVoice.setState({ pttState: "transcribing", pttLevel: 0 });
    try {
      await sendVoiceToAssistant("", 16_000);
      return null;
    } finally {
      useChatVoice.setState({ pttState: "idle", pttLevel: 0 });
    }
  }
  const seq = pttSeq;
  if (pttStarting) {
    pttFinishRequestedSeq = seq;
    useChatVoice.setState({ pttState: "idle", pttLevel: 0 });
    return "说话时间太短啦";
  }
  if (!XiaoaiNative?.stopVoiceNote || useChatVoice.getState().pttState !== "recording") {
    useChatVoice.setState({ pttState: "idle", pttLevel: 0 });
    return null;
  }
  try {
    const rec = await XiaoaiNative.stopVoiceNote();
    if (!rec.audioBase64 || rec.durationMs < 350) {
      useChatVoice.setState({ pttState: "idle", pttLevel: 0 });
      return "说话时间太短啦";
    }
    useChatVoice.setState({ pttState: "transcribing", pttLevel: 0 });
    const text = await sendVoiceToAssistant(rec.audioBase64, rec.sampleRate || 16_000);
    if (!text.trim()) return "没听清你说什么，再说一遍试试";
    return null;
  } catch (e) {
    return (e as Error).message || "语音发送失败";
  } finally {
    if (useChatVoice.getState().pttState !== "recording") {
      useChatVoice.setState({ pttState: "idle", pttLevel: 0 });
    }
  }
}
