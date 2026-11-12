// Build the Android app without Android Studio: finds a JDK (17+) and the Android
// SDK, builds the web app, syncs it into the Capacitor project and runs Gradle.
//   node scripts/build.mjs   -> android/app/build/outputs/apk/debug/app-debug.apk
// (A signed release build for sharing comes later; the debug APK installs fine for testing.)
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const isWin = process.platform === 'win32';
const here = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function findJavaHome() {
  if (process.env.JAVA_HOME && existsSync(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
  const roots = isWin
    ? ['C:/Program Files/Microsoft', 'C:/Program Files/Eclipse Adoptium', 'C:/Program Files/Java', 'C:/Program Files/Android/Android Studio']
    : ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines'];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    if (existsSync(join(root, 'jbr'))) return join(root, 'jbr');
    const jdk = readdirSync(root)
      .filter((d) => /jdk-?(1[7-9]|2\d)/.test(d))
      .sort()
      .pop();
    if (jdk) return join(root, jdk, existsSync(join(root, jdk, 'Contents/Home')) ? 'Contents/Home' : '');
  }
  return null;
}

function findSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    isWin && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : null,
    process.env.HOME ? join(process.env.HOME, 'Android', 'Sdk') : null,
    process.env.HOME ? join(process.env.HOME, 'Library', 'Android', 'sdk') : null,
  ];
  return candidates.find((c) => c && existsSync(c)) ?? null;
}

const javaHome = findJavaHome();
const sdk = findSdk();
if (!javaHome) {
  console.error('No JDK 17+ found. Install one (e.g. winget install Microsoft.OpenJDK.21) or set JAVA_HOME.');
  process.exit(1);
}
if (!sdk) {
  console.error('No Android SDK found. Install the Android command-line tools or set ANDROID_HOME.');
  process.exit(1);
}
const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: sdk,
  PATH: `${join(javaHome, 'bin')}${isWin ? ';' : ':'}${process.env.PATH}`,
};
console.log(`JDK: ${javaHome}\nSDK: ${sdk}`);

const run = (cmd, cwd = here) => execSync(cmd, { cwd, env, stdio: 'inherit' });
run('pnpm --filter @snackoverflow/web build', join(here, '..', '..'));
run('npx cap sync android');
const gradle = join(here, 'android', isWin ? 'gradlew.bat' : 'gradlew');
const r = spawnSync(isWin ? `"${gradle}"` : gradle, ['assembleDebug', '--no-daemon'], { cwd: join(here, 'android'), env, stdio: 'inherit', shell: isWin });
if (r.status !== 0) process.exit(r.status ?? 1);
const apk = join(here, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
console.log(`\nBuilt ${apk}`);
