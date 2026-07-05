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
    expect(scanSensitive("use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv token").reasons).toContain(
      "openai-key",
    );
    expect(scanSensitive("GOOGLE=AIzaabcdefghijklmnopqrstuvwxyz123456789").reasons).toContain(
      "google-api-key",
    );
    expect(scanSensitive("stripe sk_live_abcdefghijklmnop123456").reasons).toContain("stripe-key");
    expect(
      scanSensitive("token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3.abcDEF123456")
        .reasons,
    ).toContain("jwt");
    expect(scanSensitive("DB=postgres://admin:s3cr3tPass@db.internal:5432/app").reasons).toContain(
      "connection-string-credentials",
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
