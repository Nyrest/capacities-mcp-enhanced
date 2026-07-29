import { describe, expect, test } from "bun:test";
import { CapacitiesApiError } from "@capacities/api";
import { formatError } from "../src/lib/client";

describe("agent-facing API errors", () => {
  test("collapses HTML rate-limit responses into a concise retry instruction", () => {
    const formatted = formatError(
      new CapacitiesApiError(
        429,
        "cap_rate_limit_exceeded",
        "<!doctype html><html>large Cloudflare response</html>",
      ),
    );

    expect(formatted).toContain("Endpoint rate limit exceeded");
    expect(formatted).toContain("RateLimit reset window");
    expect(formatted).not.toContain("<html>");
  });

  test("keeps concise JSON API messages", () => {
    expect(
      formatError(
        new CapacitiesApiError(
          400,
          "cap_invalid_input",
          "Invalid block hierarchy.",
        ),
      ),
    ).toContain("Invalid block hierarchy.");
  });
});
