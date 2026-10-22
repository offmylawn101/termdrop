import { describe, expect, it } from "vitest";
import { bannerPlacement } from "../src/frontend/banner-image";

describe("banner image preparation", () => {
  it("keeps an exact 7.5:1 image intact", () => {
    expect(bannerPlacement(1_200, 160)).toEqual({
      destinationX: 0,
      destinationY: 0,
      destinationWidth: 1_200,
      destinationHeight: 160,
    });
  });

  it("fits excess width without cropping", () => {
    expect(bannerPlacement(2_400, 160)).toEqual({
      destinationX: 0,
      destinationY: 40,
      destinationWidth: 1_200,
      destinationHeight: 80,
    });
  });

  it("fits excess height without cropping", () => {
    expect(bannerPlacement(1_000, 1_000)).toEqual({
      destinationX: 520,
      destinationY: 0,
      destinationWidth: 160,
      destinationHeight: 160,
    });
  });
});
