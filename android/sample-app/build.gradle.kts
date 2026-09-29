plugins {
    id("com.android.application")
}

android {
    namespace = "com.androiduiinspector.sample"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.androiduiinspector.sample"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1"
    }
}

dependencies {
    debugImplementation(project(":inspector-sdk"))
}
