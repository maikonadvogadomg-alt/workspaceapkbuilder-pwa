import JSZip from "jszip";
import type { ArchiveFile } from "./archive";

export interface AppConfig {
  appName: string;
  appId: string;
  versionName: string;
  versionCode: number;
  themeColor: string;
  bgColor: string;
  orientation: "portrait" | "landscape" | "any";
  minSdk: number;
}

export const DEFAULT_CFG: AppConfig = {
  appName: "", appId: "", versionName: "1.0.0", versionCode: 1,
  themeColor: "#6366f1", bgColor: "#0f172a", orientation: "portrait", minSdk: 22,
};

export function genCapacitorConfig(c: AppConfig) {
  return `import type { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
  appId: '${c.appId}',
  appName: '${c.appName}',
  webDir: 'dist',
  server: { androidScheme: 'https' },
};
export default config;\n`;
}

export function genRootGradle() {
  return `buildscript {
    repositories { google(); mavenCentral() }
    dependencies {
        classpath 'com.android.tools.build:gradle:8.2.2'
        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.10'
    }
}
allprojects { repositories { google(); mavenCentral() } }
task clean(type: Delete) { delete rootProject.buildDir }\n`;
}

export function genAppGradle(c: AppConfig) {
  return `apply plugin: 'com.android.application'
apply plugin: 'kotlin-android'
android {
    namespace '${c.appId}'
    compileSdk 34
    defaultConfig {
        applicationId '${c.appId}'
        minSdk ${c.minSdk}
        targetSdk 34
        versionCode ${c.versionCode}
        versionName '${c.versionName}'
    }
    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt')
        }
    }
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
}
dependencies {
    implementation 'com.getcapacitor:capacitor-android:6.1.2'
    implementation 'androidx.appcompat:appcompat:1.7.0'
    implementation 'androidx.coordinatorlayout:coordinatorlayout:1.2.0'
    implementation 'com.google.android.material:material:1.12.0'
    implementation 'androidx.webkit:webkit:1.11.0'
}\n`;
}

export function genSettingsGradle(c: AppConfig) {
  const safe = c.appName.replace(/[^a-zA-Z0-9]/g, "");
  return `rootProject.name = '${safe}'\ninclude ':app'\n`;
}

export function genManifest(c: AppConfig) {
  const screen = c.orientation === "portrait" ? "portrait"
    : c.orientation === "landscape" ? "landscape" : "unspecified";
  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET"/>
  <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
  <application
    android:allowBackup="true"
    android:icon="@mipmap/ic_launcher"
    android:label="@string/app_name"
    android:roundIcon="@mipmap/ic_launcher_round"
    android:supportsRtl="true"
    android:theme="@style/AppTheme">
    <activity
      android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale"
      android:name=".MainActivity"
      android:label="@string/title_activity_main"
      android:theme="@style/AppTheme.NoActionBarLaunch"
      android:launchMode="singleTask"
      android:screenOrientation="${screen}"
      android:windowSoftInputMode="adjustResize"
      android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
      </intent-filter>
    </activity>
  </application>
</manifest>`;
}

export function genStrings(c: AppConfig) {
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <string name="app_name">${c.appName}</string>
  <string name="title_activity_main">${c.appName}</string>
  <string name="custom_url_scheme">${c.appId.replace(/\./g, "")}</string>
</resources>`;
}

export function genStyles(c: AppConfig) {
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <style name="AppTheme" parent="Theme.AppCompat.Light.DarkActionBar">
    <item name="colorPrimary">${c.themeColor}</item>
    <item name="colorPrimaryDark">${c.bgColor}</item>
    <item name="colorAccent">${c.themeColor}</item>
  </style>
  <style name="AppTheme.NoActionBarLaunch" parent="AppTheme">
    <item name="android:background">${c.bgColor}</item>
  </style>
</resources>`;
}

export function genMainActivity(c: AppConfig) {
  const uaLine = "";
  return `package ${c.appId};
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);${uaLine}
    }
}`;
}

export function genVsCodeSettings() {
  return JSON.stringify({
    "editor.formatOnSave": true,
    "editor.tabSize": 2,
    "files.exclude": { "**/.git": true, "**/node_modules": true },
    "java.configuration.updateBuildConfiguration": "automatic",
  }, null, 2);
}

export function genVsCodeExtensions() {
  return JSON.stringify({
    recommendations: [
      "vscjava.vscode-java-pack",
      "mathiasfrohlich.Kotlin",
      "ionic.ionic",
    ],
  }, null, 2);
}

export function genReadme(c: AppConfig, source: string) {
  return `# ${c.appName} — Projeto Android (Capacitor)

