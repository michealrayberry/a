import { customAlphabet } from 'nanoid';

const alpha = '0123456789abcdefghijklmnopqrstuvwxyz';
const gen = customAlphabet(alpha, 24);

/** Globally unique, URL-safe, non-guessable id with an entity prefix. */
export function newId(prefix: string): string {
  return `${prefix}_${gen()}`;
}

/** Short human-readable form for receipts / evidence IDs (blueprint §7.7). */
export function shortCode(id: string): string {
  const tail = id.split('_').pop() ?? id;
  return tail.slice(0, 8).toUpperCase();
}
