/**
 * Incremental RESP2/3 decoder for the measured transport: command replies and dedicated-stream events are counted
 * here before they are decoded. (Topology discovery and the fixed-size scalar commands left on node-redis are not
 * measured by this reader; see docs/ARCHITECTURE.md, "Availability guards".)
 */
import { ErrorReply, RESP_TYPES, type TypeMapping } from 'redis';
import { HttpError } from '../http/errors.ts';

export const MAX_REPLY_ELEMENTS = 100_000;
export const MAX_REPLY_DEPTH = 32;
/** 413 naming the configured per-reply cap (`maxReadReplyBytes` or a fixed internal cap), never a leftover budget. */
export function replyTooLarge(cap: number, what = `Redis reply exceeded the ${cap}-byte read limit.`): HttpError {
  return new HttpError('too_large', what, { hint: `Replies are limited to ${cap} bytes (and 100,000 values); narrow the read with SCAN/COUNT/ranges.` });
}
/** 413 for a typed request whose Redis replies together used up its cumulative read budget. */
export function budgetTooLarge(cap: number): HttpError {
  return replyTooLarge(cap, `The Redis replies of this request exceeded its combined ${cap}-byte read budget.`);
}
/** A string an event reader kept only the start of (`retain`); `total` is its full size in bytes. */
export class RespTruncated {
  readonly head: Buffer | string;
  readonly total: number;
  constructor(head: Buffer | string, total: number) { this.head = head; this.total = total; }
}
export interface RespReaderOptions {
  /**
   * Event mode (pub/sub, MONITOR): keep at most this many bytes of each string and skip the rest, so one oversized
   * event is delivered cut instead of ending the stream. Wire bytes are then not capped; retained bytes are.
   */
  retain?: number;
  /** The configured cap to report when `maxBytes` is a smaller remaining budget. */
  cap?: number;
}
const malformed = (): never => { throw new HttpError('redis_error', 'Malformed Redis reply.'); };
export class RespPush extends Array<unknown> {}

