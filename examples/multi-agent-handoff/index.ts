import { createRuntime } from "codebuddy";

const postgresUrl = process.env.DATABASE_URL;
if (!postgresUrl) {
  throw new Error("DATABASE_URL is required.");
}

const base = {
  postgresUrl,
  provider: { type: "huggingface" as const, apiKey: process.env.HF_TOKEN },
  tokenBudget: 4000,
};

const research = await createRuntime({
  ...base,
  namespace: "research-agent",
});

const ops = await createRuntime({
  ...base,
  namespace: "ops-agent",
});

try {
  const remembered = await research.memory.remember({
    sessionId: "sess_handoff_example",
    content: "The deployment target is eu-west-1 and requires layer-cached Docker builds.",
    type: "fact",
    idempotencyKey: "handoff:deployment-target:v1",
    agentId: "agent-research",
  });

  console.log("remembered", remembered);

  const referenceShare = await research.memory.share({
    from: "research-agent",
    to: "ops-agent",
    factIds: [remembered.id],
    mode: "reference",
    agentId: "agent-research",
  });

  console.log("reference share", referenceShare);

  const opsRecall = await ops.memory.recall({
    sessionId: "sess_handoff_example",
    query: "What deployment target should ops use?",
    callerModel: "meta-llama/Llama-3.2-3B-Instruct",
  });

  console.log("ops recalled messages");
  for (const message of opsRecall.messages) {
    console.log("-", message.content);
  }

  const snapshotShare = await research.memory.share({
    from: "research-agent",
    to: "ops-agent",
    factIds: [remembered.id],
    mode: "snapshot",
    agentId: "agent-research",
  });

  console.log("snapshot share", snapshotShare);
} finally {
  await research.close();
  await ops.close();
}
