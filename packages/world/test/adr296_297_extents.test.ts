import { expect, it } from "vitest";
import { Chunk, ChunkManager, CHUNK_AREA, WORLD_TILE_DIAMETER, WORLD_TILE_HALF_EXTENT, worldTileKey, worldTileFromKey, flowWaterRaw, terrainLevel, renderTileHeight, encodeChunk, decodeChunk } from "../src/index.js";

it("ADR-296: doubles each supported side; near/far interest has identical bounded tile storage", () => {
  expect(WORLD_TILE_DIAMETER).toBe(262144);
  expect(WORLD_TILE_DIAMETER ** 2 / 131072 ** 2).toBe(4);
  const cm = new ChunkManager({provider:{load:(cx,cy)=>({chunk:new Chunk(cx,cy),nodes:[]})},loadRadius:2,cacheSize:8,maxLoadsPerUpdate:2});
  for(const x of [0,100000,-100000,WORLD_TILE_HALF_EXTENT-128]) {
    cm.setSource({id:1,x,y:x}); for(let i=0;i<13;i++) cm.update();
    expect(cm.activeKeys.size).toBe(25); expect(cm.chunkCount).toBeLessThanOrEqual(33);
    expect(cm.chunkCount*CHUNK_AREA).toBeLessThanOrEqual(33792);
    expect(worldTileFromKey(worldTileKey(x,x))).toEqual([x,x]);
  }
});
it("ADR-297: every height, including flowed water, round-trips the unchanged byte codec", () => {
  const c=new Chunk(0,0);
  for(let level=-60;level<=75;level++) {
    c.set(0,0,1); c.setHeight(0,0,flowWaterRaw(level));
    const b=decodeChunk(encodeChunk(c)).chunk;
    expect(terrainLevel(1,b.getHeight(0,0))).toBe(level);
    expect(renderTileHeight(1,b.getHeight(0,0))).toBe(level);
    c.set(0,0,4);c.setHeight(0,0,level);
    expect(decodeChunk(encodeChunk(c)).chunk.getHeight(0,0)).toBe(level);
  }
});
