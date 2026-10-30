import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm") version "2.0.21"
}

java {
    sourceCompatibility = JavaVersion.VERSION_1_8
    targetCompatibility = JavaVersion.VERSION_1_8
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_1_8)
        allWarningsAsErrors.set(true)
    }
}

dependencies {
    // Android ships org.json, so the library never bundles it.
    compileOnly("org.json:json:20240303")
    testImplementation("org.json:json:20240303")
    testImplementation("junit:junit:4.13.2")
}

tasks.test {
    systemProperty("kma.contract", file("../../contract/app-events.json").absolutePath)
    // Set both to also send real events to a running ingest, as the contract test does.
    environment("KMA_CONTRACT_ENDPOINT", System.getenv("KMA_CONTRACT_ENDPOINT") ?: "")
    environment("KMA_CONTRACT_KEY", System.getenv("KMA_CONTRACT_KEY") ?: "")
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
