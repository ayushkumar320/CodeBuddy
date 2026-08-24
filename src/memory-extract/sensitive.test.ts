import { describe, expect, it } from "vitest";
import { hasHighEntropyToken, scanSensitive } from "./sensitive.js";

describe("scanSensitive", () => {
  it("flags an AWS access key", () => {
    const result = scanSensitive("key is AKIAIOSFODNN7EXAMPLE here");
    expect(result.sensitive).toBe(true);
    expect(result.reasons).toContain("aws-access-key");
  });

  it("flags a Hugging Face token and a private key header", () => {
    expect(scanSensitive("token hf_abcdefghij0123456789").reasons).toContain("hf-token");
    expect(scanSensitive("-----BEGIN RSA PRIVATE KEY-----").reasons).toContain("private-key");
  });

  it("flags credential assignments and emails", () => {
    expect(scanSensitive("password: hunter2secret").reasons).toContain("credential-assignment");
    expect(scanSensitive("the password is hunter2secret").reasons).toContain(
      "credential-assignment",
    );
    expect(scanSensitive("contact a@b.com").reasons).toContain("email");
  });

  it("flags additional vendor key shapes", () => {
    // Sample tokens are built programmatically so no literal secret-shaped
    // string needs to live in this source file.
    const openaiKey = `sk-ant-api03-${"Ab".repeat(12)}`;
    const googleKey = `AIza${"a".repeat(35)}`;
    const stripeKey = `sk_live_${"a".repeat(24)}`;
    const jwt = `eyJ${"A".repeat(12)}.eyJ${"B".repeat(12)}.${"C".repeat(12)}`;
    const connString = `postgres://admin:${"s3cr3tPass"}@db.internal:5432/app`;
    expect(scanSensitive(`use ${openaiKey} token`).reasons).toContain("openai-key");
    expect(scanSensitive(`GOOGLE=${googleKey}`).reasons).toContain("google-api-key");
    expect(scanSensitive(`stripe ${stripeKey}`).reasons).toContain("stripe-key");
    expect(scanSensitive(`token ${jwt}`).reasons).toContain("jwt");
    expect(scanSensitive(`DB=${connString}`).reasons).toContain("connection-string-credentials");
  });

  it("flags GitHub fine-grained PATs, npm tokens, and GitLab tokens", () => {
    const pat = `github_pat_${"A".repeat(30)}_${"a".repeat(30)}`;
    expect(scanSensitive(`use ${pat} for CI`).reasons).toContain("github-fine-grained-pat");
    const npmToken = `npm_${"Z1x2y3z4".repeat(5).slice(0, 36)}`;
    expect(scanSensitive(`registry token ${npmToken}`).reasons).toContain("npm-token");
    const gitlabToken = `glpat-${"Ab12Cd34Ef56Gh78Ij90".slice(0, 20)}`;
    expect(scanSensitive(`gitlab ${gitlabToken}`).reasons).toContain("gitlab-token");
  });

  it("flags Basic-auth headers and authorization keyword assignments", () => {
    const basic = `Authorization: Basic ${"dXNlcjpwYXNzd29yZA==".slice(0, 8)}${"QQ=="}`;
    expect(scanSensitive(basic).reasons).toContain("basic-auth-header");
    expect(scanSensitive(`authorization = Bq7vWx2mN9pQ`).reasons).toContain(
      "credential-assignment",
    );
  });

  it("routes a bare high-entropy secret to review without a known prefix", () => {
    const result = scanSensitive("The deploy key is Xq7Zp2Lm9Kd4Rt8Vn1Bc6Hf3Ws5Yj0Ga here.");
    expect(result.sensitive).toBe(true);
    expect(result.reasons).toContain("high-entropy-string");
  });

  it("high-entropy heuristic stays quiet on ordinary code and hashes", () => {
    // camelCase identifiers, snake_case, and a git SHA (no upper+lower+digit mix
    // per token) must not trip the heuristic.
    expect(hasHighEntropyToken("const resolveNamespaceFromConfigFile = value")).toBe(false);
    expect(hasHighEntropyToken("PlanFileStore.listPlans parses markdown files")).toBe(false);
    expect(hasHighEntropyToken("commit 97e5bd3d646cfd4c7f314aadb346afd76a99b1bb273")).toBe(false);
  });

  it("does not flag ordinary prose", () => {
    expect(scanSensitive("The parser uses regex to extract imports.").sensitive).toBe(false);
  });
});
