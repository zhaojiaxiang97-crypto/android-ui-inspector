plugins { id("com.android.application") }
val legacySdkAar = providers.gradleProperty("legacySdkAar")
android {
    namespace = "com.androiduiinspector.legacywindow"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.androiduiinspector.legacywindow"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1"
    }
    // Reuse the SDK-free window fixture, without modifying the old SDK library.
    sourceSets.getByName("main").java.srcDir("../sdk-free-sample/src/main/java")
}
dependencies {
    if (legacySdkAar.isPresent) debugImplementation(files(legacySdkAar.get()))
    debugImplementation("org.lsposed.hiddenapibypass:hiddenapibypass:6.0")
}
tasks.configureEach {
    if (name == "preDebugBuild") doFirst {
        check(legacySdkAar.isPresent && file(legacySdkAar.get()).isFile) {
            "Supply -PlegacySdkAar=<verified old SDK AAR>; never silently build without the SDK"
        }
    }
}
