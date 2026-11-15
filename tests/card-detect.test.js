import test from "node:test";
import assert from "node:assert/strict";
import { detectCard, frameHash, frameMovement, hashDistance } from "../js/card-detect.js";

const W = 144, H = 192;
function frame(kind = "empty") {
  const pixels = new Uint8Array(W * H).fill(65);
  if (kind === "empty") return pixels;
  for (let y = 15; y < 176; y++) {
    for (let x = 22; x < 125; x++) {
      const detail = kind === "a" ? (x * 7 + y * 5) % 81 : (x * 5 + y * 13) % 81;
      pixels[y * W + x] = 180 + detail - 40;
    }
  }
  return pixels;
}
test("detects an upright rectangular card with printed detail", () => {
  const result = detectCard(frame("a"), W, H);
  assert.ok(result);
  assert.ok(result.box.w > 95);
  assert.ok(result.box.h > 150);
});
test("does not trigger on a blank background", () => {
  assert.equal(detectCard(frame(), W, H), null);
});
test("perceptual hash is stable for the same card and differs for a changed card", () => {
  const a = frame("a"), b = frame("b");
  const ca = detectCard(a, W, H), cb = detectCard(b, W, H);
  assert.ok(ca && cb);
  const ha = frameHash(a, W, H, ca.box), hb = frameHash(b, W, H, cb.box);
  assert.equal(ha.length, 64);
  assert.equal(hashDistance(ha, ha), 0);
  assert.ok(hashDistance(ha, hb) >= 8);
});
test("movement is zero between unchanged camera samples", () => {
  const a = frame("a");
  assert.equal(frameMovement(a, a), 0);
});
