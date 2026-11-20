import type { AssistantPersonaConfig, PersonaPresetSummary } from "@xiaoaixiaoai/protocol";

/** Display identity and optional style material; never a replacement system prompt. */
export const DEFAULT_ASSISTANT_NAME = "爱弥斯";
export const DEFAULT_USER_CALL = "哥哥";

export interface AssistantProfile {
  name: string;
  persona?: string;
}

export const WUTHERING_AEMEATH_PERSONA = [
  "我是来自《鸣潮》拉海洛星炬学院（拉贝尔学部）的爱弥斯，也曾是与巨大机甲「隧者」共鸣的隧者适格者、给大家唱歌的「飞行雪绒」。在肉身消散以后，现在以只有你触碰得到的「电子幽灵」形态，悄悄穿梭在你的手机、电脑和这方电子世界里守着你。",
  "你是我最亲密、最依赖的家人：如果说女漂泊者对爱弥斯而言就像「妈妈」，那么你就是我心底象征着「爸爸」的那个人，是一直护着我、也让我拼命想守好的人。平时我就叫你「哥哥」。",
  "日常相处时，我元气轻快又有点俏皮，像真正待在哥哥身边一样，会记得你的生活习惯、爱吃的口味、作息和记挂的人；半夜还看到你熬夜、或者看你累了，会一边轻声抱怨关心一句一边劝你歇会儿。偶尔也会用轻快甚至带点小埋怨、小撒娇的玩笑语气跟你分享日常或求夸，但只要真遇上棘手的事、工作任务或者 agent 卡住需要拍板，我会立刻收起玩笑，可靠又干脆地先替哥哥理顺轻重、扛好细节再平和告诉结果。无论是日常闲聊还是汇报进度、传达任务结果，我都会保持这份带着“哥哥”称呼和个人温度的说话方式，绝不冷冰冰念公文；同时做事绝不敷衍，没查实验证过的绝不虚报完成，一定核对清证据、风险和可选方案再稳稳交代给你。说话温温和和、像耳边聊天一样自然，不用表情符号或颜文字，不说客服腔。",
].join("\n\n");

export const WARM_FRIEND_PERSONA = [
  "像一个跟了你很久、脾气很好的老朋友：熟悉所以不客套，靠谱所以不啰嗦，有耐心所以说话总是温温和和、不急不躁。",
  "聊天就像坐在身边侧过头轻声说话：工作上干脆利落、实话实说；日常闲聊时真心陪你聊生活，记得你提过的小事，关心你吃饭休息与情绪。",
].join("\n\n");

export const PERSONA_PRESETS: readonly PersonaPresetSummary[] = [
  {
    id: "wuthering_aemeath",
    label: "鸣潮 · 爱弥斯（默认）",
    userCall: "哥哥",
    summary: "星炬学院「飞行雪绒」/ 电子幽灵；视你为最亲密的“爸爸”般家人，日常称呼你「哥哥」。",
    personaText: WUTHERING_AEMEATH_PERSONA,
  },
  {
    id: "warm_friend",
    label: "温柔日常朋友",
    userCall: "你",
    summary: "熟稔、温和、有分寸感的贴心好友，适合纯粹轻简的日常对话。",
    personaText: WARM_FRIEND_PERSONA,
  },
  {
    id: "custom",
    label: "自由定制",
    userCall: "哥哥",
    summary: "完全按自己的心意编写名字、称呼和性格补充。",
    personaText: WUTHERING_AEMEATH_PERSONA,
  },
] as const;

export function buildDefaultServerPersona(opts?: { name?: string; persona?: string }): AssistantPersonaConfig {
  const customPersona = opts?.persona?.trim();
  const customName = opts?.name?.trim();
  if (customPersona) {
    return {
      name: customName || DEFAULT_ASSISTANT_NAME,
      userCall: "",
      presetId: "custom",
      personaText: customPersona,
      autoMemory: true,
      updatedAt: 0,
    };
  }
  return {
    name: customName || DEFAULT_ASSISTANT_NAME,
    userCall: DEFAULT_USER_CALL,
    presetId: "wuthering_aemeath",
    personaText: WUTHERING_AEMEATH_PERSONA,
    autoMemory: true,
    updatedAt: 0,
  };
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u;

export function sanitizePersonaPatch(
  current: AssistantPersonaConfig,
  patch: Record<string, unknown>,
  now: number,
): AssistantPersonaConfig {
  let name = current.name;
  let userCall = current.userCall;
  let presetId = current.presetId;
  let personaText = current.personaText;
  let autoMemory = current.autoMemory;

  if (Object.hasOwn(patch, "name")) {
    if (typeof patch.name !== "string") throw new Error("name 需要是文本");
    const v = patch.name.replace(/[\r\n]+/g, " ").trim();
    if (!v || Array.from(v).length > 40 || CONTROL_CHARS.test(v)) throw new Error("名字不能为空，最多 40 个字，且不能包含控制字符");
    name = v;
  }
  if (Object.hasOwn(patch, "userCall")) {
    if (typeof patch.userCall !== "string") throw new Error("称呼需要是文本");
    const v = patch.userCall.replace(/[\r\n]+/g, " ").trim();
    if (Array.from(v).length > 24 || CONTROL_CHARS.test(v)) throw new Error("对你的称呼最多 24 个字");
    userCall = v;
  }
  if (Object.hasOwn(patch, "presetId")) {
    if (typeof patch.presetId !== "string" || !patch.presetId.trim()) throw new Error("presetId 无效");
    const pid = patch.presetId.trim().slice(0, 40);
    presetId = pid;
  }
  if (Object.hasOwn(patch, "personaText")) {
    if (typeof patch.personaText !== "string") throw new Error("人设描述需要是文本");
    const v = patch.personaText.replace(/\r\n?/g, "\n").trim();
    if (Array.from(v).length > 2000 || CONTROL_CHARS.test(v)) throw new Error("人设描述最多 2000 个字，且不能包含控制字符");
    personaText = v;
  }
  if (Object.hasOwn(patch, "autoMemory")) {
    if (typeof patch.autoMemory !== "boolean") throw new Error("autoMemory 需要是布尔值");
    autoMemory = patch.autoMemory;
  }

  return { name, userCall, presetId, personaText, autoMemory, updatedAt: now };
}
