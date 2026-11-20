import { MEMORY_CATEGORIES, type AssistantPersonaConfig } from "@xiaoaixiaoai/protocol";
import type { ToolDef } from "./llm.ts";
import { MemoryService, normalizeCategory } from "./memory.ts";

export const MEMORY_TOOL_NAMES = new Set(["remember_fact", "search_memories", "forget_memory"]);

const CATEGORY_DESC = MEMORY_CATEGORIES.map((c) => `${c.id}(${c.label}:${c.hint})`).join("；");

export const MEMORY_TOOLS: ToolDef[] = [
  {
    name: "remember_fact",
    description:
      "保存或更新一条与用户相关的长期私人/生活/工作记忆（存放在中继服务器记忆库，换手机或清屏也不会丢）。如果某类状态有新变化（例如改了作息、换了城市、新忌口），传入相同的 slot_key 会自动覆盖旧事实，防止矛盾。",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: MEMORY_CATEGORIES.map((c) => c.id),
          description: `记忆分类：${CATEGORY_DESC}`,
        },
        content: {
          type: "string",
          description: "简洁清晰的一句事实，例如「咖啡喜欢冰美式不加糖」「每周五晚上七点半去打羽毛球」「对花生过敏」",
        },
        slot_key: {
          type: "string",
          description: "可选英文槽位名，用于“新覆盖旧”（如 city、sleep_time、coffee_pref、birthday、allergy）",
        },
        importance: {
          type: "number",
          description: "重要程度：3=核心常驻档案，2=重要长期信息（默认），1=一般日常琐事",
        },
        pinned: {
          type: "boolean",
          description: "是否置顶永驻（核心称呼、过敏禁忌、重要目标建议设 true）",
        },
        ttl_days: {
          type: "number",
          description: "若为临时日程/短期琐事可传有效天数（例如 7），过期自动清理；长期事实不传",
        },
      },
      required: ["category", "content"],
    },
  },
  {
    name: "search_memories",
    description: "按关键词或分类检索服务器长期记忆库。当用户问“我以前说过… / 我对什么过敏 / 我平时习惯…”或你需要确认历史细节时调用。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词，可选" },
        category: { type: "string", enum: MEMORY_CATEGORIES.map((c) => c.id), description: "按分类筛选，可选" },
        limit: { type: "number", description: "最多返回条数，默认 12" },
      },
    },
  },
  {
    name: "forget_memory",
    description: "删除或忘掉一条过时/记错的记忆（按记忆 id、slot_key 或关键词匹配删除）。",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "记忆 id（mem_...）" },
        slot_key: { type: "string", description: "要清除的槽位名" },
        query: { type: "string", description: "关键词（会删掉最匹配的一条）" },
      },
    },
  },
];

export function memoryPromptSnippet(profile: AssistantPersonaConfig, recalledContext: string): string {
  const modeRule = profile.autoMemory
    ? "当对方在对话或通话里自然提到值得长期记住的个人信息、生活偏好、饮食忌口、作息规律、重要人物、日程约定或工作习惯，且不是一次性闲聊废话或敏感密码密钥时，主动调用 remember_fact 默默记下或用相同 slot_key 更新旧事实。"
    : "对方当前关闭了自动记忆：只有在他明确说「记住 / 记一下 / 别忘了」或要求修改/忘掉时，才调用 remember_fact / forget_memory。";
  const parts = [
    "# 私人与生活记忆能力",
    "你除了帮看电脑上的 agent，也是他身边的私人与生活陪伴助理。记忆库统一保存在你的中继服务器上；清理聊天记录不会清掉记忆库。",
    modeRule,
    recalledContext || "（记忆库目前还没有条目标记，聊到值得记住的生活细节时可以用 remember_fact 慢慢攒起来。）",
  ];
  return parts.join("\n\n");
}

export function runMemoryTool(
  memory: MemoryService,
  name: string,
  input: Record<string, unknown>,
): { out: string; step: string; mutated: boolean } {
  switch (name) {
    case "remember_fact": {
      const { item, replaced } = memory.remember({
        category: input.category,
        content: input.content,
        slotKey: input.slot_key,
        importance: input.importance,
        pinned: input.pinned,
        ttlDays: input.ttl_days,
        source: "assistant",
      });
      return {
        out: `${replaced ? "已更新" : "已记住"}记忆（id=${item.id}，分类=${item.category}${item.slotKey ? `，槽位=${item.slotKey}` : ""}）：${item.content}`,
        step: replaced ? "更新了记忆" : "记下了一条记忆",
        mutated: true,
      };
    }
    case "search_memories": {
      const res = memory.list({
        category: input.category,
        q: typeof input.query === "string" ? input.query : undefined,
        limit: typeof input.limit === "number" ? input.limit : 12,
      });
      if (!res.memories.length) {
        return { out: "记忆库里暂时没有查到相关内容。", step: "查了记忆库", mutated: false };
      }
      const lines = res.memories.map(
        (m) => `- [${m.id}] (${m.category}${m.pinned ? "·核心" : ""}${m.slotKey ? `·${m.slotKey}` : ""}) ${m.content}`,
      );
      return {
        out: `共找到 ${res.memories.length} 条记忆（总库 ${res.total} 条）：\n${lines.join("\n")}`,
        step: `查了记忆库（${res.memories.length} 条）`,
        mutated: false,
      };
    }
    case "forget_memory": {
      const res = memory.forget({
        id: typeof input.id === "string" ? input.id : undefined,
        slotKey: typeof input.slot_key === "string" ? input.slot_key : undefined,
        query: typeof input.query === "string" ? input.query : undefined,
      });
      if (!res.removed) {
        return { out: "没找到匹配的记忆条目，未删除。", step: "尝试忘记记忆", mutated: false };
      }
      return {
        out: `已移除 ${res.removed} 条记忆：${res.items.map((x) => x.content).join("；")}`,
        step: "忘掉了旧记忆",
        mutated: true,
      };
    }
    default:
      throw new Error(`未知记忆工具：${name}`);
  }
}