## Origem
${source}

## Estrutura
\`\`\`
├── dist/           ← Arquivos do PWA (já embutidos)
├── android/        ← Projeto Android Studio
│   ├── app/
│   │   └── src/main/
│   ├── build.gradle
│   └── settings.gradle
├── capacitor.config.ts
└── README.md
\`\`\`

## Como compilar o APK

### Requisitos
- Android Studio (https://developer.android.com/studio)
- Java 17+
- Android SDK 34

### Passo a passo
1. Extraia este ZIP
2. Abra o Android Studio → File → Open → pasta \`android/\`
3. Aguarde Gradle sync (~5 min na primeira vez)
4. **Build → Build Bundle(s)/APK(s) → Build APK(s)**
5. APK gerado: \`android/app/build/outputs/apk/debug/app-debug.apk\`

### Para instalar no celular
- Configurações → Segurança → Fontes desconhecidas ✓
- Transfira o .apk e abra para instalar

### Para assinar (Google Play)
- Build → Generate Signed Bundle/APK
- Crie um keystore e guarde em segurança

## Configuração
- **Package:** \`${c.appId}\`
- **Versão:** ${c.versionName} (code: ${c.versionCode})
- **Min SDK:** Android ${c.minSdk}+
- **Orientação:** ${c.orientation}
`;
}

/* ── package.json para Capacitor + npm install ──────────────── */
export function genPackageJson(c: AppConfig): string {
  const safe = c.appName.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
  return JSON.stringify({
    name: safe || "meu-app",
    version: c.versionName,
    private: true,
    scripts: {
      copy: "cap copy android",
      build: "cd android && ./gradlew assembleDebug",
    },
    dependencies: {
      "@capacitor/android": "6.1.2",
      "@capacitor/core": "6.1.2",
    },
    devDependencies: {
      "@capacitor/cli": "6.1.2",
      typescript: "5.4.5",
    },
  }, null, 2);
}

/* ── GitHub Actions workflow — compila APK na nuvem ─────────── */
export function genGithubActionsWorkflow(c: AppConfig): string {
  return `name: Build Android APK

on:
  push:
    branches: [ main, master ]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Java 17
        uses: actions/setup-java@v4
        with:
          java-version: '17'
          distribution: 'temurin'

      - name: Setup Android SDK
        uses: android-actions/setup-android@v3

      - name: Copiar assets web para Android (sem Capacitor CLI)
        run: |
          mkdir -p android/app/src/main/assets/www
          if [ -d "www" ]; then
            cp -r www/. android/app/src/main/assets/www/
            echo "✅ Copiado www/ → Android assets"
          elif [ -d "dist" ]; then
            cp -r dist/. android/app/src/main/assets/www/
            echo "✅ Copiado dist/ → Android assets"
          else
            echo "⚠️ Nenhuma pasta www/ ou dist/ encontrada"
            ls -la
          fi
          echo "Arquivos em assets/www:"
          ls android/app/src/main/assets/www/ | head -20

      - name: Make gradlew executable
        run: chmod +x android/gradlew

      - name: Build Debug APK
        run: cd android && ./gradlew assembleDebug --no-daemon -Dorg.gradle.jvmargs=-Xmx2g

      - name: Upload APK
        uses: actions/upload-artifact@v4
        with:
          name: ${c.appName.replace(/[^a-zA-Z0-9]/g, "-")}-debug
          path: android/app/build/outputs/apk/debug/app-debug.apk
          retention-days: 30
`;
}

/* ── PWA: manifest.webmanifest ─────────────────────────────── */
export function genWebManifest(c: AppConfig): string {
  return JSON.stringify({
    name: c.appName,
    short_name: c.appName.split(" ")[0],
    description: `Aplicativo ${c.appName}`,
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: c.orientation === "any" ? "any" : c.orientation === "landscape" ? "landscape" : "portrait",
    background_color: c.bgColor,
    theme_color: c.themeColor,
    lang: "pt-BR",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  }, null, 2);
}

