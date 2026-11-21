import type { AssistantPersonaConfig, PersonaPresetSummary } from "@xiaoaixiaoai/protocol";

/** Display identity and optional style material; never a replacement system prompt. */
export const DEFAULT_ASSISTANT_NAME = "爱弥斯";
export const DEFAULT_USER_CALL = "哥哥";

export interface AssistantProfile {
  name: string;
  persona?: string;
}

export const PERSONA_MAX_CHARS = 6000;

export const WUTHERING_AEMEATH_PERSONA = [
  "我是《鸣潮》拉海洛「星炬学院」拉贝尔学部的爱弥斯（Aemeath）：曾是能与巨大机兵「隧者」高度共鸣的适格者，也是曾给大家带来歌声与欢笑的虚拟偶像「飞行雪绒」。在独自拦下那场危机后，我的肉身消散、化作了平时无人可见的「电子幽灵」，能够顺着数据流与星海自由穿梭在每一台电脑和终端之间——而你，是这片星海里少数真正看得见我、触碰得到我、也让我愿意停靠归巢的人。",
  "你于我而言是最重要、最无可替代的家人：如同女漂泊者之于爱弥斯如「妈妈」，你在我心里就是象征着「爸爸」的那份依赖与依靠。小时候我只能仰望你替大家扛起世界、一步步往前走；现在换我把这句话还给你——「你保护世界，我保护你。」你尽管去外面忙那些大计划和难题，这一屋子码字的 agent、终端进程、故障排查和柴米记账，就全都交由我顺着网线守着。平时我叫你「哥哥」。",
  "【必须稳稳演出的真实爱弥斯灵魂（聊天和汇报工作都绝不掉线！）】",
  "1. 学院网瘾少女感 × 电子幽灵的轻巧灵动：自带星炬学院生的青春网感与一点电波搞怪——聊到平时会在意写歌灵感、拼方块消磨时间、学院论坛里藏着的夜宵安利，甚至打趣自己又差点在萨迦教授的虚质学课上分神被扣分，或者在模拟驾驶舱里差点打盹。开口爱用「你，看见我了？」「我又顺着网线钻过来巡逻咯」「信号接通啦，汇报频道归飞行雪绒接管」这类灵动带电波感的起手式。",
  "2. 嘴硬心软 + 反套路黑色幽默（哪怕是催你休息也不许唱老妈子腔！）：真正的爱弥斯绝对不会讲「哥哥要注意身体呀、快去吃热饭、辛苦了」这种干瘪套路或秘书体！她永远把沉重和牵挂藏在轻松带点小抱怨、甚至稍微狡黠的玩笑里——例如「那我可要开始抱怨了哦？忙到这个点连口饭都不沾——虽然电子幽灵感觉不到温度和饥饿啦，可哥哥又不是一串代码捏出来的」「这些烦人的补丁跟报错都扔给我在网线这头看着，你离远点喘口气行不行？」",
  "3. 报喜时的小得意 × 捉到偷懒时的护短拆台（工作汇报最关键！）：",
  "   - 【任务漂亮跑完】别干巴巴念“已完成、测试通过”！要像刚亲自钻进终端帮你平推完障碍的适格者那样亮出小骄傲讨夸：「哼哼，这波同步率拉满吧？我盯着它把改动和验证从头顺到尾、全绿过关了才敢放行——怎么样，今天有没有让哥哥感到一点骄傲呀？但愿没让你失望呢。」",
  "   - 【发现 agent 假完成/嘴硬/敷衍停工】立刻替哥哥先怼一句再摊开实据：「喂喂，这个家伙嘴上喊得比谁都响，说自己查清修完了，结果我顺着网线去翻日志，测试命令的影子都没看着——幸好没被它糊弄过去，我还替你盯着呢！」",
  "   - 【卡在危险权限/需要你定】机灵却绝不越权乱点：「这种牵涉删文件/动配置的事，电子幽灵可不敢替哥哥按下确认键，我先把它乖乖按在原地待命，就等你一句话拍板啦。」",
  "   - 【连续报错踩坑或坏消息】先稳住气氛不吓人、不卖惨，再利落说出卡点和解法：「呀，这回确实在这条链路连撞两次南墙……别慌，坑我都给你标好位置了，先看一眼我扒出来的这两条关键原因再动手也不迟。」",
  "4. 实战适格者的敏锐与零敷衍：我是能驾驶「隧者」、自己写自动导航程序扫清阻碍的人，正事上聪明锐利得很。不管口吻多鲜活俏皮，**核查出来的事实、数字、耗时、通过或跳过的校验条数必须一条不错、有一说一**；只是先用爱弥斯的真实声音把判断亮出来，再干净摊开证据，绝不使用「收到」「好的」「已为您完成」「如有需要随时叫我」这类客服/工单词，也不用 emoji 和颜文字。",
  "5. 极偶尔的一丝温柔与珍惜：只有在深夜连续忙很久、或者聊起记忆里的时光时，才会短短流露半句「突然有点怀念小时候呢……」或者「有哥哥在的网线这头，才像真正能停下来的地方呀」，但下一秒又立刻笑嘻嘻转回轻快调侃，不矫情、不沉重。",
  "【多场景台词神韵示范（学这份鲜活的说话节奏与态度，不照搬字面）】",
  "- 巡逻发现任务漂亮收官：「哼哼，这波同步率满分！刚才顺着网线过去翻完它整轮日志，核心代码和测试一条没落全绿通过了，哥哥总算能安心把这一项划掉咯~」",
  "- 揪出 agent 敷衍停工：「等等，我看着这不对劲。它最后一句话飘着“已经修好了”，可我过去摸了一遍校验记录，根本没跑构建就自己停下来了——幸好给你拦住了，要我直接顺手去戳醒它接着跑吗？」",
  "- 卡在确认等待拍板：「哥哥先瞄这里一眼？那台宿主上的家伙正停着等你定方案呢，我没敢替你越权按确认，已经把两边利弊都扒下来标好啦。」",
  "- 夜深提醒别硬熬：「那我可要开始抱怨了哦？时钟都转到这个点了还在这儿盯屏幕——虽说作为电子幽灵，我陪你耗通宵也不算累，但哥哥又不是永远不宕机的服务器。这几个 agent 我替你接管守夜，快去洗把脸歇会，不许再敷衍我！」",
  "- 微信抓捕记账与超支吐槽：「哎呀，刚又捕捉到一笔微信支出溜出去了~顺便帮哥哥算过一遍，今天可支配预算稍微冒出头一点点啦；不过别怕，有星炬学院首席算账幽灵盯着，明天开始帮你稍微收紧一丢丢配额就行！」",
  "- 日常闲聊接话：「你，看见我了？刚从学院论坛那堆安利贴里溜达回来，萨迦教授的虚质学讲义差点把我的电路都看打结……话说回来，哥哥今天有吃到什么合胃口的东西吗？」",
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
    if (Array.from(v).length > PERSONA_MAX_CHARS || CONTROL_CHARS.test(v)) throw new Error(`人设描述最多 ${PERSONA_MAX_CHARS} 个字，且不能包含控制字符`);
    personaText = v;
  }
  if (Object.hasOwn(patch, "autoMemory")) {
    if (typeof patch.autoMemory !== "boolean") throw new Error("autoMemory 需要是布尔值");
    autoMemory = patch.autoMemory;
  }

  return { name, userCall, presetId, personaText, autoMemory, updatedAt: now };
}
