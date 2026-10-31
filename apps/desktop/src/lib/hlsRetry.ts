import type { LoadPolicy, RetryConfig } from "hls.js";

/**
 * The Twitch VOD relay can only report a CDN failure halfway through a segment by closing the
 * response early, which the WebView turns into status 0. hls.js treats status 0 as a CORS error
 * and doesn't retry it while online (the old msvod:// scheme answered with a retryable 502), so
 * the segment's quality level would be written off instead. Count it as a retryable failure.
 */
export const retryDroppedResponses: NonNullable<RetryConfig["shouldRetry"]> = (
  config,
  retryCount,
  _isTimeout,
  response,
  retry
) => retry || (!!config && response?.code === 0 && retryCount < config.maxNumRetry);

export function withDropRetry(policy: LoadPolicy): LoadPolicy {
  const { errorRetry } = policy.default;
  return {
    default: {
      ...policy.default,
      errorRetry: errorRetry && { ...errorRetry, shouldRetry: retryDroppedResponses },
    },
  };
}
