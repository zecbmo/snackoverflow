package app.snackoverflow.android;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugin: background inbox checks, notifications (no Firebase) and shared receipts.
        registerPlugin(InboxPlugin.class);
        super.onCreate(savedInstanceState);
        SharedFile.capture(this, getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // A receipt shared while the app is already open: tell the web app.
        if (SharedFile.capture(this, intent) && getBridge() != null) {
            PluginHandle handle = getBridge().getPlugin("Inbox");
            if (handle != null && handle.getInstance() instanceof InboxPlugin) {
                ((InboxPlugin) handle.getInstance()).announceSharedFile();
            }
        }
    }
}
