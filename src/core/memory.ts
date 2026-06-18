export type MemoryItemType = "interaction" | "fact" | "summary";

export type MemoryItem = {
  id: string;
  namespace: string;
  sessionId: string;
  content: string;
  type: MemoryItemType;
  createdAt: Date;
};
