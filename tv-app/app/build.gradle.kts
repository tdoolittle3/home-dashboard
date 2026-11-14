plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

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

    buildTypes {
        release {
            isMinifyEnabled = false
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
