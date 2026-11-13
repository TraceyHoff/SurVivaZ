/**
 * ADR-388: the render path is ready to pick up dedicated crouch_idle / crouch_walk frames by key
 * (ADR-241 chain). Art shipped those clips in 5eb3c037; the idle / walk fallback stays for streaming pages or a missing layer.
 */
import { describe, expect, it } from "vitest";
import { AnimState } from "@engine/core";
import { CROUCH_IDLE, CROUCH_WALK, animChainFor } from "../src/character/animChain.js";
import { warmupAtlasTier, isWarmupCandidate } from "../src/assets/warmup.js";
import { isCrouchPageKey, isLazyDollPageKey, shouldPrefetchAtlas, collectWarmupPrefetchUrls } from "../src/assets/asset-fetch.js";
import { PAGE_UPLOADS_PER_FRAME } from "../src/assets/atlasManager.js";

describe("ADR-388 crouch anim keys", () => {
  it("asks for crouch_idle / crouch_walk first and keeps the v1 idle / walk fallback", () => {
    expect(CROUCH_IDLE).toEqual(["crouch_idle", "idle"]);
    expect(CROUCH_WALK).toEqual(["crouch_walk", "crouch_idle", "walk", "idle"]);
    expect(animChainFor(AnimState.Crouch, { moving: false })).toEqual(CROUCH_IDLE);
    expect(animChainFor(AnimState.Crouch, { moving: true })).toEqual(CROUCH_WALK);
  });
});

describe("ADR-388 crouch pages on the live client path", () => {
  it("streams cz_crouch_* like ride pages: wear-pool, no boot prefetch, warmup tier 4", () => {
    expect(isCrouchPageKey("cz_crouch_body_0")).toBe(true);
    expect(isLazyDollPageKey("cz_crouch_top_0")).toBe(true);
    expect(isCrouchPageKey("cz_ride_body_0")).toBe(false);
    expect(warmupAtlasTier("cz_crouch_body_0")).toBe(4);
    expect(isWarmupCandidate("cz_crouch_shoes_0")).toBe(false);
    expect(shouldPrefetchAtlas("cz_crouch_hair_0", "atlases/cz_crouch_hair_0.png", "stream")).toBe(false);
    expect(collectWarmupPrefetchUrls({ atlases: [{ key: "cz_crouch_body_0", image: "atlases/cz_crouch_body_0.png", residency: "stream" }] }, "/")).toEqual([]);
  });

  it("caps GPU page-ins at 2 per frame so a first crouch cannot stall a phone frame, and the chain is shared by every human doll", () => {
    // Players, AI humans and hired workers all go through animChainFor(AnimState.Crouch) (view.ts character: true).
    // While a cz_crouch_* page is still streaming, sprites.ts falls back to idle (same as ride pages).
    expect(PAGE_UPLOADS_PER_FRAME).toBe(2);
    expect(animChainFor(AnimState.Crouch, { moving: false })).toEqual(CROUCH_IDLE);
    expect(animChainFor(AnimState.Crouch, { moving: true })).toEqual(CROUCH_WALK);
  });
});
