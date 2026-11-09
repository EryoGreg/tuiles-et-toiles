// Filet de securite autour de chaque page : une erreur de rendu dans une page
// n'emporte plus toute l'interface (ecran gris, barre et fermeture perdues).
// La page affiche un message, l'erreur part au journal ; la barre laterale,
// la fermeture et les autres pages restent utilisables.
import { Component } from 'react';

export class GardePage extends Component {
  constructor(props) {
    super(props);
    this.state = { erreur: null };
  }

  static getDerivedStateFromError(erreur) { return { erreur }; }

  componentDidCatch(erreur, info) {
    try {
      window.api.evt('ui', 'page-plantee', {
        page: this.props.page,
        message: String((erreur && erreur.message) || erreur),
        pile: String((erreur && erreur.stack) || '').split('\n').slice(0, 8).join(' | '),
        composants: String((info && info.componentStack) || '').split('\n').slice(0, 8).join(' | ')
      }, 'ERREUR');
    } catch { /* journal indisponible */ }
  }

  render() {
    if (!this.state.erreur) return this.props.children;
    const { onReinitialiser, onAccueil } = this.props;
    return (
      <div className="garde-page" role="alert">
        <h2>Cette page a rencontré un problème</h2>
        <p>
          Rien n’est perdu : tes tuiles et tes réglages sont intacts. Le problème a été noté dans le journal ;
          « Signaler un problème » (Options) l’enverra avec le rapport.
        </p>
        <div className="garde-page-actions">
          {onReinitialiser && (
            <button className="bouton-neutre" onClick={() => { onReinitialiser(); this.setState({ erreur: null }); }}>
              Réessayer sans les filtres de la page
            </button>
          )}
          <button className="bouton-neutre" onClick={() => this.setState({ erreur: null })}>Réessayer</button>
          {onAccueil && <button className="bouton-neutre" onClick={onAccueil}>Revenir à l’accueil</button>}
        </div>
        <pre className="garde-page-detail">{String((this.state.erreur && this.state.erreur.message) || this.state.erreur)}</pre>
      </div>
    );
  }
}
