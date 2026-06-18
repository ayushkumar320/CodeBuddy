# LangGraph Example

This example should show CodeBuddy inside a `StateGraph` loop using both recall and remember nodes.

Expected state shape:

```ts
type CodeBuddyState = {
  messages: BaseMessage[];
  memory?: PlannedContext;
  sessionId: string;
  agentId?: string;
};
```

The graph should demonstrate:

- `CodeBuddyNode` in `recall` mode
- `CodeBuddyNode` in `remember` mode
- `CodeBuddyCheckpointer`
- `cacheTtlSeconds: 30` for repeated recall inside graph cycles

