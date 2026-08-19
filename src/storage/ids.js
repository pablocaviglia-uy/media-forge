/**
 * Stable identifiers for records that may outlive the current page.
 *
 * Counters are fine for transient DOM nodes, but restart at one after every
 * reload and can collide with projects restored from browser storage. Modern
 * browsers provide UUIDs directly; `getRandomValues` covers older browsers,
 * and the final legacy path combines per-page entropy, time and a monotonic
 * sequence rather than falling back to a restartable counter.
 */

let legacySequence = 0;

const randomWord = () => Math.floor(Math.random() * 0x1_0000_0000)
  .toString(36)
  .padStart(7, '0');

const legacyPageEntropy = [
  Date.now().toString(36),
  randomWord(),
  randomWord(),
].join('-');

function uuidFromRandomValues(cryptoObject) {
  const bytes = new Uint8Array(16);
  cryptoObject.getRandomValues(bytes);
  // RFC 4122 version 4 and variant bits make this fallback interchangeable
  // with `crypto.randomUUID()` while retaining 122 random bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10).join(''),
  ].join('-');
}

function legacyId() {
  legacySequence += 1;
  return [
    'legacy',
    legacyPageEntropy,
    Date.now().toString(36),
    legacySequence.toString(36),
    randomWord(),
    randomWord(),
  ].join('-');
}

/**
 * Create a prefixed identifier suitable for IndexedDB keys and DOM datasets.
 * The optional crypto object keeps the compatibility paths directly testable.
 */
export function createPersistentId(prefix, cryptoObject = globalThis.crypto) {
  const readablePrefix = String(prefix || '').trim();
  if (!/^[a-z][a-z0-9-]*$/i.test(readablePrefix)) {
    throw new TypeError('A persistent id needs a readable prefix.');
  }

  let id = null;
  if (typeof cryptoObject?.randomUUID === 'function') {
    try {
      id = cryptoObject.randomUUID();
    } catch {
      // Some embedded browsers expose the method outside a secure context but
      // throw when it is called. Their older random-byte API may still work.
    }
  }
  if (!id && typeof cryptoObject?.getRandomValues === 'function') {
    try {
      id = uuidFromRandomValues(cryptoObject);
    } catch {
      // Browser storage remains usable in restricted/private environments.
    }
  }

  return `${readablePrefix}-${id || legacyId()}`;
}