/* ── PWA: sw.js ─────────────────────────────────────────────── */
export function genServiceWorker(c: AppConfig): string {
  return `/* ${c.appName} — Service Worker v${c.versionName} */
const CACHE = "app-cache-v${c.versionCode}";
const BASE = "/";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll([BASE, BASE + "index.html"]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.url.includes("/api/")) return;
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match(BASE + "index.html")));
    return;
  }
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request);
      const fresh = fetch(e.request)
        .then((r) => { if (r.ok) cache.put(e.request, r.clone()); return r; })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
`;
}

/* ── PWA: injeta metatags no index.html ─────────────────────── */
function injectPwaMeta(html: string, c: AppConfig): string {
  const metaTags = `
  <!-- PWA Android -->
  <link rel="manifest" href="/manifest.webmanifest" />
  <meta name="theme-color" content="${c.themeColor}" />
  <meta name="mobile-web-app-capable" content="yes" />`;

  const swScript = `
  <!-- Service Worker -->
  <script>
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
      });
    }
  </script>`;

  // Injeta metatags no <head>
  let result = html.includes("</head>")
    ? html.replace("</head>", `${metaTags}\n</head>`)
    : metaTags + html;

  // Injeta script SW antes do </body>
  result = result.includes("</body>")
    ? result.replace("</body>", `${swScript}\n</body>`)
    : result + swScript;

  return result;
}

