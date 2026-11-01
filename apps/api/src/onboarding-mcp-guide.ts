export const MCP_GUIDE_KEY = "chatgpt-mcp";
export const MCP_GUIDE_TITLE = "ChatGPT 连接与使用 ANote MCP";
export const TUTORIAL_TAG = "平台入门教程";
export function tutorialSource<T extends { tags: string[] }>(source: T): T {
  return { ...source, tags: [...new Set([...source.tags, TUTORIAL_TAG])] };
}
