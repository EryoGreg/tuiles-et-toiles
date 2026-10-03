package fr.tuilesettoiles.app;

import android.accounts.Account;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.Scope;

import java.util.Collections;

/**
 * Jeton d'acces Drive sans interface (src/mobile/drive.js).
 *
 * Le module de connexion (@capgo/capacitor-social-login) ne sait rendre un
 * jeton que si son jeton d'IDENTITE est encore valide : celui-ci expire 1 h
 * apres la connexion, et passe ce delai le module repond « User is not logged
 * in » -> la synchro auto se croyait deconnectee une heure apres chaque
 * connexion. Ici on demande directement l'autorisation Drive aux services
 * Google : tant que l'acces reste accorde a l'appli, Android rend un jeton neuf
 * sans rien afficher. S'il faudrait un ecran (acces retire, compte supprime) :
 * rejet code INTERACTION, jamais d'ecran depuis ce module.
 */
@CapacitorPlugin(name = "JetonDrive")
public class JetonDrivePlugin extends Plugin {

    private static final String SCOPE_DRIVE = "https://www.googleapis.com/auth/drive.file";

    @PluginMethod
    public void jeton(PluginCall call) {
        String email = call.getString("email", "");
        AuthorizationRequest.Builder b = AuthorizationRequest.builder()
            .setRequestedScopes(Collections.singletonList(new Scope(SCOPE_DRIVE)));
        if (email != null && !email.isEmpty()) b.setAccount(new Account(email, "com.google"));
        try {
            Identity.getAuthorizationClient(getContext())
                .authorize(b.build())
                .addOnSuccessListener((res) -> {
                    if (res.hasResolution()) {
                        call.reject("interaction requise", "INTERACTION");
                        return;
                    }
                    String t = res.getAccessToken();
                    if (t == null || t.isEmpty()) {
                        call.reject("jeton vide", "VIDE");
                        return;
                    }
                    JSObject r = new JSObject();
                    r.put("accessToken", t);
                    call.resolve(r);
                })
                .addOnFailureListener((e) -> call.reject(String.valueOf(e.getMessage()), "ECHEC", e));
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()), "ECHEC", e);
        }
    }
}
