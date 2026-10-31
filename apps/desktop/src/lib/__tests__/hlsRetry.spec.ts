import { describe, it, expect } from "vitest";
import type { LoadPolicy, RetryConfig } from "hls.js";
import { retryDroppedResponses, withDropRetry } from "../hlsRetry";

const config: RetryConfig = { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 8000 };
const response = (code: number) => ({ url: "http://127.0.0.1/seg.ts", code, text: "" });

describe("retryDroppedResponses", () => {
  it("should retry a response the relay cut short (status 0) until retries run out", () => {
    // Act / Assert
    expect(retryDroppedResponses(config, 0, false, response(0), false)).toBe(true);
    expect(retryDroppedResponses(config, 3, false, response(0), false)).toBe(false);
  });

  it("should keep hls.js' own answer for everything else", () => {
    // Act / Assert
    expect(retryDroppedResponses(config, 0, false, response(404), false)).toBe(false);
    expect(retryDroppedResponses(config, 0, false, response(503), true)).toBe(true);
    expect(retryDroppedResponses(null, 0, false, response(0), false)).toBe(false);
  });
});

describe("withDropRetry", () => {
  it("should add the check to error retries and leave the rest of the policy alone", () => {
    // Arrange
    const policy: LoadPolicy = {
      default: {
        maxTimeToFirstByteMs: 10_000,
        maxLoadTimeMs: 120_000,
        timeoutRetry: config,
        errorRetry: config,
      },
    };

    // Act
    const next = withDropRetry(policy);

    // Assert
    expect(next.default.errorRetry?.shouldRetry).toBe(retryDroppedResponses);
    expect(next.default.timeoutRetry).toBe(config);
    expect(next.default.maxLoadTimeMs).toBe(120_000);
    expect(policy.default.errorRetry?.shouldRetry).toBeUndefined();
  });
});
