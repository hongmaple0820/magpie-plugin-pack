// gRPC-Web framing: one flag byte, four big-endian length bytes, then JSON.
//
// The reply arrives in the same frames, split across network chunks at
// arbitrary offsets, so decoding has to carry a remainder between reads.

const FLAG_BYTES = 1;
const LENGTH_BYTES = 4;
const HEADER = FLAG_BYTES + LENGTH_BYTES;

export function encodeFrame(jsonText) {
  const body = new TextEncoder().encode(jsonText);
  const out = new Uint8Array(HEADER + body.length);
  out[0] = 0;
  new DataView(out.buffer).setUint32(1, body.length, false);
  out.set(body, HEADER);
  return out;
}

export class FrameDecoder {
  constructor() {
    this.buffer = new Uint8Array(0);
  }

  /** Feed one network chunk, answering every whole frame it completes. */
  push(chunk) {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);

    const out = [];
    let offset = 0;
    while (offset + HEADER <= merged.length) {
      const length = new DataView(merged.buffer, merged.byteOffset + offset).getUint32(1, false);
      if (offset + HEADER + length > merged.length) break;
      const payload = merged.slice(offset + HEADER, offset + HEADER + length);
      out.push(new TextDecoder().decode(payload));
      offset += HEADER + length;
    }
    this.buffer = merged.slice(offset);
    return out;
  }
}
