'use strict';
/**
 * APK a joindre a une release GitHub : release/Tuiles-et-Toiles-x.y.z.apk
 * (x.y.z = version de package.json, reprise par android/app/build.gradle).
 *   1. node scripts/build-mobile.js
 *   2. npx cap sync android
 *   3. gradlew assembleDebug  (signe par la cle de debug de ce poste : c'est
 *      celle des APK deja installes, et Android refuse une mise a jour signee
 *      par une autre cle — voir CLAUDE.md, « Appli mobile »)
 *   4. copie sous le nom attendu par la mise a jour integree (MOTIF_APK)
 *
 *     npm run dist:android
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RACINE = path.resolve(__dirname, '..');
const version = require(path.join(RACINE, 'package.json')).version;
const lancer = (cmd, cwd = RACINE) => execSync(cmd, { cwd, stdio: 'inherit' });

lancer('node scripts/build-mobile.js');
lancer('npx cap sync android');
lancer(process.platform === 'win32' ? 'gradlew.bat assembleDebug' : './gradlew assembleDebug', path.join(RACINE, 'android'));

const apk = path.join(RACINE, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const cible = path.join(RACINE, 'release', 'Tuiles-et-Toiles-' + version + '.apk');
fs.mkdirSync(path.dirname(cible), { recursive: true });
fs.copyFileSync(apk, cible);
console.log('\n' + path.relative(RACINE, cible) + ' (' + Math.round(fs.statSync(cible).size / 1048576) + ' Mo)');
