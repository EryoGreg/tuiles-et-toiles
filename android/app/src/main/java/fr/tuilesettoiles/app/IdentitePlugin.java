package fr.tuilesettoiles.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Identite de l'appareil pour la synchro (src/mobile/principal.js,
 * src/main/synchro/appareil.js) :
 *   infos()          ANDROID_ID (propre a l'appareil, a l'utilisateur Android et a
 *                    la cle de signature : stable a la reinstallation sur le MEME
 *                    telephone, different sur un autre), fabricant, modele
 *   lireCopie()      copie de secours de appareil.json (preferences Android)
 *   sauverCopie()    -> si le stockage de la page (IndexedDB) est perdu sans que
 *                    l'appli soit effacee, l'identite est retrouvee.
 * L'ANDROID_ID n'est jamais publie en clair : seule une empreinte l'est.
 */
@CapacitorPlugin(name = "Identite")
public class IdentitePlugin extends Plugin {

    private static final String PREFS = "identite";
    private static final String CLE = "appareil_json";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void infos(PluginCall call) {
        JSObject r = new JSObject();
        String id = Settings.Secure.getString(getContext().getContentResolver(), Settings.Secure.ANDROID_ID);
        r.put("androidId", id == null ? "" : id);
        r.put("fabricant", Build.MANUFACTURER);
        r.put("modele", Build.MODEL);
        r.put("version", Build.VERSION.RELEASE);
        call.resolve(r);
    }

    @PluginMethod
    public void lireCopie(PluginCall call) {
        JSObject r = new JSObject();
        r.put("json", prefs().getString(CLE, ""));
        call.resolve(r);
    }

    @PluginMethod
    public void sauverCopie(PluginCall call) {
        String json = call.getString("json", "");
        prefs().edit().putString(CLE, json).apply();
        call.resolve();
    }
}
