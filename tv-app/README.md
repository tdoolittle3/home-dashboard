# Ladybird TV (tv-app/)

A thin Android TV / Fire TV client for the ladybird home dashboard:

- **MainActivity** — fullscreen WebView on `<dashboard_url>/tv?room=<room>`, screen kept on.
- **LadybirdDream** — the same page as the system screensaver.
- **NtfyService** — foreground service subscribed to ntfy topics; survives boot.
- **Overlay banners** — ntfy messages drawn over *any* foreground app (YouTube, Sling, …).

Configuration arrives as intent extras at provisioning time — there is no on-TV UI.
The full contract (extras, topics, priorities, `/tv?room=` params) is in [CONTRACT.md](CONTRACT.md).

## Build (headless Linux)

Requires JDK 17 and the Android SDK (platform 34). One-time setup:

```sh
sudo apt-get install -y openjdk-17-jdk-headless   # or any Temurin/OpenJDK 17
export ANDROID_HOME=$HOME/android-sdk
mkdir -p $ANDROID_HOME/cmdline-tools
curl -o /tmp/clt.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
unzip /tmp/clt.zip -d /tmp/clt
mv /tmp/clt/cmdline-tools $ANDROID_HOME/cmdline-tools/latest
yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager 'platforms;android-34' 'build-tools;34.0.0' 'platform-tools'
```

Then, from `tv-app/`:

```sh
export ANDROID_HOME=$HOME/android-sdk
./gradlew assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk
```

(Gradle finds the SDK via `ANDROID_HOME`; alternatively put `sdk.dir=/path/to/android-sdk`
in `tv-app/local.properties` — never commit that file.)

## Install on the Fire TV

Enable ADB debugging on the TV (Settings → My Fire TV → Developer Options), then:

```sh
adb connect <tv-ip>:5555
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Provision

All config in one intent; re-running it overwrites only the extras you pass:

```sh
adb shell am start -n com.thomas.ladybird/.MainActivity \
  --es dashboard_url http://192.168.0.13 \
  --es room living \
  --es ntfy_url http://192.168.0.13:2586 \
  --es ntfy_topics ladybird-house,ladybird-tv-living \
  --es ntfy_token <optional>
```

Grant the overlay permission (banners are silently dropped without it — logcat says so):

```sh
adb shell appops set com.thomas.ladybird SYSTEM_ALERT_WINDOW allow
```

Optional: make it the screensaver:

```sh
adb shell settings put secure screensaver_components com.thomas.ladybird/.LadybirdDream
```

## Debug

```sh
adb logcat -s Ladybird
```

Logs the effective config (token redacted), every URL load, stream reconnects,
each received message, and the exact command to run when the overlay permission
is missing.
