package fr.tuilesettoiles.app;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * Mise a jour de l'appli depuis les Releases GitHub (src/mobile/maj.js) :
 *   infos()       version installee, droit d'installer des applis
 *   telecharger() APK dans le cache (maj/), taille + SHA-256 verifies,
 *                 evenement « progression » { recu, total }
 *   installer()   ouvre l'installateur d'Android sur l'APK ; sans le droit
 *                 « Installer des applis inconnues », ouvre d'abord le reglage
 *   nettoyer()    supprime les APK deja installes / abandonnes
 * Seules les URL des Releases du depot sont acceptees.
 */
@CapacitorPlugin(name = "MiseAJour")
public class MiseAJourPlugin extends Plugin {

    private static final String PREFIXE = "https://github.com/EryoGreg/tuiles-et-toiles/releases/download/";
    private static final String TAG = "TuilesEtToiles";

    private File dossier() {
        File d = new File(getContext().getCacheDir(), "maj");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private boolean peutInstaller() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O
            || getContext().getPackageManager().canRequestPackageInstalls();
    }

    @PluginMethod
    public void infos(PluginCall call) {
        JSObject r = new JSObject();
        try {
            PackageInfo p = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            r.put("versionName", p.versionName);
            r.put("versionCode", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? p.getLongVersionCode() : p.versionCode);
        } catch (Exception e) {
            Log.w(TAG, "infos", e);
        }
        r.put("peutInstaller", peutInstaller());
        call.resolve(r);
    }

    @PluginMethod
    public void nettoyer(PluginCall call) {
        int n = 0;
        File[] fichiers = dossier().listFiles();
        if (fichiers != null) for (File f : fichiers) if (f.delete()) n++;
        JSObject r = new JSObject();
        r.put("supprimes", n);
        call.resolve(r);
    }

    @PluginMethod
    public void telecharger(PluginCall call) {
        final String url = call.getString("url", "");
        final String nom = call.getString("nom", "");
        final long taille = call.getLong("taille", -1L);
        final String sha256 = call.getString("sha256", null);
        if (!url.startsWith(PREFIXE) || !nom.matches("^Tuiles-et-Toiles-\\d+\\.\\d+\\.\\d+\\.apk$")) {
            call.reject("Adresse de mise à jour refusée.");
            return;
        }
        new Thread(() -> {
            File part = new File(dossier(), nom + ".part");
            File cible = new File(dossier(), nom);
            HttpURLConnection cx = null;
            try {
                cx = (HttpURLConnection) new URL(url).openConnection();
                cx.setInstanceFollowRedirects(true);   // github.com -> stockage GitHub (https -> https)
                cx.setConnectTimeout(15000);
                cx.setReadTimeout(30000);
                int statut = cx.getResponseCode();
                if (statut != 200) throw new Exception("Téléchargement " + statut);
                long total = taille > 0 ? taille : cx.getContentLengthLong();

                MessageDigest md = MessageDigest.getInstance("SHA-256");
                long recu = 0;
                long dernier = 0;
                try (InputStream in = cx.getInputStream(); FileOutputStream out = new FileOutputStream(part)) {
                    byte[] tampon = new byte[64 * 1024];
                    int lu;
                    while ((lu = in.read(tampon)) != -1) {
                        out.write(tampon, 0, lu);
                        md.update(tampon, 0, lu);
                        recu += lu;
                        long t = System.currentTimeMillis();
                        if (t - dernier > 200) {
                            dernier = t;
                            JSObject p = new JSObject();
                            p.put("recu", recu);
                            p.put("total", total);
                            notifyListeners("progression", p);
                        }
                    }
                }
                if (taille > 0 && recu != taille) {
                    throw new Exception("Fichier incomplet (" + recu + " / " + taille + " octets).");
                }
                if (sha256 != null && !sha256.isEmpty()) {
                    StringBuilder hex = new StringBuilder();
                    for (byte b : md.digest()) hex.append(String.format("%02x", b));
                    if (!hex.toString().equalsIgnoreCase(sha256)) {
                        throw new Exception("Empreinte SHA-256 incorrecte : fichier corrompu ou modifié.");
                    }
                }
                if (cible.exists()) cible.delete();
                if (!part.renameTo(cible)) throw new Exception("Renommage impossible.");
                JSObject p = new JSObject();
                p.put("recu", recu);
                p.put("total", total);
                notifyListeners("progression", p);
                JSObject r = new JSObject();
                r.put("chemin", cible.getAbsolutePath());
                r.put("octets", recu);
                r.put("empreinteVerifiee", sha256 != null && !sha256.isEmpty());
                call.resolve(r);
            } catch (Exception e) {
                Log.w(TAG, "telecharger", e);
                part.delete();
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            } finally {
                if (cx != null) cx.disconnect();
            }
        }).start();
    }

    @PluginMethod
    public void installer(PluginCall call) {
        String chemin = call.getString("chemin", "");
        File apk = new File(chemin);
        if (!apk.exists() || !apk.getParentFile().equals(dossier())) {
            call.reject("Mise à jour non téléchargée.");
            return;
        }
        JSObject r = new JSObject();
        try {
            if (!peutInstaller()) {
                // Premier passage : Android demande d'autoriser l'appli a
                // installer des applis. L'utilisateur revient puis relance.
                Intent reglage = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
                reglage.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(reglage);
                r.put("permission", false);
                call.resolve(r);
                return;
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            r.put("ok", true);
            call.resolve(r);
        } catch (Exception e) {
            Log.w(TAG, "installer", e);
            call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
        }
    }
}
