package fr.tuilesettoiles.app;

import android.content.Intent;
import android.os.Bundle;
import android.util.Log;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginHandle;

import ee.forgr.capacitor.social.login.GoogleProvider;
import ee.forgr.capacitor.social.login.ModifiedMainActivityForSocialLoginPlugin;
import ee.forgr.capacitor.social.login.SocialLoginPlugin;

/**
 * Connexion Google avec autorisation Drive (drive.file) : l'ecran
 * d'autorisation de Google revient ici (onActivityResult), et on le relaie au
 * module de connexion. Sans l'interface marqueur, le module refuse toute
 * autorisation supplementaire.
 */
public class MainActivity extends BridgeActivity implements ModifiedMainActivityForSocialLoginPlugin {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Module local (pas un paquet npm) : a declarer avant super.onCreate.
        registerPlugin(MiseAJourPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode < GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MIN
                || requestCode >= GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MAX) {
            return;
        }
        PluginHandle poignee = getBridge().getPlugin("SocialLogin");
        if (poignee == null) {
            Log.w("TuilesEtToiles", "module SocialLogin introuvable");
            return;
        }
        Plugin module = poignee.getInstance();
        if (module instanceof SocialLoginPlugin) {
            ((SocialLoginPlugin) module).handleGoogleLoginIntent(requestCode, data);
        }
    }

    @Override
    public void IHaveModifiedTheMainActivityForTheUseWithSocialLoginPlugin() {}
}
