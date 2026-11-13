import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    `maven-publish`
}

android {
    namespace = "com.kissmyapps"
    compileSdk = 35

    defaultConfig {
        minSdk = 21
    }

    sourceSets["main"].java.srcDir("../core/src/main/kotlin")

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    publishing {
        singleVariant("release") {
            withSourcesJar()
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_1_8)
    }
}

dependencies {
    // Google Play's install referrer: which smart link brought the install. Its own manifest
    // adds the one permission it needs to ask the Play Store; the SDK adds none.
    implementation("com.android.installreferrer:installreferrer:2.2")
}

// JitPack sets GROUP, ARTIFACT and VERSION from the repository and tag it builds.
publishing {
    publications {
        register<MavenPublication>("release") {
            groupId = System.getenv("GROUP") ?: "com.kissmyapps"
            artifactId = System.getenv("ARTIFACT") ?: "kissmyapps"
            version = System.getenv("VERSION") ?: "1.1.0"
            afterEvaluate {
                from(components["release"])
            }
            pom {
                name.set("KissMyApps for Android")
                description.set("Sessions, installs, screens, events, install attribution and deep links for your KissMyApps project.")
                licenses {
                    license {
                        name.set("MIT")
                    }
                }
            }
        }
    }
}
