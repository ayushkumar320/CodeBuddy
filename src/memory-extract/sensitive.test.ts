import { describe, expect, it } from "vitest";
import { scanSensitive } from "./sensitive.js";

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

  it("does not flag ordinary prose", () => {
    expect(scanSensitive("The parser uses regex to extract imports.").sensitive).toBe(false);
  });
});
