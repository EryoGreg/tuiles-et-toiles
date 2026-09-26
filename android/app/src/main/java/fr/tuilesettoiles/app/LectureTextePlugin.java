package fr.tuilesettoiles.app;

import android.graphics.Point;
import android.graphics.Rect;
import android.net.Uri;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.common.moduleinstall.ModuleInstall;
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

/**
 * Lecture du texte d'une photo (cartel de musee) par Google ML Kit Text
 * Recognition v2, modele latin fourni par les services Google Play :
 * telecharge une fois (preparer(), en Wi-Fi au lancement), puis hors ligne ;
 * la photo n'est envoyee nulle part (regle 1). Utilise par src/mobile/cartel.js.
 *
 *   etat()         { disponible } : modele deja sur le telephone ?
 *   preparer()     telecharge le modele s'il manque -> { disponible }
 *   lire({ uri })  uri file:// ou content:// (appareil photo, galerie) ->
 *     { largeur, hauteur, texte, blocs: [{ texte, cadre, lignes: [{ texte,
 *       cadre, confiance, angle, hauteurMoyenne }] }] }
 *   cadre = { x, y, l, h } en pixels de l'image (orientation EXIF appliquee).
 */
@CapacitorPlugin(name = "LectureTexte")
public class LectureTextePlugin extends Plugin {

    private static final String TAG = "TuilesEtToiles";
    private TextRecognizer lecteur;

    private TextRecognizer lecteur() {
        if (lecteur == null) lecteur = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        return lecteur;
    }

    private static JSObject cadre(Rect r) {
        JSObject o = new JSObject();
        if (r == null) return o;
        o.put("x", r.left);
        o.put("y", r.top);
        o.put("l", r.width());
        o.put("h", r.height());
        return o;
    }

    // Hauteur d'une ligne mesuree perpendiculairement au texte (coins), plus
    // fiable que le cadre englobant quand la photo est prise de biais.
    private static double hauteurLigne(Text.Line ligne) {
        Point[] c = ligne.getCornerPoints();
        if (c == null || c.length < 4) {
            Rect r = ligne.getBoundingBox();
            return r == null ? 0 : r.height();
        }
        double g = Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y);   // bord gauche
        double d = Math.hypot(c[2].x - c[1].x, c[2].y - c[1].y);   // bord droit
        return (g + d) / 2;
    }

    @PluginMethod
    public void etat(PluginCall call) {
        ModuleInstall.getClient(getContext()).areModulesAvailable(lecteur())
            .addOnSuccessListener((r) -> {
                JSObject o = new JSObject();
                o.put("disponible", r.areModulesAvailable());
                call.resolve(o);
            })
            .addOnFailureListener((Exception e) -> call.reject("Services Google indisponibles : " + e.getMessage()));
    }

    @PluginMethod
    public void preparer(PluginCall call) {
        ModuleInstallRequest demande = ModuleInstallRequest.newBuilder().addApi(lecteur()).build();
        ModuleInstall.getClient(getContext()).installModules(demande)
            .addOnSuccessListener((r) -> {
                JSObject o = new JSObject();
                o.put("disponible", true);
                o.put("dejaLa", r.areModulesAlreadyInstalled());
                call.resolve(o);
            })
            .addOnFailureListener((Exception e) -> {
                Log.w(TAG, "preparer : modele non installe", e);
                call.reject("Modèle de lecture non téléchargé : " + e.getMessage());
            });
    }

    @PluginMethod
    public void lire(PluginCall call) {
        String uri = call.getString("uri", "");
        if (uri.isEmpty()) {
            call.reject("Aucune image.");
            return;
        }
        final InputImage image;
        try {
            image = InputImage.fromFilePath(getContext(), Uri.parse(uri));
        } catch (Exception e) {
            Log.w(TAG, "lire : image illisible", e);
            call.reject("Image illisible : " + e.getMessage());
            return;
        }
        final long t0 = System.currentTimeMillis();
        lecteur().process(image)
            .addOnSuccessListener((Text resultat) -> {
                JSArray blocs = new JSArray();
                for (Text.TextBlock b : resultat.getTextBlocks()) {
                    JSArray lignes = new JSArray();
                    for (Text.Line l : b.getLines()) {
                        JSObject o = new JSObject();
                        o.put("texte", l.getText());
                        o.put("cadre", cadre(l.getBoundingBox()));
                        o.put("confiance", l.getConfidence());
                        o.put("angle", l.getAngle());
                        o.put("hauteurMoyenne", Math.round(hauteurLigne(l)));
                        lignes.put(o);
                    }
                    JSObject bo = new JSObject();
                    bo.put("texte", b.getText());
                    bo.put("cadre", cadre(b.getBoundingBox()));
                    bo.put("lignes", lignes);
                    blocs.put(bo);
                }
                JSObject r = new JSObject();
                r.put("largeur", image.getWidth());
                r.put("hauteur", image.getHeight());
                r.put("rotation", image.getRotationDegrees());
                r.put("texte", resultat.getText());
                r.put("blocs", blocs);
                r.put("ms", System.currentTimeMillis() - t0);
                call.resolve(r);
            })
            .addOnFailureListener((Exception e) -> {
                Log.w(TAG, "lire : echec ML Kit", e);
                call.reject("Lecture impossible : " + e.getMessage());
            });
    }

    @Override
    protected void handleOnDestroy() {
        if (lecteur != null) lecteur.close();
        lecteur = null;
    }
}
