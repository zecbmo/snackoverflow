package app.snackoverflow.android;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Checks the household server's notification inbox and shows anything new as a
 * normal Android notification. Runs about every 15 minutes (Android decides the
 * exact time). No Firebase or Google push service is involved.
 */
public class InboxWorker extends Worker {
    static final String PREFS = "snackoverflow.inbox";
    static final String CHANNEL_ID = "reminders";

    public InboxWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String server = prefs.getString("server", null);
        String token = prefs.getString("token", null);
        if (server == null || token == null) return Result.success();
        long cursor = prefs.getLong("cursor", 0);

        HttpURLConnection conn = null;
        try {
            URL url = new URL(server + "/api/notifications?after=" + cursor + "&limit=20");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "application/json");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            int status = conn.getResponseCode();
            if (status == 401) {
                // Signed out elsewhere (or the phone was removed): stop checking.
                prefs.edit().remove("token").apply();
                return Result.success();
            }
            if (status != 200) return Result.retry();
            JSONObject body = new JSONObject(readAll(conn.getInputStream()));
            JSONArray items = body.optJSONArray("items");
            if (items != null) {
                for (int i = 0; i < items.length(); i++) show(ctx, items.getJSONObject(i));
            }
            long next = body.optLong("cursor", cursor);
            if (next > cursor) prefs.edit().putLong("cursor", next).apply();
            return Result.success();
        } catch (IOException e) {
            return Result.retry();
        } catch (Exception e) {
            return Result.failure();
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Food reminders", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("Food going off, and other reminders from Snack Overflow");
            ctx.getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    /** A link back into the app; MainActivity hands it to the web app (App plugin, appUrlOpen). */
    private static PendingIntent link(Context ctx, int requestCode, Uri uri) {
        Intent intent = new Intent(Intent.ACTION_VIEW, uri, ctx, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void show(Context ctx, JSONObject n) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        ensureChannel(ctx);
        int id = (int) (n.optLong("seq") % Integer.MAX_VALUE);
        String path = n.optString("url", "/inbox");
        JSONObject data = n.optJSONObject("data");

        Uri open = new Uri.Builder().scheme("snackoverflow").authority("notification")
                .appendQueryParameter("url", path).appendQueryParameter("id", String.valueOf(id)).build();
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setColor(Color.parseColor("#6B4EFF"))
                .setContentTitle(n.optString("title"))
                .setContentText(n.optString("body"))
                .setStyle(new NotificationCompat.BigTextStyle().bigText(n.optString("body")))
                .setAutoCancel(true)
                .setContentIntent(link(ctx, id * 4, open));

        JSONArray actions = n.optJSONArray("actions");
        if (actions != null) {
            for (int i = 0; i < actions.length() && i < 3; i++) {
                JSONObject a = actions.optJSONObject(i);
                if (a == null) continue;
                Uri.Builder ub = new Uri.Builder().scheme("snackoverflow").authority("notification")
                        .appendQueryParameter("action", a.optString("action"))
                        .appendQueryParameter("url", path)
                        .appendQueryParameter("id", String.valueOf(id));
                // The notification's data (stockItemId, entryId, recipeId...) goes along too.
                if (data != null) {
                    java.util.Iterator<String> keys = data.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        Object v = data.opt(k);
                        if (v instanceof String || v instanceof Number) ub.appendQueryParameter(k, String.valueOf(v));
                    }
                }
                b.addAction(0, a.optString("title"), link(ctx, id * 4 + 1 + i, ub.build()));
            }
        }
        NotificationManagerCompat.from(ctx).notify(id, b.build());
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int r;
        while ((r = in.read(buf)) != -1) out.write(buf, 0, r);
        return out.toString(StandardCharsets.UTF_8.name());
    }
}
