plugins {
    id("com.android.library")
}

android {
    namespace = "com.androiduiinspector.sdk"
    compileSdk = 30

    defaultConfig {
        minSdk = 26
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

dependencies {
    // 6.1 emits Java 11 NestHost metadata, which older ASM transforms cannot read.
    implementation("org.lsposed.hiddenapibypass:hiddenapibypass:6.0")
}
