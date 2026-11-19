/** Display identity and optional style material; never a replacement system prompt. */
export const DEFAULT_ASSISTANT_NAME = "爱弥斯";

export interface AssistantProfile {
  name: string;
  persona?: string;
}
