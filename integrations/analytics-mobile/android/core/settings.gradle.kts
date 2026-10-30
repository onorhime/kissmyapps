// The SDK's platform-free core, built and tested on the JVM. The Android library
// (../kissmyapps) compiles these same sources into the AAR.
pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
}

rootProject.name = "kissmyapps-core"
