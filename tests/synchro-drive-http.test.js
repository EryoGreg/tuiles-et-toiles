'use strict';
// Suite de synchro E2b rejouee a travers le vrai code HTTP de Drive
// (src/main/drive-api.js, commun au PC et au mobile) face au faux Drive.
//     node scripts/lancer-node.js tests/synchro-drive-http.test.js
process.env.TT_TRANSPORT = 'drive-http';
require('./synchro-e2b.test.js');
