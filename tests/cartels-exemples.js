'use strict';
/**
 * Cartels reels (photos de l'utilisateur, 26/09/2026) retranscrits comme ML
 * Kit les rend : une ligne par ligne imprimee, [texte, hauteur en px, bloc].
 * Hauteurs et blocs estimes sur les photos. Attendu = ce qu'un humain
 * mettrait dans la tuile ('' = rien a proposer).
 * Les photos elles-memes ne sont pas dans le depot (depot public).
 */

module.exports = [
  {
    nom: 'Cezanne, Montagne Sainte-Victoire (artiste, lieux de vie, audio, donation)',
    lignes: [
      ['Paul Cézanne', 62, 0],
      ['Aix-en-Provence 1839 – Aix-en-Provence 1906', 30, 0],
      ['Montagne Sainte-Victoire', 60, 1],
      ['Vers 1890', 32, 1],
      ['Huile sur toile', 32, 1],
      ['Dès les années 1880, Cézanne s’éloigne de Paris', 30, 2],
      ['et des impressionnistes. Quelques paysages', 30, 2],
      ['immuables de sa Provence natale lui servent alors', 30, 2],
      ['à élaborer intuitivement une approche picturale', 30, 2],
      ['originale, très exigeante, dont le but est de faire', 30, 2],
      ['du tableau une « harmonie parallèle à la nature ».', 30, 2],
      ['L’artiste, à partir de ses sensations, reconstruit le motif', 30, 2],
      ['observé grâce à un système rigoureux de touches', 30, 2],
      ['parallèles, qui unifie la surface du tableau. Cézanne', 30, 2],
      ['réinvente ainsi la montagne Sainte-Victoire, proche', 30, 2],
      ['d’Aix-en-Provence, près d’une soixantaine de fois.', 30, 2],
      ['10', 60, 3],
      ['DONATION SOUS RÉSERVE D’USUFRUIT', 20, 4],
      ['PAR LA PETITE-FILLE D’AUGUSTE PELLERIN, 1969', 20, 4],
      ['RF 1969 30', 20, 4]
    ],
    attendu: {
      artiste: 'Paul Cézanne', titre: 'Montagne Sainte-Victoire', date: 'Vers 1890', tags: 'Huile sur toile',
      description: /^Dès les années 1880.*soixantaine de fois\.$/s
    }
  },
  {
    nom: 'Limosin, Portrait presume de Jeanne d’Albret (attribution, titre sur 2 lignes, siecle)',
    lignes: [
      ['1.', 34, 0],
      ['Attribué à l’atelier de Léonard Limosin', 44, 0],
      ['Plaque Portrait présumé', 44, 0],
      ['de Jeanne d’Albret (1528-1572)', 44, 0],
      ['Émaux peints polychromes sur cuivre,', 46, 1],
      ['rehauts d’or, monture en argent', 46, 1],
      ['Limoges, milieu du XVIe siècle', 46, 1],
      ['Legs Dutuit, 1902 - Inv. ODUT01253', 32, 2],
      ['2.', 30, 3]
    ],
    attendu: {
      artiste: 'Attribué à l’atelier de Léonard Limosin',
      titre: 'Plaque Portrait présumé de Jeanne d’Albret (1528-1572)',
      date: 'milieu du XVIe siècle',
      tags: 'Émaux peints polychromes sur cuivre, rehauts d’or, monture en argent',
      description: ''
    }
  },
  {
    nom: 'Cartes a jouer (titre FR + EN, editeurs en paragraphe)',
    lignes: [
      ['Cartes à jouer du Jeu des héros des mémorables', 50, 0],
      ['Journées de juillet 1830', 50, 0],
      ['Playing cards for the Jeu des héros des mémorables', 48, 1],
      ['Journées de juillet 1830', 48, 1],
      ['E.F.V. Maniez, 2, rue Greneta, passage Saint-Denis à Paris, inventeur du jeu', 34, 2],
      ['et éditeur / Imprimeries Hippolyte Tilliard, 88, rue de La Harpe à Paris (active', 34, 2],
      ['entre 1823 et 1842), et Claude Fosset, 19, rue du Faubourg-Saint-Jacques', 34, 2],
      ['(active entre 1826 et 1860)', 34, 2],
      ['1831', 34, 2],
      ['Cartons dorés sur tranche, impression en taille-douce et rehauts d’aquarelle,', 34, 2],
      ['dos vernis', 34, 2],
      ['Ancien fonds — OM518', 34, 2]
    ],
    attendu: {
      titre: 'Cartes à jouer du Jeu des héros des mémorables Journées de juillet 1830',
      date: '1831',
      tags: /^Cartons dorés sur tranche/
    }
  },
  {
    nom: 'Raynaud, L’Indien Chactas (artiste + dates accolees, bilingue)',
    lignes: [
      ['Auguste Raynaud (1854-1937)', 44, 0],
      ['L’Indien Chactas sur la tombe d’Atala', 42, 0],
      ['1878', 40, 0],
      ['Huile sur toile', 40, 0],
      ['Cette peinture représente l’Indien Chactas sur la tombe d’Atala. Cette', 32, 1],
      ['scène est tirée du roman de Chateaubriand.', 32, 1],
      ['Auguste Raynaud (1854-1937)', 44, 2],
      ['The Indian Chactas at the Grave of Atala', 42, 2],
      ['1878', 40, 2],
      ['Oil on canvas', 40, 2],
      ['This painting shows the Indian Chactas at the grave of Atala. The scene', 32, 3],
      ['is taken from the novel by Chateaubriand.', 32, 3]
    ],
    attendu: {
      artiste: 'Auguste Raynaud', titre: 'L’Indien Chactas sur la tombe d’Atala', date: '1878',
      tags: 'Huile sur toile',
      description: 'Cette peinture représente l’Indien Chactas sur la tombe d’Atala. Cette scène est tirée du roman de Chateaubriand.'
    }
  },
  {
    nom: 'Cabinet de curiosites (panneau de salle : titre + texte)',
    lignes: [
      ['Cabinet', 110, 0],
      ['de curiosités', 110, 0],
      ['C’était un lieu où des objets hétéroclites, étaient', 36, 1],
      ['collectionnés pour leur aspect rare ou singulier :', 36, 1],
      ['antiquités, œuvres d’art, instruments scientifiques,', 36, 1],
      ['animaux empaillés, coquillages, squelettes, herbiers,', 36, 1],
      ['fossiles, pierres précieuses ou médailles.', 36, 1],
      ['Connus depuis la Renaissance en occident, ils sont les', 32, 2],
      ['ancêtres des musées. Les collections y sont organisées', 32, 2],
      ['en quatre catégories nommées en latin:', 32, 2],
      ['• Les naturalia, rassemblant les objets d’histoire', 32, 3],
      ['naturelle des trois règnes (animal, végétal et minéral):', 32, 3],
      ['animaux naturalisés, insectes séchés, squelettes,', 32, 3],
      ['• Les exotica, regroupant les plantes et animaux', 32, 4],
      ['exotiques ainsi que les objets ethnographiques,', 32, 4]
    ],
    attendu: {
      titre: 'Cabinet de curiosités', artiste: '', date: '',
      description: /^C’était un lieu.*médailles\.\nConnus depuis.*latin:\n• Les naturalia.*\n• Les exotica/s
    }
  },
  {
    nom: 'Mosaique (sans artiste, lieu de decouverte, siecles, inventaire)',
    lignes: [
      ['Mosaïque d’une maison d’habitation urbaine', 30, 0],
      ['Bordeaux, rue Père-Louis-de-Jabrun en 1876', 26, 1],
      ['Fin IVe – début Ve siècle apr. J.-C', 26, 1],
      ['Terre cuite, calcaires, marbres', 26, 1],
      ['Inv. X.242', 16, 1],
      ['Ce pavement ornait la galerie d’une habitation urbaine (domus) en bord de rue. Lors de sa', 26, 2],
      ['découverte en 1876, il en a été dégagé plus de dix mètres, mais il se prolongeait au sud sous les', 26, 2],
      ['antique de Djebel Oust, en Tunisie).', 26, 2],
      ['03', 40, 3]
    ],
    attendu: {
      titre: 'Mosaïque d’une maison d’habitation urbaine', artiste: '',
      date: 'Fin IVe – début Ve siècle apr. J.-C', tags: 'Terre cuite, calcaires, marbres',
      description: /^Ce pavement.*Tunisie\)\.$/s
    }
  },
  {
    nom: 'Frans Hals, L’Homme a la main sur le coeur (titre EN, date et technique a part)',
    lignes: [
      ['Frans Hals', 50, 0],
      ['Anvers, 1582-1583 – Haarlem, 1666', 26, 0],
      ['L’Homme à la main sur le cœur', 42, 1],
      ['Man with a Hand to his Heart', 30, 1],
      ['1632', 22, 2],
      ['Huile sur toile', 22, 3],
      ['Ce portrait d’un homme âgé de 26 ans révèle les qualités', 28, 4],
      ['de l’art de Frans Hals. Il incarne à lui seul, l’évolution', 28, 4],
      ['picturale d’un des plus grands maîtres de son temps,', 28, 4],
      ['reconnu pour ses portraits extrêmement vivants.', 28, 4],
      ['par l’acuité de l’expression, nous dévoile un homme, vif,', 28, 4],
      ['intelligent, généreux et intègre.', 28, 4],
      ['Ancienne collection Lacaze.', 16, 5],
      ['Achat de la Ville, 1829', 16, 5],
      ['Inv. Bx E 310', 16, 5],
      ['Œuvre restaurée en 2019 grâce au mécénat du Château Haut-Bailly,', 14, 6],
      ['mécène d’honneur.', 14, 6]
    ],
    attendu: {
      artiste: 'Frans Hals', titre: 'L’Homme à la main sur le cœur', date: '1632', tags: 'Huile sur toile',
      description: /^Ce portrait.*intègre\.$/s
    }
  },
  {
    nom: 'Corot, Le Bain de Diane (meme musee que Hals)',
    lignes: [
      ['Camille Corot', 50, 0],
      ['Paris, 1796 – Ville d’Avray, 1875', 26, 0],
      ['Le Bain de Diane', 42, 1],
      ['Diana at the Bath', 32, 1],
      ['1855', 24, 2],
      ['Huile sur toile', 24, 3],
      ['Élève du peintre paysagiste néoclassique Jean-Victor', 30, 4],
      ['Bertin, Camille Corot apprend à travailler en plein air', 30, 4],
      ['Delacroix, exposée dans la première salle de l’aile', 30, 4],
      ['Bonheur.', 30, 4],
      ['Achat de la Ville au Salon de la Société des Amis des Arts de Bordeaux,', 18, 5],
      ['1858.', 18, 5],
      ['Inv. Bx E 489', 18, 5]
    ],
    attendu: {
      artiste: 'Camille Corot', titre: 'Le Bain de Diane', date: '1855', tags: 'Huile sur toile',
      description: /^Élève du peintre.*Jean-Victor Bertin, Camille.*aile Bonheur\.$/s
    }
  },
  {
    // Sortie REELLE de ML Kit (emulateur, 26/09/2026) sur un cartel fabrique facon
    // Corot : un bloc par ligne en tete, accents des capitales perdus (« Elève »).
    nom: 'Corot, sortie ML Kit reelle (blocs d’une ligne, accents perdus)',
    lignes: [
      ['Camille Corot', 56, 0],
      ["Paris, 1796 –Ville d'Avray, 1875", 31, 1],
      ['Le Bain de Diane', 51, 2],
      ['Diana at the Bath', 30, 3],
      ['1855', 25, 4],
      ['Huile sur toile', 27, 5],
      ['Elève du peintre paysagiste néoclassique Jean-Victor', 37, 6],
      ['Bertin, Camille Corot apprend à travailler en plein air', 37, 6],
      ['avant de composer en atelier des paysages idéalisés qui', 34, 6],
      ['servent de décor à des récits historiques, mythologiques', 38, 6],
      ["ou bibliques. A partir de 1850, il s'attache à travailler sur", 36, 6],
      ['les effets de lumière dans la forêt de Fontainebleau.', 29, 6],
      ['Achat de la Ville au Salon de la Société des Amis des Arts de BordeauX,', 20, 7],
      ['1858.', 18, 7],
      ['Inv. Bx E 489', 20, 8]
    ],
    attendu: {
      artiste: 'Camille Corot', titre: 'Le Bain de Diane', date: '1855', tags: 'Huile sur toile',
      description: /^Elève du peintre.*Fontainebleau\.$/s
    }
  },
  {
    nom: 'Buire (maison en capitales, lieu + date, bout du cartel voisin)',
    lignes: [
      ['don LUCIE ET ALICE VANLIAN, 2023, inv. 2023.13.3', 40, 0],
      ['3', 60, 1],
      ['Buire', 80, 2],
      ['MAISON FERDINAND BARBEDIENNE', 50, 3],
      ['Paris, vers 1863', 50, 3],
      ['bronze émaillé en cloisonné', 56, 4],
      ['don BARBEDIENNE, 1863, inv. UC 718', 40, 5]
    ],
    attendu: {
      titre: 'Buire', artiste: 'MAISON FERDINAND BARBEDIENNE', date: 'vers 1863',
      tags: 'bronze émaillé en cloisonné', description: ''
    }
  }
];
