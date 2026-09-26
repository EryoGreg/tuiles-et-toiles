'use strict';
/**
 * La suite de synchro E2b, mais sur le SQLite du MOBILE : sql.js (WebAssembly)
 * derriere src/mobile/shims/sqlite.js, a la place de better-sqlite3. Verifie
 * que le remplacant se comporte comme l'original (transactions imbriquees,
 * parametres nommes, ATTACH, types) sur des milliers d'operations.
 *
 *     node scripts/lancer-node.js tests/mobile-sqlite.test.js
 */

const path = require('path');
const Module = require('module');
const initSqlJs = require('sql.js');

const RACINE = path.resolve(__dirname, '..');
const SHIM = path.join(RACINE, 'src', 'mobile', 'shims', 'sqlite.js');

(async () => {
  const SQL = await initSqlJs();
  require(SHIM).initialiser(SQL);
  // Toute demande de better-sqlite3 recoit le remplacant mobile.
  const resoudre = Module._resolveFilename;
  Module._resolveFilename = function (req, ...r) {
    if (req === 'better-sqlite3') return SHIM;
    return resoudre.call(this, req, ...r);
  };
  console.log('(SQLite du mobile : sql.js)');
  require(process.env.TT_SUITE || './synchro-e2b.test.js');
})();
