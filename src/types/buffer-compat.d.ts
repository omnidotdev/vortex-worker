// TypeScript 6 changed Array iterator methods to return ArrayIterator instead
// of IterableIterator. @types/node's Buffer typings still use IterableIterator,
// making Buffer incompatible with Uint8Array<ArrayBufferLike>. This augments
// Buffer to return the expected types until @types/node catches up.
declare global {
  interface Buffer {
    entries(): ArrayIterator<[number, number]>;
    keys(): ArrayIterator<number>;
    values(): ArrayIterator<number>;
    [Symbol.iterator](): ArrayIterator<number>;
  }
}
export {};
