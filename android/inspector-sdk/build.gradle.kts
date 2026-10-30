import java.security.MessageDigest
import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.TaskAction

plugins {
    id("com.android.library")
}

// Identifies source/configuration inputs, not a self-referential AAR binary hash.
val sdkIdentityInputs = (fileTree("src/main") {
    include("**/*.java", "**/*.xml")
}.files + listOf(file("build.gradle.kts"), rootProject.file("build.gradle.kts"), rootProject.file("settings.gradle.kts")))
    .sortedBy { it.relativeTo(rootProject.projectDir).invariantSeparatorsPath }
val sdkIdentityDigest = MessageDigest.getInstance("SHA-256")
sdkIdentityInputs.forEach {
    sdkIdentityDigest.update(it.relativeTo(rootProject.projectDir).invariantSeparatorsPath.toByteArray(Charsets.UTF_8))
    sdkIdentityDigest.update(0.toByte())
    sdkIdentityDigest.update(it.readBytes())
    sdkIdentityDigest.update(0.toByte())
}
val sdkSourceSha256 = sdkIdentityDigest.digest().joinToString("") { "%02x".format(it) }
val sdkIdentityAssets = layout.buildDirectory.dir("generated/sdk-identity-assets")
abstract class SdkIdentityAssets : DefaultTask() {
    @get:Input abstract val sourceSha256: Property<String>
    @get:OutputDirectory abstract val outputDirectory: DirectoryProperty
    @TaskAction fun generate() {
        val marker = outputDirectory.get().file("inspector-sdk-build.json").asFile
        marker.parentFile.mkdirs()
        marker.writeText("""{"protocol":"sdk-source-v1","sourceSha256":"${sourceSha256.get()}"}""")
    }
}
val generateSdkIdentityAssets = tasks.register<SdkIdentityAssets>("generateSdkIdentityAssets") {
    inputs.files(sdkIdentityInputs)
    sourceSha256.set(sdkSourceSha256)
    outputDirectory.set(sdkIdentityAssets)
}

android {
    namespace = "com.androiduiinspector.sdk"
    compileSdk = 30

    defaultConfig {
        minSdk = 21
        buildConfigField("String", "SDK_SOURCE_SHA256", "\"$sdkSourceSha256\"")
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

androidComponents.onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(generateSdkIdentityAssets, SdkIdentityAssets::outputDirectory)
}

dependencies {
    // 6.1 emits Java 11 NestHost metadata, which older ASM transforms cannot read.
    implementation("org.lsposed.hiddenapibypass:hiddenapibypass:6.0")
}
