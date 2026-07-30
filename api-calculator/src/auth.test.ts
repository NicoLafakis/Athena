import { describe, expect, it } from "vitest";
import { isAuthorized, sha256 } from "./auth";

describe("API calculator report auth", () => {
  it("accepts the VMP-generated bearer key by SHA-256 hash", () => {
    const request = new Request("https://producer.example/api/vmp/report", {
      headers: { authorization: "Bearer vmp_live_test_key" },
    });

    expect(isAuthorized(request, sha256("vmp_live_test_key"))).toBe(true);
  });

  it("rejects missing, malformed, or wrong bearer credentials", () => {
    expect(isAuthorized(new Request("https://producer.example/api/vmp/report"), sha256("key"))).toBe(false);
    expect(
      isAuthorized(
        new Request("https://producer.example/api/vmp/report", {
          headers: { authorization: "Bearer wrong" },
        }),
        sha256("key"),
      ),
    ).toBe(false);
    expect(
      isAuthorized(
        new Request("https://producer.example/api/vmp/report", {
          headers: { authorization: "Bearer key" },
        }),
        "not-a-sha256",
      ),
    ).toBe(false);
  });
});
