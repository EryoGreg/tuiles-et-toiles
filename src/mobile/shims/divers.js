'use strict';
// Remplacants de `zlib` et `os` pour le mobile.
const { gzipSync: gz, gunzipSync: gunz } = require('fflate');
const { Buffer } = require('buffer');

const zlib = {
  gzipSync: (b) => Buffer.from(gz(new Uint8Array(b))),
  gunzipSync: (b) => Buffer.from(gunz(new Uint8Array(b)))
};

let nomAppareil = 'Téléphone';
const os = {
  hostname: () => nomAppareil,
  tmpdir: () => '/tmp',
  userInfo: () => ({ username: 'mobile' }),
  platform: () => 'mobile',
  totalmem: () => 0,
  freemem: () => 0,
  cpus: () => [],
  release: () => '',
  arch: () => '',
  definirNom: (n) => { if (n) nomAppareil = String(n); }
};

module.exports = { zlib, os };
