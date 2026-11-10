// Minimal RFC 6455 WebSocket client, dependency-free (node:net + node:crypto).
// It serves exactly one master: the DevTools protocol of the browser the
// web-login engine drives, which speaks one text frame per message. Ping,
// pong, close and fragmentation are still handled, because a real Chrome
// does send them. Nothing here is exported beyond wsConnect on purpose.

import net from "node:net";
import crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 32 * 1024 * 1024;

export function wsConnect({ host, port, path = "/" }, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const socket = net.connect({ host, port });
    let buffer = Buffer.alloc(0);
    let handshaked = false;
    let closed = false;
    let fragments = [];
    let fragmentLength = 0;
    let messageHandler = null;
    let closeHandler = null;

    const connection = {
      get open() {
        return handshaked && !closed;
      },
      send(text) {
        if (!handshaked || closed) throw new Error("ws: not connected");
        socket.write(encodeFrame(String(text), 0x1));
      },
      close() {
        if (closed) return;
        if (handshaked) {
          try {
            socket.write(encodeFrame("", 0x8));
          } catch {}
          setTimeout(() => socket.destroy(), 500).unref?.();
        } else {
          socket.destroy();
        }
      },
      onMessage(fn) {
        messageHandler = fn;
      },
      onClose(fn) {
        closeHandler = fn;
      },
    };

    const timer = setTimeout(() => fail(new Error("ws: handshake timeout")), timeoutMs);

    function fail(error) {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
      try {
        closeHandler?.();
      } catch {}
    }

    socket.on("error", (error) => fail(error));
    socket.on("close", () => {
      if (!closed) {
        closed = true;
        clearTimeout(timer);
        try {
          closeHandler?.();
        } catch {}
      }
    });
    socket.on("connect", () => {
      socket.write(
        "GET " + path + " HTTP/1.1\r\n" +
          "Host: " + host + ":" + port + "\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Key: " + key + "\r\n" +
          "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshaked) {
        const split = buffer.indexOf("\r\n\r\n");
        if (split === -1) return;
        const head = buffer.subarray(0, split).toString("latin1");
        buffer = buffer.subarray(split + 4);
        if (!/^HTTP\/1\.1 101/.test(head)) {
          return fail(new Error("ws: handshake refused: " + head.split("\r\n")[0]));
        }
        const expected = crypto.createHash("sha1").update(key + GUID).digest("base64");
        const accept = /^sec-websocket-accept:\s*(.+?)\s*$/im.exec(head)?.[1];
        if (accept !== expected) return fail(new Error("ws: bad Sec-WebSocket-Accept"));
        handshaked = true;
        clearTimeout(timer);
        resolve(connection);
      }
      processFrames();
    });

    function processFrames() {
      while (!closed) {
        const frame = decodeFrame();
        if (!frame) return;
        const { fin, opcode, payload } = frame;
        if (opcode === 0x8) {
          closed = true;
          try {
            socket.write(encodeFrame("", 0x8));
          } catch {}
          socket.destroy();
          try {
            closeHandler?.();
          } catch {}
          return;
        }
        if (opcode === 0x9) {
          socket.write(encodeFramePayload(payload, 0xa));
          continue;
        }
        if (opcode === 0xa) continue;
        fragments.push(payload);
        fragmentLength += payload.length;
        if (fragmentLength > MAX_MESSAGE) {
          closed = true;
          socket.destroy();
          try {
            closeHandler?.();
          } catch {}
          return;
        }
        if (fin) {
          const message = Buffer.concat(fragments).toString("utf8");
          fragments = [];
          fragmentLength = 0;
          try {
            messageHandler?.(message);
          } catch {}
        }
      }
    }

    function decodeFrame() {
      if (buffer.length < 2) return null;
      const b0 = buffer[0];
      const b1 = buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < offset + 2) return null;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return null;
        length = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      let maskKey = null;
      if (masked) {
        if (buffer.length < offset + 4) return null;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return null;
      let payload = buffer.subarray(offset, offset + length);
      if (masked) {
        const out = Buffer.from(payload);
        for (let i = 0; i < out.length; i++) out[i] ^= maskKey[i & 3];
        payload = out;
      }
      buffer = buffer.subarray(offset + length);
      return { fin, opcode, payload };
    }
  });
}

function encodeFrame(text, opcode) {
  return encodeFramePayload(Buffer.from(String(text), "utf8"), opcode);
}

function encodeFramePayload(payload, opcode) {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, body]);
}
