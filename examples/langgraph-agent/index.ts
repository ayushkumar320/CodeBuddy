import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import { Annotation, StateGraph } from "@langchain/langgraph";
import type { PlannedContext } from "codebuddy";
import { createRuntime } from "codebuddy";
import { CodeBuddyCheckpointer, CodeBuddyNode } from "codebuddy/langgraph";

const postgresUrl = process.env.DATABASE_URL;
if (!postgresUrl) {
  throw new Error("DATABASE_URL is required.");
}

const runtime = await createRuntime({
  postgresUrl,
  provider: { type: "huggingface", apiKey: process.env.HF_TOKEN },
  namespace: "langgraph-agent",
  tokenBudget: 4000,
});
const { memory } = runtime;

const State = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  memory: Annotation<PlannedContext | undefined>({
    reducer: (_, right) => right,
    default: () => undefined,
  }),
  sessionId: Annotation<string>({
    reducer: (_, right) => right,
  }),
  agentId: Annotation<string | undefined>({
    reducer: (_, right) => right,
    default: () => undefined,
  }),
});

async function agentNode(state: typeof State.State) {
  const facts = state.memory?.messages.map((message) => message.content).join("\n") ?? "";
  return {
    messages: [
      new HumanMessage(
        facts
          ? `Agent saw recalled memory:\n${facts}`
          : "Agent had no recalled memory for this turn.",
      ),
    ],
  };
}

const graph = new StateGraph(State)
  .addNode("recall", new CodeBuddyNode({ memory, mode: "recall", cacheTtlSeconds: 30 }))
  .addNode("agent", agentNode)
  .addNode("remember", new CodeBuddyNode({ memory, mode: "remember" }))
  .addEdge("__start__", "recall")
  .addEdge("recall", "agent")
  .addEdge("agent", "remember")
  .addEdge("remember", "__end__")
  .compile({ checkpointer: new CodeBuddyCheckpointer({ namespace: "langgraph-agent" }) });

const result = await graph.invoke(
  {
    messages: [new HumanMessage("What do we know about deployment?")],
    sessionId: "sess_langgraph_example",
    agentId: "agent-langgraph",
  },
  { configurable: { thread_id: "thread_langgraph_example" } },
);

console.log(result.messages.at(-1)?.content);
await runtime.close();
