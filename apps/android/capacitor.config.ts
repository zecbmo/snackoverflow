import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The Android app bundles the built web app (apps/web/dist) and talks to the
 * household's own server, whose address is entered on first launch.
 */
const config: CapacitorConfig = {
  appId: 'app.snackoverflow.android',
  appName: 'Snack Overflow',
  webDir: '../web/dist',
  server: {
    androidScheme: 'https',
    // Home servers are often plain http on the local network.
    cleartext: true,
  },
  android: {
    // Lets the app open a ws:// live connection to an http home server.
    allowMixedContent: true,
  },
  plugins: {
    // Send fetch() through Android's HTTP stack: no CORS, and http servers work.
    CapacitorHttp: { enabled: true },
    // Background notification checks are the app's own Inbox plugin
    // (android/app/src/main/java/.../InboxWorker.java), not a push service.
  },
};

export default config;
