package app.snackoverflow.android;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugin: background inbox checks and notifications (no Firebase).
        registerPlugin(InboxPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
