plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The fleet keystore, injected by CI (and usable locally). Without it, release
// falls back to the machine's debug key - fine for a sideload, but only APKs
// signed with THE SAME key can `adb install -r` over each other, so the APK the
// provisioning script ships must always come from the keystore-signed CI build.
val tvKeystore: String? = System.getenv("TV_KEYSTORE_FILE")?.takeIf { it.isNotBlank() }

android {
    namespace = "com.thomas.ladybird"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.thomas.ladybird"
        // Fire OS 7 (the 7.7.x TVs) is Android 9.
        minSdk = 28
        targetSdk = 34
        versionCode = 2
        versionName = "1.0.1"
    }

    if (tvKeystore != null) {
        signingConfigs {
            create("release") {
                storeFile = file(tvKeystore)
                storePassword = System.getenv("TV_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("TV_KEY_ALIAS") ?: "ladybird"
                keyPassword = System.getenv("TV_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (tvKeystore != null) signingConfigs.getByName("release")
            else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // The ntfy JSON stream and attachment fetches; okhttp's zero read-timeout
    // is what keeps the long-lived subscription open.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
