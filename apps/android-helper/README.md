# Beacon Motive Android helper

Optional. Without it the `android.*` operations use `uiautomator dump` (about 2.3 s per observation). With it they
read the screen in 15–35 ms. See `docs/decisions/0009-android-helper.md` for the design and the privacy boundary.

It is an instrumentation APK with no activity, service, receiver or permission. It does nothing until the computer
starts it with `adb shell am instrument`, and it ends when that command ends.

## Build

Needs a JDK 17+ (Android Studio's bundled one works) and the Android SDK (platform 35).

```bash
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"   # adjust for your machine
echo "sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk" > local.properties   # git-ignored
./gradlew :app:assembleDebug
```

The first build downloads the Android Gradle Plugin and Kotlin from Google's Maven repository and the Gradle plugin
portal. The APK is debug-signed (`app/build/outputs/apk/debug/app-debug.apk`); there is no release signing key.

## Install, check, remove

```bash
npm run motive -- android-helper install
npm run motive -- android-helper status
npm run motive -- android-helper remove
```

Set `MOTIVE_ANDROID_HELPER=off` to force the dump path for a run.