function strToAb(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

/* ══════════════════════════════════════════════════════════
   EAS (Expo Application Services) — build local via GitHub Actions
   Não precisa de conta Expo nem EXPO_TOKEN.
   Usa `eas build --local` que roda direto no runner do GitHub.
══════════════════════════════════════════════════════════ */

const EXPO_OWNER = "maikons-individual-orga";
const EXPO_PROJECT_ID = "4ecb0863-1738-4d4e-b693-185e905fc234";

export function genEasAppJson(c: AppConfig): string {
  const slug = c.appName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "meu-app";
  return JSON.stringify({
    expo: {
      name: c.appName,
      slug,
      version: c.versionName,
      owner: EXPO_OWNER,
      orientation: c.orientation === "landscape" ? "landscape" : "portrait",
      backgroundColor: c.bgColor,
      android: {
        package: c.appId,
        versionCode: c.versionCode,
        adaptiveIcon: { backgroundColor: c.bgColor },
      },
      plugins: ["./plugins/withCopyWww"],
      extra: {
        eas: { projectId: EXPO_PROJECT_ID },
      },
    },
  }, null, 2);
}

export function genEasAppTsx(c: AppConfig): string {
  return `import { SafeAreaView, StyleSheet, StatusBar } from 'react-native';
import { WebView } from 'react-native-webview';

export default function App() {
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar
        backgroundColor="${c.bgColor}"
        barStyle="light-content"
      />
      <WebView
        source={{ uri: 'file:///android_asset/www/index.html' }}
        style={styles.webview}
        javaScriptEnabled
        domStorageEnabled
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        originWhitelist={['*']}
        mixedContentMode="always"
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '${c.bgColor}' },
  webview: { flex: 1 },
});
`;
}

export function genEasBabelConfig(): string {
  return `module.exports = function(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
`;
}

export function genEasPackageJson(c: AppConfig): string {
  const safe = c.appName.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase() || "meu-app";
  return JSON.stringify({
    name: safe,
    version: c.versionName,
    main: "node_modules/expo/AppEntry.js",
    private: true,
    scripts: {
      start: "expo start",
      android: "expo run:android",
    },
    dependencies: {
      expo: "~51.0.28",
      "expo-status-bar": "~1.12.1",
      react: "18.2.0",
      "react-native": "0.74.5",
      "react-native-webview": "13.10.2",
    },
    devDependencies: {
      "@babel/core": "^7.24.0",
      "@expo/config-plugins": "~8.0.0",
      "typescript": "~5.3.3",
    },
  }, null, 2);
}

export function genEasJson(): string {
  return JSON.stringify({
    cli: { version: ">= 10.0.0", appVersionSource: "local" },
    build: {
      preview: {
        android: {
          buildType: "apk",
        },
      },
      production: {
        android: {
          buildType: "app-bundle",
        },
      },
    },
  }, null, 2);
}

export function genCopyWwwPlugin(): string {
  return `const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const item of fs.readdirSync(src)) {
    const s = path.join(src, item);
    const d = path.join(dst, item);
    if (fs.statSync(s).isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

module.exports = function withCopyWww(config) {
  return withDangerousMod(config, ['android', (config) => {
    const src = path.join(config.modRequest.projectRoot, 'www');
    const dst = path.join(config.modRequest.platformProjectRoot, 'app/src/main/assets/www');
    if (fs.existsSync(src)) {
      copyDir(src, dst);
      console.log('[withCopyWww] Copiado www/ →', dst);
    } else {
      console.warn('[withCopyWww] Pasta www/ não encontrada em', src);
    }
    return config;
  }]);
};
`;
}

/** Workflow EAS CLOUD — usa a conta Expo do usuário (requer EXPO_TOKEN como secret) */
export function genEASCloudWorkflow(c: AppConfig): string {
  const safeName = c.appName.replace(/[^a-zA-Z0-9]/g, "-");
  return `name: Build APK via EAS Cloud

on:
  push:
    branches: [main, master]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Setup Expo + EAS CLI
        uses: expo/expo-github-action@v8
        with:
          expo-version: latest
          eas-version: latest
          token: \${{ secrets.EXPO_TOKEN }}

      - name: Install dependencies
        run: npm install

      - name: Build APK via EAS (cloud)
        id: build
        run: |
          BUILD_OUTPUT=$(eas build --platform android --profile preview --non-interactive --json --no-wait 2>/dev/null || echo '[]')
          echo "build_output=$BUILD_OUTPUT"
          BUILD_ID=$(echo "$BUILD_OUTPUT" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log((Array.isArray(d)?d[0]:d)?.id||'')" 2>/dev/null || echo "")
          BUILD_URL=$(echo "$BUILD_OUTPUT" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log((Array.isArray(d)?d[0]:d)?.buildDetailsPageUrl||'')" 2>/dev/null || echo "")
          echo "build_id=$BUILD_ID" >> $GITHUB_OUTPUT
          echo "build_url=$BUILD_URL" >> $GITHUB_OUTPUT
          echo "EAS Build ID: $BUILD_ID"
          echo "EAS Build URL: $BUILD_URL"
        env:
          EXPO_TOKEN: \${{ secrets.EXPO_TOKEN }}

      - name: Aguardar e baixar APK do EAS
        run: |
          BUILD_ID="\${{ steps.build.outputs.build_id }}"
          if [ -z "$BUILD_ID" ]; then echo "Build ID não encontrado, verificando localmente..."; exit 0; fi
          for i in $(seq 1 40); do
            sleep 30
            STATUS=$(eas build:view "$BUILD_ID" --json 2>/dev/null | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.status||'')" 2>/dev/null || echo "")
            echo "[$i/40] Status: $STATUS"
            if [ "$STATUS" = "FINISHED" ]; then
              APK_URL=$(eas build:view "$BUILD_ID" --json 2>/dev/null | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.artifacts?.buildUrl||'')" 2>/dev/null || echo "")
              if [ -n "$APK_URL" ]; then
                curl -L "$APK_URL" -o ${safeName}-debug.apk
                echo "✅ APK baixado!"
              fi
              break
            elif [ "$STATUS" = "ERRORED" ] || [ "$STATUS" = "CANCELLED" ]; then
              echo "❌ Build falhou: $STATUS"
              exit 1
            fi
          done
        env:
          EXPO_TOKEN: \${{ secrets.EXPO_TOKEN }}

      - name: Upload APK
        uses: actions/upload-artifact@v4
        with:
          name: ${safeName}-apk
          path: '*.apk'
          if-no-files-found: warn
          retention-days: 30
`;
}

export function genEASWorkflow(c: AppConfig): string {
  const safeName = c.appName.replace(/[^a-zA-Z0-9]/g, "-");
  return `name: Build APK via EAS Local

on:
  push:
    branches: [main, master]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Setup Java 17
        uses: actions/setup-java@v4
        with:
          java-version: '17'
          distribution: 'temurin'

      - name: Setup Android SDK
        uses: android-actions/setup-android@v3

      - name: Install dependencies
        run: npm install

      - name: Install EAS CLI
        run: npm install -g eas-cli

      - name: Expo Prebuild (gera código Android nativo)
        run: npx expo prebuild --platform android --clean --no-install
        env:
          EXPO_NO_TELEMETRY: 1

      - name: Copiar arquivos www para Android assets
        run: |
          mkdir -p android/app/src/main/assets/www
          cp -r www/. android/app/src/main/assets/www/
          echo "Arquivos copiados:"
          ls android/app/src/main/assets/www/

      - name: Permissão gradlew
        run: chmod +x android/gradlew

      - name: Build APK Debug
        run: cd android && ./gradlew assembleDebug --no-daemon -Dorg.gradle.jvmargs=-Xmx2g

      - name: Localizar APK
        run: find android -name "*.apk" | head -5

      - name: Upload APK
        uses: actions/upload-artifact@v4
        with:
          name: ${safeName}-debug-apk
          path: android/app/build/outputs/apk/debug/app-debug.apk
          retention-days: 30
`;
}

/** Retorna arquivos do projeto Expo (EAS) para push direto ao GitHub */
export async function buildEASFilesForGithub(
  cfg: AppConfig,
  files: ArchiveFile[],
  source: string,
  workflowGen?: (c: AppConfig) => string
): Promise<ArchiveFile[]> {
  const result: ArchiveFile[] = [];
  const workflow = workflowGen ? workflowGen(cfg) : genEASWorkflow(cfg);

  // Arquivos raiz do projeto Expo
  result.push({ path: "app.json",           content: strToAb(genEasAppJson(cfg)) });
  result.push({ path: "App.tsx",            content: strToAb(genEasAppTsx(cfg)) });
  result.push({ path: "babel.config.js",    content: strToAb(genEasBabelConfig()) });
  result.push({ path: "package.json",       content: strToAb(genEasPackageJson(cfg)) });
  result.push({ path: "eas.json",           content: strToAb(genEasJson()) });
  result.push({ path: "plugins/withCopyWww.js", content: strToAb(genCopyWwwPlugin()) });
  result.push({ path: ".github/workflows/build-apk.yml", content: strToAb(workflow) });
  result.push({ path: "README.md",          content: strToAb(genReadme(cfg, source)) });
  result.push({ path: "tsconfig.json",      content: strToAb(JSON.stringify({
    extends: "expo/tsconfig.base",
    compilerOptions: { strict: true },
  }, null, 2)) });

  // Web files → pasta www/
  let hasIndex = false;
  for (const f of files) {
    const safePath = f.path.replace(/^\/+/, "");
    if (!safePath) continue;
    if (safePath === "index.html" || safePath.endsWith("/index.html")) hasIndex = true;
    result.push({ path: `www/${safePath}`, content: f.content });
  }
  if (!hasIndex) {
    result.push({ path: "www/index.html", content: strToAb(
      `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${cfg.appName}</title></head><body><div id="root"></div></body></html>`
    )});
  }

  return result;
}

/** Retorna todos os arquivos do projeto Android como array (para push direto ao GitHub) */
export async function buildAndroidFilesForGithub(
  cfg: AppConfig,
  files: ArchiveFile[],
  source: string
): Promise<ArchiveFile[]> {
  const result: ArchiveFile[] = [];
  const pkgParts = cfg.appId.split(".");

  // Arquivos raiz
  result.push({ path: "capacitor.config.ts", content: strToAb(genCapacitorConfig(cfg)) });
  result.push({ path: "README.md", content: strToAb(genReadme(cfg, source)) });
  result.push({ path: "package.json", content: strToAb(genPackageJson(cfg)) });
  result.push({ path: "tsconfig.json", content: strToAb(JSON.stringify({ compilerOptions: { target: "ES2020", module: "commonjs", strict: false, esModuleInterop: true } }, null, 2)) });
  result.push({ path: ".github/workflows/build-apk.yml", content: strToAb(genGithubActionsWorkflow(cfg)) });

  // Processa arquivos web
  const dec = new TextDecoder();
  let hasIndex = false;
  const processedWeb: { path: string; content: ArrayBuffer }[] = [];
  for (const f of files) {
    const safePath = f.path.replace(/^\/+/, "");
    if (!safePath) continue;
    if (safePath === "index.html" || safePath.endsWith("/index.html")) {
      hasIndex = true;
      const ab = strToAb(injectPwaMeta(f.content ? dec.decode(f.content) : "", cfg));
      processedWeb.push({ path: safePath, content: ab });
    } else {
      processedWeb.push({ path: safePath, content: f.content });
    }
  }
  if (!hasIndex) {
    processedWeb.push({ path: "index.html", content: strToAb(injectPwaMeta(
      `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${cfg.appName}</title></head><body><div id="root"></div></body></html>`,
      cfg
    ))});
  }
  processedWeb.push({ path: "manifest.webmanifest", content: strToAb(genWebManifest(cfg)) });
  processedWeb.push({ path: "sw.js", content: strToAb(genServiceWorker(cfg)) });

  for (const f of processedWeb) {
    result.push({ path: `dist/${f.path}`, content: f.content });
    result.push({ path: `android/app/src/main/assets/public/${f.path}`, content: f.content });
  }

  // Projeto Android
  result.push({ path: "android/build.gradle", content: strToAb(genRootGradle()) });
  result.push({ path: "android/settings.gradle", content: strToAb(genSettingsGradle(cfg)) });
  result.push({ path: "android/gradle.properties", content: strToAb("android.useAndroidX=true\nandroid.enableJetifier=true\norg.gradle.jvmargs=-Xmx2048m\n") });
  result.push({ path: "android/app/build.gradle", content: strToAb(genAppGradle(cfg)) });
  result.push({ path: "android/app/src/main/AndroidManifest.xml", content: strToAb(genManifest(cfg)) });
  result.push({ path: "android/app/src/main/res/values/strings.xml", content: strToAb(genStrings(cfg)) });
  result.push({ path: "android/app/src/main/res/values/styles.xml", content: strToAb(genStyles(cfg)) });
  result.push({ path: `android/app/src/main/java/${pkgParts.join("/")}/MainActivity.java`, content: strToAb(genMainActivity(cfg)) });

  return result;
}

export async function buildAndroidZip(
  cfg: AppConfig,
  files: ArchiveFile[],
  source: string
): Promise<Blob> {
  const zip = new JSZip();
  const pkgParts = cfg.appId.split(".");

  zip.file("capacitor.config.ts", genCapacitorConfig(cfg));
  zip.file("README.md", genReadme(cfg, source));
  zip.file("package.json", genPackageJson(cfg));
  zip.file("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2020", module: "commonjs", strict: false, esModuleInterop: true } }, null, 2));
  zip.file(".vscode/settings.json", genVsCodeSettings());
  zip.file(".vscode/extensions.json", genVsCodeExtensions());
  zip.file(".github/workflows/build-apk.yml", genGithubActionsWorkflow(cfg));

  // Processa web files uma vez — injeta PWA no index.html
  const dec = new TextDecoder();
  let hasIndex = false;
  const processedFiles: { path: string; content: ArrayBuffer | string }[] = [];
  for (const f of files) {
    const safePath = f.path.replace(/^\/+/, "");
    if (!safePath) continue;
    if (safePath === "index.html" || safePath.endsWith("/index.html")) {
      hasIndex = true;
      processedFiles.push({ path: safePath, content: injectPwaMeta(f.content ? dec.decode(f.content) : "", cfg) });
    } else {
      processedFiles.push({ path: safePath, content: f.content });
    }
  }
  if (!hasIndex) {
    processedFiles.push({ path: "index.html", content: injectPwaMeta(
      `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${cfg.appName}</title></head><body><div id="root"></div></body></html>`,
      cfg
    )});
  }
  processedFiles.push({ path: "manifest.webmanifest", content: genWebManifest(cfg) });
  processedFiles.push({ path: "sw.js", content: genServiceWorker(cfg) });

  // dist/ — para referência e cap copy
  const dist = zip.folder("dist")!;
  // android/app/src/main/assets/public/ — para build direto (GitHub Actions)
  const pub = zip.folder("android")!.folder("app")!.folder("src")!.folder("main")!.folder("assets")!.folder("public")!;
  for (const f of processedFiles) {
    try { dist.file(f.path, f.content); } catch { /* skip */ }
    try { pub.file(f.path, f.content); } catch { /* skip */ }
  }

  // Android project
  const android = zip.folder("android")!;
  android.file("build.gradle", genRootGradle());
  android.file("settings.gradle", genSettingsGradle(cfg));
  android.file("gradle.properties", "android.useAndroidX=true\nandroid.enableJetifier=true\norg.gradle.jvmargs=-Xmx2048m\n");

  const app = android.folder("app")!;
  app.file("build.gradle", genAppGradle(cfg));

  const main = app.folder("src")!.folder("main")!;
  main.file("AndroidManifest.xml", genManifest(cfg));

  const res = main.folder("res")!;
  res.folder("values")!.file("strings.xml", genStrings(cfg));
  res.folder("values")!.file("styles.xml", genStyles(cfg));

  // Java package path
  let cur = main.folder("java")!;
  for (const part of pkgParts) cur = cur.folder(part)!;
  cur.file("MainActivity.java", genMainActivity(cfg));

  return zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}
