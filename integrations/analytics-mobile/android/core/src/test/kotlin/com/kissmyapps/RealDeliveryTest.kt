package com.kissmyapps

import com.sun.net.httpserver.HttpServer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.net.InetSocketAddress
import java.nio.file.Files
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** The client on its real thread, HTTP transport and file storage. */
class RealDeliveryTest {
    @Test
    fun sendsOverHttpFromItsOwnThread() {
        val bodies = Collections.synchronizedList(ArrayList<JSONObject>())
        val headers = Collections.synchronizedList(ArrayList<String>())
        val backgrounded = CountDownLatch(1)
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/v1/events") { exchange ->
            val body = JSONObject(exchange.requestBody.bufferedReader().readText())
            bodies.add(body)
            headers.add(exchange.requestHeaders.getFirst("Authorization"))
            val reply = """{"stored":${body.getJSONArray("events").length()},"duplicates":0,"rejected":[]}""".toByteArray()
            exchange.sendResponseHeaders(200, reply.size.toLong())
            exchange.responseBody.use { it.write(reply) }
            if (body.toString().contains("app_backgrounded")) backgrounded.countDown()
        }
        server.start()
        val directory = Files.createTempDirectory("kma").toFile()
        try {
            val key = "kma_pk_test_ABCDEFGHJKLMNPQRSTUVWXYZ"
            val logs = Collections.synchronizedList(ArrayList<String>())
            val platform = Platform(
                FileStore(directory),
                UrlTransport(),
                ExecutorScheduler { logs.add(it) },
                { pixel },
                "kma-android/$SDK_VERSION",
            )
            val client = KmaClient(
                key,
                KissMyAppsOptions(appVersion = "1.0.0", endpoint = "http://127.0.0.1:${server.address.port}/", debug = true),
                platform,
            )
            client.foreground()
            client.screen("Home", emptyMap())
            client.track("lesson_completed", mapOf("lesson" to 1))
            client.background()
            assertTrue("nothing arrived: $logs", backgrounded.await(10, TimeUnit.SECONDS))

            val names = bodies.flatMap { body ->
                val events = body.getJSONArray("events")
                (0 until events.length()).map { events.getJSONObject(it).getString("name") }
            }
            assertEquals(
                listOf("session_started", "app_installed", "app_opened", "screen_viewed", "lesson_completed", "app_backgrounded"),
                names,
            )
            assertEquals(listOf("Bearer $key"), headers.distinct())
            bodies.forEach { expectContract(it) }
            assertEquals(client.getSessionId(), bodies[0].getJSONObject("session").getString("id"))
            client.shutdown()
        } finally {
            server.stop(0)
            directory.deleteRecursively()
        }
    }

    /**
     * Sends a real launch to a running ingest and reads back what it stored:
     * KMA_CONTRACT_ENDPOINT=http://127.0.0.1:8788 KMA_CONTRACT_KEY=kma_pk_test_… gradle test
     */
    @Test
    fun aRunningIngestStoresEverythingTheSdkSends() {
        val endpoint = System.getenv("KMA_CONTRACT_ENDPOINT").orEmpty()
        val key = System.getenv("KMA_CONTRACT_KEY").orEmpty()
        assumeTrue("KMA_CONTRACT_ENDPOINT and KMA_CONTRACT_KEY are not set", endpoint.isNotEmpty() && key.isNotEmpty())
        val replies = Collections.synchronizedList(ArrayList<JSONObject>())
        val done = CountDownLatch(1)
        val http = UrlTransport()
        val recording = object : Transport {
            override fun post(url: String, key: String, body: String): Response {
                val response = http.post(url, key, body)
                replies.add(JSONObject(response.text).put("status", response.status))
                if (body.contains("app_backgrounded")) done.countDown()
                return response
            }
        }
        val platform = Platform(
            null,
            recording,
            ExecutorScheduler { System.err.println(it) },
            { pixel },
            "kma-android/$SDK_VERSION",
        )
        val client = KmaClient(key, KissMyAppsOptions(appVersion = "1.0.0", build = "1", endpoint = endpoint, debug = true), platform)
        client.foreground()
        client.identify("android-contract-${System.currentTimeMillis()}", mapOf("plan" to "annual"))
        client.screen("Home", emptyMap())
        client.track("lesson_completed", mapOf("lesson" to 1, "sdk" to "android"))
        client.background()
        assertTrue("the ingest did not answer", done.await(15, TimeUnit.SECONDS))
        println("KMA contract: anonymous_id=${client.getAnonymousId()} replies=$replies")
        for (reply in replies) {
            assertEquals(reply.toString(), 200, reply.getInt("status"))
            assertEquals(reply.toString(), 0, reply.getJSONArray("rejected").length())
        }
        assertEquals(6, replies.sumOf { it.getInt("stored") })
        client.shutdown()
    }
}
