import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.pulse.local',
  appName: 'Pulse',
  webDir: 'web/dist',
  // Cordova compatibility (как в существующем webview):
  android: {
    allowMixedContent: true, // для fetches к habr-search (HTTP) с HTTPS webview
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 200,
      backgroundColor: '#1a1b26',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#1a1b26',
      overlaysWebView: false,
    },
    Keyboard: {
      resize: 'none', // рулим через CSS var в App
    },
  },
};

export default config;
