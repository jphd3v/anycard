# Android Maintenance Guide

This project uses Capacitor with:

- web app source: `frontend/src/`
- native Android shell: `frontend/android/`
- Capacitor config/scripts: `frontend/capacitor.config.ts`, `frontend/package.json`

## 1. Prerequisites

- Android SDK + platform tools (`adb`)
- Java 21 for Gradle builds
- Node/npm dependencies installed

Use Java 21 in the current shell:

```bash
jenv shell 21
java -version
```

## 2. Day-to-day workflow

1. Edit web app code in `frontend/src/*`.
2. If needed, edit native Android files in `frontend/android/*`.
3. Sync web build into Android project (secure/hardened default):

```bash
npm --prefix frontend run android:sync
```

4. Build debug APK:

```bash
npm --prefix frontend run android:apk:debug
```

5. Build optimized release APK:

```bash
npm --prefix frontend run android:apk:release
```

6. Install to phone:

```bash
# Debug
adb install -r frontend/android/app/build/outputs/apk/debug/app-debug.apk

# Release (unsigned unless signing is configured)
adb install -r frontend/android/app/build/outputs/apk/release/app-release-unsigned.apk
```

## 3. Backend URL for device testing

Hardened builds are the default.  
Insecure local-LAN mode requires explicit opt-in.

For insecure local device testing (same Wi-Fi), set `MOBILE_INSECURE=true`:

```bash
MOBILE_INSECURE=true VITE_SERVER_URL=http://<your-lan-ip>:3000 npm --prefix frontend run android:apk:debug:insecure
```

Without `MOBILE_INSECURE=true`, HTTP endpoints are rejected (the server override field is still available).

## 4. Where to put Android customizations

- Activity/app behavior (fullscreen, lifecycle):  
  `frontend/android/app/src/main/java/io/jph/MainActivity.java`
- Manifest permissions/network/security:  
  `frontend/android/app/src/main/AndroidManifest.xml`
- Styles/themes/resources:  
  `frontend/android/app/src/main/res/*`

## 5. What is generated vs maintained

Maintain manually:

- `frontend/android/app/src/main/*` (manifest, Java, resources)
- Gradle files in `frontend/android/` and `frontend/android/app/`

Generated/overwritten by sync/build:

- `frontend/android/app/src/main/assets/*`
- `frontend/android/**/build/*`

Do not hand-edit generated assets.

## 6. Release builds

Debug APK:

```bash
cd frontend/android
./gradlew assembleDebug
```

Insecure debug APK (explicit local testing only):

```bash
MOBILE_INSECURE=true VITE_SERVER_URL=http://<your-lan-ip>:3000 npm --prefix frontend run android:apk:debug:insecure
```

Release APK/AAB (after signing config is in place):

```bash
npm --prefix frontend run android:apk:release
npm --prefix frontend run android:aab:release
```

## 7. Quick troubleshooting

- Stuck on loading screen:
  - Verify phone browser can open `http://<lan-ip>:3000/healthz`.
  - Restart backend.
  - Rebuild + reinstall APK.
- `Unsupported class file major version 69`:
  - You are on Java 25 for Gradle; switch to Java 21 (`jenv shell 21`).
- Android cannot call `http://` server:
  - Use explicit insecure mode:
    - `MOBILE_INSECURE=true`
    - `android:apk:debug:insecure` / `android:insecure` scripts
- Port/cors issues:
  - Backend must allow Capacitor origins and listen on LAN.
