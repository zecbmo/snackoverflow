package app.snackoverflow.android;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.core.app.NotificationManagerCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.concurrent.TimeUnit;

/**
 * Lets the web app turn on the background inbox check (InboxWorker) for the
 * signed-in phone, and ask for permission to show notifications.
 */
@CapacitorPlugin(
    name = "Inbox",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class InboxPlugin extends Plugin {
    private static final String WORK = "snackoverflow-inbox";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(InboxWorker.PREFS, Context.MODE_PRIVATE);
    }

    private Constraints online() {
        return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    }

    /** Remember the server and device token, then check about every 15 minutes. */
    @PluginMethod
    public void configure(PluginCall call) {
        String server = call.getString("server");
        String token = call.getString("token");
        if (server == null || token == null) {
            call.reject("server and token are required");
            return;
        }
        long cursor = call.getLong("cursor", 0L);
        SharedPreferences p = prefs();
        boolean sameAccount = server.equals(p.getString("server", null)) && token.equals(p.getString("token", null));
        long current = sameAccount ? p.getLong("cursor", 0) : 0;
        p.edit().putString("server", server).putString("token", token).putLong("cursor", Math.max(current, cursor)).apply();
        PeriodicWorkRequest work = new PeriodicWorkRequest.Builder(InboxWorker.class, 15, TimeUnit.MINUTES)
            .setConstraints(online())
            .build();
        WorkManager.getInstance(getContext()).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, work);
        InboxWorker.ensureChannel(getContext());
        call.resolve();
    }

    /** Check right away (used on start-up and for testing). */
    @PluginMethod
    public void checkNow(PluginCall call) {
        WorkManager.getInstance(getContext()).enqueue(new OneTimeWorkRequest.Builder(InboxWorker.class).setConstraints(online()).build());
        call.resolve();
    }

    @PluginMethod
    public void signOut(PluginCall call) {
        prefs().edit().clear().apply();
        WorkManager.getInstance(getContext()).cancelUniqueWork(WORK);
        call.resolve();
    }

    /** Dismiss a notification after one of its buttons was used. */
    @PluginMethod
    public void dismiss(PluginCall call) {
        Integer id = call.getInt("id");
        if (id != null) NotificationManagerCompat.from(getContext()).cancel(id);
        call.resolve();
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED) {
            resolvePermission(call);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationsCallback");
    }

    @PermissionCallback
    private void notificationsCallback(PluginCall call) {
        resolvePermission(call);
    }

    private void resolvePermission(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
        call.resolve(r);
    }
}
