'use strict';
/**
 * Annuler / retablir (Ctrl+Z / Ctrl+Y) les actions de l'utilisateur.
 *
 * Une action (creer, modifier, supprimer, restaurer une tuile, marquer,
 * trancher un conflit…) = les ecritures qu'elle a faites dans le registre de
 * synchro, capturees au passage (etat.capturer) : pour chaque champ, sa valeur
 * avant et apres. Annuler = reecrire les valeurs d'avant, retablir = celles
 * d'apres, par des ecritures ORDINAIRES : elles vont au journal et partent a
 * la synchro comme n'importe quelle modification (annuler sur le PC annule
 * aussi sur le telephone).
 *
 * Un champ modifie depuis par autre chose (synchro, autre action) n'est pas
 * touche : annuler ne doit jamais ecraser un changement plus recent. Piles en
 * memoire, pour la session (50 actions).
 */

const etat = require('./synchro/etat');
const journal = require('./journal');

const MAX = 50;
let pileAnnuler = [];
let pileRetablir = [];
let enCours = false;   // pendant annuler/retablir : pas de nouvelle action

/**
 * Execute fn en capturant ses ecritures ; si elle a change quelque chose,
 * l'action rejoint la pile (et vide celle des actions a retablir).
 * @param {string|((resultat) => string)} libelle  « Modification de #L3 »…
 */
function action(libelle, fn) {
  if (enCours) return fn();
  const { resultat, ecritures } = etat.capturer(fn);
  if (ecritures.length) {
    const nom = typeof libelle === 'function' ? libelle(resultat) : libelle;
    pileAnnuler.push({ libelle: nom, ecritures, le: new Date().toISOString() });
    if (pileAnnuler.length > MAX) pileAnnuler.shift();
    pileRetablir = [];
  }
  return resultat;
}

/**
 * Ecrit, champ par champ, la valeur `vers` (avant ou apres) la ou le champ vaut
 * encore `depuis`. @returns {{ faites, ignorees }}
 */
function rejouer(a, depuis, vers) {
  let faites = 0; const ignorees = [];
  enCours = true;
  try {
    etat.lot(() => {
      // Ordre inverse pour annuler (une restauration de tuile avant ses champs…).
      const liste = vers === 'avant' ? [...a.ecritures].reverse() : a.ecritures;
      for (const e of liste) {
        const cour = etat.brut(e.entite, e.cle, e.champ);
        if (cour !== e[depuis]) { ignorees.push(e.entite + ':' + e.cle + ':' + e.champ); continue; }
        etat.ecrire(e.entite, e.cle, e.champ, e[vers] == null ? null : JSON.parse(e[vers]));
        faites++;
      }
    });
  } finally { enCours = false; }
  return { faites, ignorees };
}

function annuler() {
  const a = pileAnnuler.pop();
  if (!a) return { rien: true };
  const r = rejouer(a, 'apres', 'avant');
  pileRetablir.push(a);
  journal.evt('edition', 'annuler', { libelle: a.libelle, ...r });
  return { libelle: a.libelle, ...r, etat: etatPiles() };
}

function retablir() {
  const a = pileRetablir.pop();
  if (!a) return { rien: true };
  const r = rejouer(a, 'avant', 'apres');
  pileAnnuler.push(a);
  journal.evt('edition', 'retablir', { libelle: a.libelle, ...r });
  return { libelle: a.libelle, ...r, etat: etatPiles() };
}

function etatPiles() {
  const dernier = (p) => (p.length ? p[p.length - 1].libelle : null);
  return { annuler: dernier(pileAnnuler), retablir: dernier(pileRetablir) };
}

/**
 * Images citees par les piles : le menage des images ne doit pas effacer
 * celle qu'une annulation remettrait.
 */
function images() {
  const out = new Set();
  for (const a of [...pileAnnuler, ...pileRetablir]) {
    for (const e of a.ecritures) {
      if (e.champ !== 'image') continue;
      for (const v of [e.avant, e.apres]) {
        if (v == null) continue;
        const x = JSON.parse(v);
        const nom = x && typeof x === 'object' ? x.valeur : x;
        if (nom) out.add(nom);
      }
    }
  }
  return out;
}

function vider() { pileAnnuler = []; pileRetablir = []; }

module.exports = { action, annuler, retablir, etatPiles, images, vider };
