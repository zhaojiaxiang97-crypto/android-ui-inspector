plugins { id("com.android.application") }

android {
    namespace = "com.androiduiinspector.sdkfree"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.androiduiinspector.sdkfree"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1"
    }
}
// No inspector SDK or reflection bypass; AGP may add its Kotlin runtime.
