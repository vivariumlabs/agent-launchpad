// SPEC-M4D R1 — minimal in-house CBOR (RFC 8949) codec for the AWS Nitro NSM attestation document.
// Pure, no deps (ans104/protobuf in-house precedent).
//
// DECODER — the NSM subset only:
//   major 0 uint, 1 negint, 2 bstr, 3 tstr (UTF-8, fatal), 4 array, 5 map (keys: int | tstr, no
//   duplicates), 7/22 null. Arguments 0..23 inline, 24/25/26/27 ⇒ 1/2/4/8-byte big-endian; an
//   8-byte argument must be ≤ Number.MAX_SAFE_INTEGER. Top level must consume every byte.
//   REJECTED LOUDLY: tags (major 6), floats / true / false / undefined / other simple values,
//   reserved additional-info 28..30, and indefinite length for bstr / tstr / array.
//   ONE deliberate exception (live-fixture fact, see the M4D report): an indefinite-length MAP
//   (0xbf … 0xff) is accepted, because every real NSM payload is encoded that way (the Nitro
//   NSM's serde_cbor writes the attestation-doc map with unknown length: both golden quotes'
//   payloads start with 0xbf). The reference decoders (cbor2 / serde_cbor) accept it too.
//
// ENCODER — only what COSE_Sign1 verification needs: Sig_structure
//   ["Signature1", protected: bstr, external_aad: bstr, payload: bstr]
// in definite-length, preferred (shortest-argument) serialization — RFC 8949 §4.1, which is what
// cbor2's default encode (the reference's call) and the COSE spec (RFC 9052 §4.4) produce.

export class CborError extends Error {
  constructor(message: string) {
    super(`CBOR: ${message}`);
    this.name = "CborError";
  }
}

export type CborValue = number | string | Uint8Array | null | CborValue[] | CborMap;
export type CborMap = Map<number | string, CborValue>;

const MAX_DEPTH = 16;

class Reader {
  pos = 0;
  constructor(readonly b: Uint8Array) {}

  need(n: number): void {
    if (n < 0 || this.pos + n > this.b.length) throw new CborError(`truncated: need ${n} byte(s) at offset ${this.pos}, have ${this.b.length - this.pos}`);
  }

  u8(): number {
    this.need(1);
    return this.b[this.pos++]!;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** The argument for additional-info `ai` (0..27). */
  arg(ai: number): number {
    if (ai < 24) return ai;
    if (ai === 24) return this.u8();
    if (ai === 25) {
      const x = this.bytes(2);
      return (x[0]! << 8) | x[1]!;
    }
    if (ai === 26) {
      const x = this.bytes(4);
      return ((x[0]! << 24) >>> 0) + ((x[1]! << 16) | (x[2]! << 8) | x[3]!);
    }
    if (ai === 27) {
      const x = this.bytes(8);
      let v = 0n;
      for (const byte of x) v = (v << 8n) | BigInt(byte);
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError(`64-bit argument ${v} exceeds MAX_SAFE_INTEGER`);
      return Number(v);
    }
    if (ai === 31) throw new CborError(`indefinite length not supported here (offset ${this.pos - 1})`);
    throw new CborError(`reserved additional info ${ai} at offset ${this.pos - 1}`);
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function item(r: Reader, depth: number): CborValue {
  if (depth > MAX_DEPTH) throw new CborError(`nesting deeper than ${MAX_DEPTH}`);
  const at = r.pos;
  const ib = r.u8();
  const major = ib >> 5;
  const ai = ib & 0x1f;
  switch (major) {
    case 0:
      return r.arg(ai);
    case 1: {
      const v = -1 - r.arg(ai);
      if (!Number.isSafeInteger(v)) throw new CborError(`negative integer at offset ${at} below MIN_SAFE_INTEGER`);
      return v;
    }
    case 2:
      if (ai === 31) throw new CborError(`indefinite-length byte string at offset ${at}`);
      return r.bytes(r.arg(ai)).slice();
    case 3: {
      if (ai === 31) throw new CborError(`indefinite-length text string at offset ${at}`);
      try {
        return utf8.decode(r.bytes(r.arg(ai)));
      } catch (e) {
        if (e instanceof CborError) throw e;
        throw new CborError(`text string at offset ${at} is not valid UTF-8`);
      }
    }
    case 4: {
      if (ai === 31) throw new CborError(`indefinite-length array at offset ${at}`);
      const n = r.arg(ai);
      r.need(n); // every item is ≥ 1 byte: bound the allocation by the input
      const out: CborValue[] = [];
      for (let i = 0; i < n; i++) out.push(item(r, depth + 1));
      return out;
    }
    case 5: {
      const m: CborMap = new Map();
      const put = (): void => {
        const kAt = r.pos;
        const k = item(r, depth + 1);
        if (typeof k !== "number" && typeof k !== "string") throw new CborError(`map key at offset ${kAt} is not an integer or text string`);
        if (m.has(k)) throw new CborError(`duplicate map key ${JSON.stringify(k)} at offset ${kAt}`);
        m.set(k, item(r, depth + 1));
      };
      if (ai === 31) {
        // Indefinite-length map (the NSM payload encoding) — pairs until the 0xff break.
        for (;;) {
          r.need(1);
          if (r.b[r.pos] === 0xff) {
            r.pos++;
            return m;
          }
          put();
        }
      }
      const n = r.arg(ai);
      r.need(2 * n);
      for (let i = 0; i < n; i++) put();
      return m;
    }
    case 6:
      throw new CborError(`tag at offset ${at} not supported`);
    default: {
      // major 7
      if (ib === 0xf6) return null;
      if (ib === 0xff) throw new CborError(`unexpected break at offset ${at}`);
      throw new CborError(`simple/float value 0x${ib.toString(16)} at offset ${at} not supported`);
    }
  }
}

/** Decodes exactly one CBOR item spanning all of `bytes` (trailing bytes ⇒ throw). */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const r = new Reader(bytes);
  const v = item(r, 0);
  if (r.pos !== bytes.length) throw new CborError(`${bytes.length - r.pos} trailing byte(s) after offset ${r.pos}`);
  return v;
}

/** Preferred-serialization head: major type + shortest argument form. */
function head(major: number, n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new CborError(`bad length ${n}`);
  const m = major << 5;
  if (n < 24) return Uint8Array.of(m | n);
  if (n < 0x100) return Uint8Array.of(m | 24, n);
  if (n < 0x10000) return Uint8Array.of(m | 25, n >> 8, n & 0xff);
  if (n < 0x100000000) return Uint8Array.of(m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  const out = new Uint8Array(9);
  out[0] = m | 27;
  let v = BigInt(n);
  for (let i = 8; i >= 1; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const SIGNATURE1 = new TextEncoder().encode("Signature1");

/**
 * COSE_Sign1 Sig_structure (RFC 9052 §4.4): the definite 4-array
 * ["Signature1", protected, external_aad, payload] — 0x84, tstr(10) "Signature1", then three bstrs.
 */
export function encodeSigStructure1(protectedHeader: Uint8Array, externalAad: Uint8Array, payload: Uint8Array): Uint8Array {
  return concat([
    head(4, 4),
    head(3, SIGNATURE1.length),
    SIGNATURE1,
    head(2, protectedHeader.length),
    protectedHeader,
    head(2, externalAad.length),
    externalAad,
    head(2, payload.length),
    payload,
  ]);
}
