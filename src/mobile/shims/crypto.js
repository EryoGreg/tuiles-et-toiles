'use strict';
// Remplacant de `crypto` (sous-ensemble utilise) : empreintes synchrones en JS
// pur (@noble/hashes), alea de Web Crypto.
const { sha256 } = require('@noble/hashes/sha2.js');
const { sha1 } = require('@noble/hashes/legacy.js');
const { Buffer } = require('buffer');

const ALGOS = { sha256, sha1 };

function createHash(nom) {
  const algo = ALGOS[String(nom).toLowerCase()];
  if (!algo) throw new Error('crypto mobile : empreinte non geree ' + nom);
  const h = algo.create();
  const o = {
    update(data, enc) {
      h.update(typeof data === 'string' ? new Uint8Array(Buffer.from(data, enc || 'utf8')) : new Uint8Array(data));
      return o;
    },
    digest(enc) {
      const b = Buffer.from(h.digest());
      return enc ? b.toString(enc) : b;
    }
  };
  return o;
}

function randomBytes(n) {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return Buffer.from(a);
}

function randomUUID() {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

module.exports = { createHash, randomBytes, randomUUID };
