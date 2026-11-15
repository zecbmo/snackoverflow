package app.snackoverflow.android;

import android.view.View;
import android.view.ViewGroup;

import androidx.camera.core.Camera;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.MeteringPoint;
import androidx.camera.view.PreviewView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.lang.reflect.Field;
import java.util.concurrent.TimeUnit;

/**
 * Tap to focus for the barcode scanner. The scanner plugin (ML Kit) shows its camera in a
 * PreviewView behind the web view but has no focus call of its own, so this finds that view
 * and the camera it runs, and asks CameraX to focus and expose on the tapped point. After a
 * few seconds the camera goes back to focusing by itself.
 */
@CapacitorPlugin(name = "CameraFocus")
public class CameraFocusPlugin extends Plugin {

    /** x and y: where the tap was, as fractions (0 to 1) of the screen's width and height. */
    @PluginMethod
    public void focus(PluginCall call) {
        final float x = call.getFloat("x", 0.5f);
        final float y = call.getFloat("y", 0.5f);
        getActivity().runOnUiThread(() -> {
            JSObject result = new JSObject();
            result.put("focused", false);
            try {
                ViewGroup parent = (ViewGroup) getBridge().getWebView().getParent();
                PreviewView preview = null;
                for (int i = 0; i < parent.getChildCount(); i++) {
                    View child = parent.getChildAt(i);
                    if (child instanceof PreviewView) {
                        preview = (PreviewView) child;
                        break;
                    }
                }
                Camera camera = scannerCamera();
                if (preview != null && camera != null && preview.getWidth() > 0) {
                    MeteringPoint point = preview.getMeteringPointFactory().createPoint(x * preview.getWidth(), y * preview.getHeight());
                    FocusMeteringAction action = new FocusMeteringAction.Builder(point, FocusMeteringAction.FLAG_AF | FocusMeteringAction.FLAG_AE)
                        .setAutoCancelDuration(4, TimeUnit.SECONDS)
                        .build();
                    camera.getCameraControl().startFocusAndMetering(action);
                    result.put("focused", true);
                }
            } catch (Exception | LinkageError e) {
                // The scanner isn't running, or its insides changed: the camera keeps focusing by itself.
            }
            call.resolve(result);
        });
    }

    /** The camera the scanner plugin is running (it keeps it to itself), or null. */
    private static Camera scannerCamera() throws Exception {
        Class<?> scanner = Class.forName("io.capawesome.capacitorjs.plugins.mlkit.barcodescanning.BarcodeScanner");
        Field field = scanner.getDeclaredField("camera");
        field.setAccessible(true);
        Object camera = field.get(null);
        return camera instanceof Camera ? (Camera) camera : null;
    }
}
