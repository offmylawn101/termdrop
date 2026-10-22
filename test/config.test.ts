import { describe, expect, it } from "vitest";
import { currentTransferIdleTimeout, DEFAULTS } from "../src/shared/config";

describe("transfer timeout configuration", () => {
  it("allows a longer mobile return window only before the first chunk", () => {
    expect(currentTransferIdleTimeout(
      true,
      DEFAULTS.RECEIVER_START_TIMEOUT_MS,
      DEFAULTS.TRANSFER_IDLE_TIMEOUT_MS,
    )).toBe(90_000);
    expect(currentTransferIdleTimeout(
      false,
      DEFAULTS.RECEIVER_START_TIMEOUT_MS,
      DEFAULTS.TRANSFER_IDLE_TIMEOUT_MS,
    )).toBe(30_000);
  });
});
