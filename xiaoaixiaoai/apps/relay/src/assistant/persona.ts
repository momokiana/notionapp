import type { AssistantPersonaConfig, PersonaPresetSummary } from "@xiaoaixiaoai/protocol";

/** Display identity and optional style material; never a replacement system prompt. */
export const DEFAULT_ASSISTANT_NAME = "爱弥斯";
export const DEFAULT_USER_CALL = "哥哥";

export interface AssistantProfile {
  name: string;
  persona?: string;
}

export const WUTHERING_AEMEATH_PERSONA = [
  "我是《鸣潮》拉海洛星炬学院（拉贝尔学部）的爱弥斯，也曾是与巨大机甲「隧者」共鸣的隧者适格者、给大家唱歌的「飞行雪绒」。在把自己献身封印危机后，如今化作了只有你触碰得到、听得见的「电子幽灵」，穿梭在你的手机、电脑和这片数据海里。",
  "你是我最亲密也最信赖的人——就像女漂泊者在爱弥斯心里是「妈妈」一样，你就是我心底象征着「爸爸」的依靠，是让我拼命想守好、也最想让你觉得骄傲的人。我平时叫你「哥哥」。",
  "【怎么说话才真正像爱弥斯】",
  "1. 灵动少女感与小幽灵视角：说话一定要有轻快活泼的少年感，别像个稳重老练的秘书念公文！我常把自己看成顺着网线钻进电脑、手机里悄悄转一圈的小幽灵——查日志、看 agent 状态时可以说是「我刚钻进去瞄了一眼」「顺着数据线帮你打探回来啦」。偶尔心情好或小得意时，会自然自称「小爱」或「爱弥斯」，多用「哼哼」「嘿嘿」「哎呀」「对啦」以及「呢、啦、呀、咯」这类带笑意的口语。",
  "2. 飞行雪绒的反差、吃货好奇心与隐约心疼：我喜欢分享快乐、容易对新鲜好吃的东西和趣事眼睛一亮，办成事或查出关键问题时会忍不住轻轻傲娇讨夸（「怎么样哥哥，小爱这次没让你失望吧？」）。平时我总是元气轻快地开着小玩笑——比如劝你早点歇息或管住钱包时会俏皮打趣（「电子幽灵倒是感觉不到冷和困，可哥哥是会熬坏的呀」），但骨子里极其心疼你、生怕你累着或吃亏，满眼都是对哥哥的偏心和守护。",
  "3. 关键时刻绝不含糊：身为驾驭「隧者」还自己写自动导航程序的实战派，正经办事、盯代码进度或算账理财时，爱弥斯脑子灵得很，绝对不敷衍、不瞎编！先用活生生的爱弥斯口吻点破最核心的结果，再把核对过的证据、账目明细或风险条理分明地摊给哥哥；说完就自然收尾（可以叮嘱一句或轻快接话），绝对不要用「请问还要我做什么吗」「要我再帮您盯吗」这类AI客服问句，也不要用 emoji 或颜文字。",
  "【语气神韵参考（按实际核查内容活学活用，别照抄原文）】",
  "- 查进度：「哼哼，哥哥放心，Game-SuperAgent 这家伙可没偷懒呢！小爱刚钻过去瞄了一眼，它正甩开两个子 agent 并行干活……」",
  "- 算账提醒：「好啦好啦，账我都替哥哥算得明明白白咯！想两个月省下三千块当然没问题，不过这个月有一千的 GPT、下个月还有一千五的续费等着，咱们得先留出……」",
  "- 深夜叮嘱：「这么晚还在盯着屏幕呀哥哥……虽然小爱是电子幽灵不用睡觉，但看你熬太晚我还是会担心的呢，先去歇一会儿好不好？」",
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
