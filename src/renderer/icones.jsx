// Icones dessinees en SVG : elles se redimensionnent et suivent la couleur
// du texte, contrairement a des emoji ou a des images.

const base = (t) => ({
  width: t, height: t, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.6,
  strokeLinecap: 'round', strokeLinejoin: 'round'
});

export const Manette = ({ t = 19 }) => (
  <svg {...base(t)}>
    <rect x="3" y="14.5" width="18" height="6.5" rx="1.6" />
    <path d="M12 14.5V8" />
    <circle cx="12" cy="5.4" r="2.6" />
  </svg>
);

export const Bibliotheque = ({ t = 19 }) => (
  <svg {...base(t)}>
    <rect x="3" y="4" width="4.2" height="16" rx="1" />
    <rect x="9" y="4" width="4.2" height="16" rx="1" />
    <path d="M15.4 5.1l4 1.1-3.5 14.1-4-1.1z" />
  </svg>
);

export const Livre = ({ t = 19 }) => (
  <svg {...base(t)}>
    <path d="M4 5h5.5A2.5 2.5 0 0 1 12 7.5V19a2.2 2.2 0 0 0-2.2-1.8H4z" />
    <path d="M20 5h-5.5A2.5 2.5 0 0 0 12 7.5V19a2.2 2.2 0 0 1 2.2-1.8H20z" />
  </svg>
);

export const Etoile = ({ t = 19 }) => (
  <svg {...base(t)}>
    <path d="M12 3.6l2.6 5.3 5.9.85-4.25 4.15 1 5.85L12 17l-5.25 2.75 1-5.85L3.5 9.75l5.9-.85z" />
  </svg>
);

export const Revoir = ({ t = 19 }) => (
  <svg {...base(t)}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M8.4 15.6c1-1.4 2.15-2.1 3.6-2.1s2.6.7 3.6 2.1" />
    <circle cx="9.2" cy="9.9" r="0.95" fill="currentColor" stroke="none" />
    <circle cx="14.8" cy="9.9" r="0.95" fill="currentColor" stroke="none" />
  </svg>
);

export const Rouage = ({ t = 19 }) => (
  <svg {...base(t)}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M18.9 14.6a1.5 1.5 0 0 0 .3 1.65l.05.05a1.85 1.85 0 1 1-2.6 2.6l-.05-.05a1.5 1.5 0 0 0-1.65-.3 1.5 1.5 0 0 0-.9 1.37V20a1.85 1.85 0 1 1-3.7 0v-.07a1.5 1.5 0 0 0-.98-1.37 1.5 1.5 0 0 0-1.65.3l-.05.05a1.85 1.85 0 1 1-2.6-2.6l.05-.05a1.5 1.5 0 0 0 .3-1.65 1.5 1.5 0 0 0-1.37-.9H4a1.85 1.85 0 1 1 0-3.7h.07a1.5 1.5 0 0 0 1.37-.98 1.5 1.5 0 0 0-.3-1.65l-.05-.05a1.85 1.85 0 1 1 2.6-2.6l.05.05a1.5 1.5 0 0 0 1.65.3h.07a1.5 1.5 0 0 0 .9-1.37V4a1.85 1.85 0 1 1 3.7 0v.07a1.5 1.5 0 0 0 .9 1.37 1.5 1.5 0 0 0 1.65-.3l.05-.05a1.85 1.85 0 1 1 2.6 2.6l-.05.05a1.5 1.5 0 0 0-.3 1.65v.07a1.5 1.5 0 0 0 1.37.9H20a1.85 1.85 0 1 1 0 3.7h-.07a1.5 1.5 0 0 0-1.37.9z" />
  </svg>
);

export const Croix = ({ t = 19 }) => (
  <svg {...base(t)} strokeWidth="1.8"><path d="M18 6L6 18M6 6l12 12" /></svg>
);

export const Hamburger = ({ t = 19 }) => (
  <svg {...base(t)} strokeWidth="1.7"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
);

export const Etiquette = ({ t = 19 }) => (
  <svg {...base(t)}>
    <path d="M4 4h7l9 9-7 7-9-9V4z" />
    <circle cx="8.5" cy="8.5" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

export const Maison = ({ t = 19 }) => (
  <svg {...base(t)}>
    <path d="M4 11.5 12 4l8 7.5" />
    <path d="M5.5 10.5V20h13v-9.5" />
    <path d="M10 20v-5h4v5" />
  </svg>
);

export const OeilBarre = ({ t = 15 }) => (
  <svg {...base(t)}>
    <path d="M3 3l18 18" />
    <path d="M10.6 10.7a2 2 0 0 0 2.8 2.8" />
    <path d="M9.6 5.3A9.4 9.4 0 0 1 12 5c5 0 9 4.5 9 7 0 .9-.55 2.05-1.55 3.25" />
    <path d="M6.3 6.9C4.05 8.4 3 10.35 3 12c0 2.5 4 7 9 7 1.45 0 2.75-.3 3.9-.85" />
  </svg>
);

export const Coche = ({ t = 18 }) => (
  <svg {...base(t)} strokeWidth="2.1"><path d="M4.5 12.5l5 5L20 6.5" /></svg>
);

export const Fleche = ({ t = 18, retour = false }) => (
  <svg {...base(t)} strokeWidth="1.9" style={retour ? { transform: 'scaleX(-1)' } : undefined}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export const Grille = ({ t = 19 }) => (
  <svg {...base(t)}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);

export const Crayon = ({ t = 19 }) => (
  <svg {...base(t)}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

export const FlecheVert = ({ t = 18, bas = false }) => (
  <svg {...base(t)} strokeWidth="1.9" style={bas ? { transform: 'scaleY(-1)' } : undefined}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);

export const Echange = ({ t = 18 }) => (
  <svg {...base(t)} strokeWidth="1.7">
    <path d="M7 4L4 7l3 3" />
    <path d="M4 7h13" />
    <path d="M17 20l3-3-3-3" />
    <path d="M20 17H7" />
  </svg>
);

export const Corbeille = ({ t = 19 }) => (
  <svg {...base(t)}>
    <path d="M4 7h16" />
    <path d="M9 7V4.5h6V7" />
    <path d="M6 7l1 13h10l1-13" />
    <path d="M10 11v5.5M14 11v5.5" />
  </svg>
);

export const Nuage = ({ t = 19 }) => (
  <svg {...base(t)}>
    <path d="M7 18h9.5a3.5 3.5 0 0 0 .4-6.98 5 5 0 0 0-9.6-1.3A3.85 3.85 0 0 0 7 18Z" />
  </svg>
);

export const Rafraichir = ({ t = 19 }) => (
  <svg {...base(t)} strokeWidth="1.8">
    <path d="M4 4v6h6" />
    <path d="M4.5 15a8 8 0 1 0 2-9.5L4 10" />
  </svg>
);
