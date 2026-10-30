package com.kissmyapps

import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

// What the client needs from the platform. The Android layer passes real ones; tests pass
// fakes with a clock they control.

internal class DeviceInfo(
    val platform: String,
    val osName: String,
    val osVersion: String,
    val deviceType: String,
    val deviceModel: String?,
    val screenWidth: Int,
    val screenHeight: Int,
    val timezone: String,
    val language: String,
)

internal interface Store {
    fun read(name: String): String?
    fun write(name: String, value: String)
}

internal class Response(val status: Int, val text: String)

internal interface Transport {
    /** Throws when the request could not be made, such as when the device is offline. */
    fun post(url: String, key: String, body: String): Response
}

internal fun interface Cancellable {
    fun cancel()
}

/** Runs tasks one at a time, in order, off the caller's thread. */
internal interface Scheduler {
    fun execute(task: () -> Unit)
    fun schedule(delayMillis: Long, task: () -> Unit): Cancellable
}

internal class Platform(
    val store: Store?,
    val transport: Transport,
    val scheduler: Scheduler,
    val device: () -> DeviceInfo,
    val sdk: String,
    val now: () -> Long = System::currentTimeMillis,
    val log: (String) -> Unit = { System.err.println(it) },
)

/** Keeps each value in its own file, replaced whole so a crash never leaves half a file. */
internal class FileStore(private val directory: File) : Store {
    override fun read(name: String): String? {
        val file = File(directory, "$name.json")
        return if (file.exists()) file.readText() else null
    }

    override fun write(name: String, value: String) {
        directory.mkdirs()
        val temporary = File(directory, "$name.json.tmp")
        temporary.writeText(value)
        if (!temporary.renameTo(File(directory, "$name.json"))) {
            File(directory, "$name.json").writeText(value)
            temporary.delete()
        }
    }
}

internal class UrlTransport(private val timeoutMillis: Int = 15_000) : Transport {
    override fun post(url: String, key: String, body: String): Response {
        val connection = URI.create(url).toURL().openConnection() as HttpURLConnection
        try {
            val bytes = body.toByteArray(Charsets.UTF_8)
            connection.requestMethod = "POST"
            connection.connectTimeout = timeoutMillis
            connection.readTimeout = timeoutMillis
            connection.doOutput = true
            connection.setFixedLengthStreamingMode(bytes.size)
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Authorization", "Bearer $key")
            connection.outputStream.use { it.write(bytes) }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            return Response(status, text)
        } finally {
            connection.disconnect()
        }
    }
}

/** One background thread for the SDK; a failing task is logged, never thrown into the app. */
internal class ExecutorScheduler(private val log: (String) -> Unit) : Scheduler {
    private val executor: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { task ->
            Thread(task, "KissMyApps").apply { isDaemon = true }
        }

    override fun execute(task: () -> Unit) {
        try {
            executor.execute { guarded(task) }
        } catch (_: RejectedExecutionException) {
        }
    }

    override fun schedule(delayMillis: Long, task: () -> Unit): Cancellable {
        return try {
            val future = executor.schedule({ guarded(task) }, delayMillis, TimeUnit.MILLISECONDS)
            Cancellable { future.cancel(false) }
        } catch (_: RejectedExecutionException) {
            Cancellable {}
        }
    }

    private fun guarded(task: () -> Unit) {
        try {
            task()
        } catch (error: Exception) {
            log("KissMyApps: $error")
        }
    }
}
