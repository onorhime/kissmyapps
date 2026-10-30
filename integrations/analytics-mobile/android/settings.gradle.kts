// The Android library. Its platform-free core lives in ./core, a separate JVM build that
// is tested on its own; this build compiles the same sources into the AAR.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "kissmyapps-android"
include(":kissmyapps")
