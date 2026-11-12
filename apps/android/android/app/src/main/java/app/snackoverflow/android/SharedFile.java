package app.snackoverflow.android;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * A receipt (photo, screenshot or PDF) shared into the app from another app's
 * share sheet. Held until the web app picks it up with InboxPlugin.takeSharedFile().
 */
final class SharedFile {
    static final int MAX_BYTES = 12 * 1024 * 1024;

    private static SharedFile pending;

    final String data;
    final String type;
    final String name;

    private SharedFile(String data, String type, String name) {
        this.data = data;
        this.type = type;
        this.name = name;
    }

    /** Keep the file from a share intent. Returns true when one was kept. */
    static synchronized boolean capture(Context ctx, Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return false;
        Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (uri == null) return false;
        ContentResolver resolver = ctx.getContentResolver();
        String type = intent.getType() != null ? intent.getType() : resolver.getType(uri);
        if (type == null || !(type.startsWith("image/") || type.equals("application/pdf"))) return false;
        try (InputStream in = resolver.openInputStream(uri)) {
            if (in == null) return false;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            int r;
            while ((r = in.read(buf)) != -1) {
                out.write(buf, 0, r);
                if (out.size() > MAX_BYTES) return false; // too big to be a receipt
            }
            pending = new SharedFile(Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP), type, displayName(resolver, uri));
            // Handled: don't hand the same share to the app twice (e.g. on rotation).
            intent.setAction(Intent.ACTION_MAIN);
            return true;
        } catch (Exception e) {
            Log.w("SnackOverflow", "Couldn't read the shared file", e);
            return false;
        }
    }

    /** The waiting file, once. */
    static synchronized SharedFile take() {
        SharedFile f = pending;
        pending = null;
        return f;
    }

    private static String displayName(ContentResolver resolver, Uri uri) {
        try (Cursor c = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {
            // A name is a nicety.
        }
        return "receipt";
    }
}
