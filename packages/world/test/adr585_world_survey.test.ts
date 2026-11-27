import { describe, expect, it } from "vitest";
import { PREVIEW, SURVEY_STRIDES, ProceduralGenerator, computeSpawnPoints, sampleWorldPreview, sampleWorldSurvey, surveyWorldAt, worldPreviewSvg, worldToSurveyPixel } from "../src/index.js";

/**
 * ADR-585: the world-generation survey — one fixed 128 x 128 sample grid taken at a ladder
 * of strides centred on the spawn area, so the generation screen can zoom from street
 * detail out to a multi-region survey at the same sampling cost, with the seed's spawn
 * points and (ADR-586) abandoned structures marked on it.
 */
describe("ADR-585 world survey", () => {
  it("stride ladder is increasing, keeps the legacy 12 and the default 24, and stops at 48", () => {
    expect([...SURVEY_STRIDES]).toEqual([3, 6, 12, 24, 48]);
    for (let i = 1; i < SURVEY_STRIDES.length; i++) expect(SURVEY_STRIDES[i]!).toBeGreaterThan(SURVEY_STRIDES[i - 1]!);
  });

  it("the stride-12 survey is exactly the legacy preview", () => {
    const survey = sampleWorldSurvey(424242, 12);
    const legacy = sampleWorldPreview(424242);
    expect(survey.seed).toBe(424242);
    expect(survey.stride).toBe(12);
    expect(survey.x).toBe(PREVIEW.x); expect(survey.y).toBe(PREVIEW.y);
    expect(survey.tiles).toEqual(legacy.tiles);
    expect(survey.heights).toEqual(legacy.heights);
  });

  it("surveys stay centred on the spawn area at every stride", () => {
    for (const stride of SURVEY_STRIDES) {
      const s = sampleWorldSurvey(7, stride);
      expect(s.x).toBe(-(PREVIEW.width * stride) / 2);
      expect(s.y).toBe(-(PREVIEW.height * stride) / 2);
      const centre = surveyWorldAt(s, PREVIEW.width / 2, PREVIEW.height / 2);
      expect(Math.abs(centre.x)).toBeLessThanOrEqual(stride);
      expect(Math.abs(centre.y)).toBeLessThanOrEqual(stride);
    }
  });

  it("worldToSurveyPixel inverts surveyWorldAt", () => {
    const s = sampleWorldSurvey(99, 24);
    for (const [px, py] of [[0, 0], [30, 90], [64, 64], [127, 127]] as const) {
      const w = surveyWorldAt(s, px, py);
      const back = worldToSurveyPixel(s, w.x + 0.5, w.y + 0.5);
      expect(Math.abs(back.px - px)).toBeLessThan(1);
      expect(Math.abs(back.py - py)).toBeLessThan(1);
    }
  });

  it("all four spawn points land on the survey, clustered around its centre", () => {
    const gen = new ProceduralGenerator({ seed: 424242 });
    const s = sampleWorldSurvey(gen, 24);
    const spawns = computeSpawnPoints(gen);
    expect(spawns.length).toBe(4);
    for (const p of spawns) {
      const px = worldToSurveyPixel(s, p.x, p.y);
      expect(px.px).toBeGreaterThan(48); expect(px.px).toBeLessThan(80);
      expect(px.py).toBeGreaterThan(48); expect(px.py).toBeLessThan(80);
    }
  });

  it("the SVG draws spawn rings and ruin diamonds only when markers are passed", () => {
    const s = sampleWorldSurvey(424242, 24);
    const plain = worldPreviewSvg(s);
    expect(plain).not.toContain("#ffb347");
    expect(plain).not.toContain("<circle");
    const marked = worldPreviewSvg(s, { spawns: [{ px: 64, py: 58 }], ruins: [{ px: 10, py: 20 }, { px: 500, py: 500 }] });
    expect(marked).toContain("#ffb347"); // ruin diamond fill
    expect(marked).toContain("<circle"); // spawn ring
    expect(marked).toContain("M10 17.4"); // the on-survey ruin's diamond
    expect(marked).not.toContain("M500"); // the off-survey ruin is dropped, not drawn at 500
  });
});
