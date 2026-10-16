import type * as THREE from 'three/webgpu';

/**
 * Marks only the first `count` instances of instanced attributes for upload. Without this a
 * change uploads the whole (capacity-sized) buffer every time.
 */
export function uploadLive(
  count: number,
  ...attrs: (THREE.BufferAttribute | THREE.InterleavedBufferAttribute)[]
) {
  for (const a of attrs) {
    const attr = a as THREE.BufferAttribute;
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, Math.max(1, count) * attr.itemSize);
    attr.needsUpdate = true;
  }
}

/** Marks instances [first, last] (inclusive) of instanced attributes for upload. */
export function uploadSlots(
  first: number,
  last: number,
  ...attrs: (THREE.BufferAttribute | THREE.InterleavedBufferAttribute)[]
) {
  if (last < first) return;
  for (const a of attrs) {
    const attr = a as THREE.BufferAttribute;
    attr.clearUpdateRanges();
    attr.addUpdateRange(first * attr.itemSize, (last - first + 1) * attr.itemSize);
    attr.needsUpdate = true;
  }
}