type Frame = { type: string; left: number; values: unknown[] };
type Bulk = { type: string; data: Buffer; offset: number; trailer: number; total: number };
const MAX_LINE = 65_536;
export class RespReader {
  readonly maxBytes: number;
  readonly #mapping: TypeMapping;
  readonly #maxElements: number;
  readonly #maxDepth: number;
  readonly #retain: number;
  readonly #cap: number;
  #bytes = 0;
  #elements = 0;
  /** Payload bytes retained (allocated bulk data and kept text lines). */
  #retained = 0;
  #lineSkipped = 0;
  #stack: Frame[] = [];
  #bulk: Bulk | undefined;
  #prefix = '';
  // RESP numeric/aggregate headers are tiny; simple strings/errors have a separate 64 KiB structural ceiling.
  #line = Buffer.alloc(256);
  #lineLength = 0;
  #cr = false;
  #done = false;
  #value: unknown;
  constructor(maxBytes: number, mapping: TypeMapping = {}, maxElements = MAX_REPLY_ELEMENTS, maxDepth = MAX_REPLY_DEPTH, opts: RespReaderOptions = {}) {
    this.maxBytes = maxBytes;
    this.#mapping = mapping;
    this.#maxElements = maxElements;
    this.#maxDepth = maxDepth;
    this.#retain = opts.retain ?? 0;
    this.#cap = opts.cap ?? maxBytes;
  }
  #tooLarge(what?: string): HttpError {
    if (what) return replyTooLarge(this.#cap, what);
    return this.#cap > this.maxBytes ? budgetTooLarge(this.#cap) : replyTooLarge(this.#cap);
  }
  get bytes(): number { return this.#bytes; }
  get done(): boolean { return this.#done; }
  get value(): unknown { return this.#value; }
  feed(chunk: Buffer, allowTrailing = false): number {
    for (let i = 0; i < chunk.length;) {
      if (this.#done) { if (allowTrailing) return i; malformed(); } // no pipelining: extra replies would poison the next borrower
      const bulk = this.#bulk;
      if (bulk) {
        if (bulk.offset < bulk.total) {
          const n = Math.min(chunk.length - i, bulk.total - bulk.offset);
          this.#count(n);
          // In event mode only the first `retain` bytes are kept; the rest is counted and skipped.
          if (bulk.offset < bulk.data.length) chunk.copy(bulk.data, bulk.offset, i, i + Math.min(n, bulk.data.length - bulk.offset));
          bulk.offset += n; i += n;
        } else {
          this.#count(1);
          if (chunk[i++] !== (bulk.trailer === 0 ? 13 : 10)) malformed();
          if (++bulk.trailer === 2) {
            this.#bulk = undefined;
            const cut = bulk.total > bulk.data.length;
            if (bulk.type === '!') this.#accept(new ErrorReply(bulk.data.toString('utf8')));
            else if (bulk.type === '=') {
              if (bulk.data.length < 4 || bulk.data[3] !== 58) malformed();
              const text = this.#string(bulk.data.subarray(4), RESP_TYPES.VERBATIM_STRING);
              this.#accept(cut ? new RespTruncated(text, bulk.total - 4) : text);
            } else {
              const data = this.#string(bulk.data, RESP_TYPES.BLOB_STRING);
              this.#accept(cut ? new RespTruncated(data, bulk.total) : data);
            }
          }
        }
        continue;
      }
      this.#count(1);
      const ch = chunk[i++]!;
      if (!this.#prefix) {
        this.#prefix = String.fromCharCode(ch);
        if (!'+-:$!*%~=(_#,>|.'.includes(this.#prefix)) malformed();
        continue;
      }
      if (this.#cr) {
        if (ch !== 10) malformed();
        const prefix = this.#prefix;
        const line = this.#line.subarray(0, this.#lineLength);
        this.#prefix = ''; this.#cr = false;
        this.#parse(prefix, line);
        this.#lineLength = 0;
      } else if (ch === 13) this.#cr = true;
      else {
        if (ch === 10) malformed();
        const text = '+-'.includes(this.#prefix);
        if (!text && this.#lineLength >= 512) throw this.#tooLarge('Redis reply header exceeded the structural limit.');
        if (text && this.#lineLength >= Math.min(this.#retain || MAX_LINE, MAX_LINE)) {
          // Event mode: a long MONITOR line (or status) is kept cut; command replies keep the structural ceiling.
          if (!this.#retain) throw this.#tooLarge('Redis reply header exceeded the structural limit.');
          this.#lineSkipped++;
          continue;
        }
        if (this.#lineLength === this.#line.length) {
          const grown = Buffer.alloc(Math.min(MAX_LINE, this.#line.length * 2));
          this.#line.copy(grown); this.#line = grown;
        }
        this.#line[this.#lineLength++] = ch;
      }
    }
    return chunk.length;
  }
  #count(n: number): void {
    this.#bytes += n;
    if (!this.#retain && this.#bytes > this.maxBytes) throw this.#tooLarge();
  }
  #keep(n: number): void {
    this.#retained += n;
    if (this.#retained > this.maxBytes) throw this.#tooLarge();
  }
  end(): void { if (!this.#done) malformed(); }
  #string(data: Buffer, type: number, copy = false): Buffer | string {
    // Always copy line strings: the header scratch buffer is reused.
    return this.#mapping[type as keyof TypeMapping] === Buffer ? (copy ? Buffer.from(data) : data) : data.toString('utf8');
  }
  #parse(type: string, data: Buffer): void {
    const s = data.toString('utf8');
    if (type === '.') {
      if (s || this.#stack.at(-1)?.left !== -1) malformed();
      this.#finish(); return;
    }
    if (++this.#elements > this.#maxElements) throw this.#tooLarge('Redis reply exceeded the element limit.');
    const skipped = this.#lineSkipped;
    this.#lineSkipped = 0;
    if (this.#retain && (type === '+' || type === '-')) this.#keep(data.length);
    switch (type) {
      case '+': {
        const text = this.#string(data, RESP_TYPES.SIMPLE_STRING, true);
        this.#accept(skipped ? new RespTruncated(text, data.length + skipped) : text); return;
      }
      case '-': this.#accept(new ErrorReply(s)); return;
      case '_': if (s) malformed(); this.#accept(null); return;
      case '#': if (s !== 't' && s !== 'f') malformed(); this.#accept(s === 't'); return;
      case ':':
      case '(':
        if (!/^-?\d+$/.test(s)) malformed();
        if (type === ':' && (BigInt(s) < -9223372036854775808n || BigInt(s) > 9223372036854775807n)) malformed();
        this.#accept(this.#mapping[type === ':' ? RESP_TYPES.NUMBER : RESP_TYPES.BIG_NUMBER] === String ? s : type === '(' ? BigInt(s) : Number(s)); return;
      case ',': {
        if (!/^(?:-?inf|nan|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/.test(s)) malformed();
        const n = s === 'inf' ? Infinity : s === '-inf' ? -Infinity : Number(s);
        this.#accept(this.#mapping[RESP_TYPES.DOUBLE] === String ? s : n); return;
      }
      case '$': case '!': case '=': {
        if (!/^(?:-1|\d+)$/.test(s)) malformed();
        const n = Number(s);
        if (n === -1 && type === '$') { this.#accept(null); return; }
        if (n < 0 || !Number.isSafeInteger(n)) malformed();
        const keep = this.#retain ? Math.min(n, this.#retain) : n;
        // Refused at the header: nothing larger than the remaining limit is ever allocated.
        if (keep > this.maxBytes - this.#retained) throw this.#tooLarge();
        this.#retained += keep;
        this.#bulk = { type, data: Buffer.allocUnsafe(keep), offset: 0, trailer: 0, total: n }; return;
      }
      case '*': case '~': case '%': case '|': case '>': {
        if (s === '-1' && type === '*') { this.#accept(null); return; }
        if (s !== '?' && !/^\d+$/.test(s)) malformed();
        let n = s === '?' ? -1 : Number(s);
        if (n !== -1 && !Number.isSafeInteger(n)) malformed();
        if (n >= 0 && (type === '%' || type === '|')) n *= 2;
        if (n > this.#maxElements - this.#elements || this.#stack.length >= this.#maxDepth) throw this.#tooLarge('Redis reply exceeded the element or nesting limit.');
        this.#stack.push({ type, left: n, values: [] });
        if (n === 0) this.#finish(); return;
      }
      default: malformed();
    }
  }
  #finish(): void {
    const frame = this.#stack.pop()!;
    if ((frame.type === '%' || frame.type === '|') && frame.values.length % 2) malformed();
    if (frame.type === '|') return; // attributes decorate the following value; count them but do not expose them
    let v: unknown = frame.values;
    if (frame.type === '>') v = RespPush.from(frame.values); // command sockets never subscribe; unsolicited pushes cannot be reused
    if (frame.type === '~' && this.#mapping[RESP_TYPES.SET] === Set) v = new Set(frame.values);
    if (frame.type === '%' && this.#mapping[RESP_TYPES.MAP] === Map) {
      const pairs: [unknown, unknown][] = [];
      for (let i = 0; i < frame.values.length; i += 2) pairs.push([frame.values[i], frame.values[i + 1]]);
      v = new Map(pairs);
    }
    this.#accept(v);
  }
  #accept(value: unknown): void {
    const frame = this.#stack.at(-1);
    if (!frame) { this.#done = true; this.#value = value; return; }
    frame.values.push(value);
    if (frame.left > 0 && --frame.left === 0) this.#finish();
  }
}
