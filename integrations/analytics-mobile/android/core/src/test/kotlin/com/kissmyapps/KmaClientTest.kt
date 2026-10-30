package com.kissmyapps

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.Date

private const val KEY = "kma_pk_live_ABCDEFGHJKLMNPQRSTUVWXYZ"
private fun minutes(n: Int) = n * 60_000L

/** A clock and timers the test moves forward by hand. Tasks run on the test's thread. */
internal class ManualScheduler : Scheduler {
    private class Task(val due: Long, val order: Long, val run: () -> Unit)

    var now = 1_793_354_340_000L // 2026-10-30T09:59:00Z
    private val tasks = ArrayList<Task>()
    private var order = 0L

    override fun execute(task: () -> Unit) = task()

    override fun schedule(delayMillis: Long, task: () -> Unit): Cancellable {
        val scheduled = Task(now + delayMillis, order++, task)
        tasks.add(scheduled)
        return Cancellable { tasks.remove(scheduled) }
    }

    fun advance(millis: Long) {
        val end = now + millis
        while (true) {
            val next = tasks.filter { it.due <= end }.minWithOrNull(compareBy({ it.due }, { it.order })) ?: break
            tasks.remove(next)
            now = maxOf(now, next.due)
            next.run()
        }
        now = end
    }
}

internal class MemoryStore : Store {
    val data = HashMap<String, String>()
    override fun read(name: String) = data[name]
    override fun write(name: String, value: String) {
        data[name] = value
    }
}

internal val pixel = DeviceInfo(
    platform = "android",
    osName = "Android",
    osVersion = "14",
    deviceType = "mobile",
    deviceModel = "Pixel 7",
    screenWidth = 412,
    screenHeight = 915,
    timezone = "Africa/Lagos",
    language = "en-NG",
)

private val contract = JSONObject(File(System.getProperty("kma.contract")).readText())

private fun strings(array: JSONArray?): List<String> =
    if (array == null) emptyList() else (0 until array.length()).map { array.getString(it) }

private fun allowed(rules: JSONObject) = strings(rules.getJSONArray("required")) + strings(rules.optJSONArray("optional"))

/** The rules every app SDK is held to, from integrations/analytics-mobile/contract. */
internal fun expectContract(body: JSONObject) {
    val time = Regex(contract.getString("time"))
    for (field in strings(contract.getJSONObject("body").getJSONArray("required"))) assertTrue(field, body.has(field))
    for (field in body.keys()) assertTrue(field, field in allowed(contract.getJSONObject("body")))
    val session = body.getJSONObject("session")
    for (field in strings(contract.getJSONObject("session").getJSONArray("required"))) assertTrue(field, session.has(field))
    val context = body.getJSONObject("context")
    for (field in strings(contract.getJSONObject("context").getJSONArray("required"))) assertTrue(field, context.has(field))
    for (field in context.keys()) assertTrue(field, field in allowed(contract.getJSONObject("context")))
    assertTrue(context.getString("platform") in strings(contract.getJSONArray("platforms")))
    assertTrue(context.getString("device_type") in strings(contract.getJSONArray("device_types")))
    assertTrue(time.matches(body.getString("sent_at")))
    val events = body.getJSONArray("events")
    for (index in 0 until events.length()) {
        val event = events.getJSONObject(index)
        for (field in strings(contract.getJSONObject("event").getJSONArray("required"))) assertTrue(field, event.has(field))
        for (field in event.keys()) assertTrue(field, field in allowed(contract.getJSONObject("event")))
        assertTrue(event.getString("name"), Regex(contract.getString("event_name")).matches(event.getString("name")))
        assertTrue(time.matches(event.getString("time")))
    }
}

class KmaClientTest {
    private lateinit var scheduler: ManualScheduler
    private val sent = ArrayList<JSONObject>()
    private var answer: () -> Response = { Response(200, "{}") }
    private val clients = ArrayList<KmaClient>()
    private val logs = ArrayList<String>()

    private val transport = object : Transport {
        override fun post(url: String, key: String, body: String): Response {
            assertEquals("https://events.kissmyapps.dev/v1/events", url)
            assertEquals(KEY, key)
            sent.add(JSONObject(body))
            return answer()
        }
    }

    @Before
    fun setUp() {
        scheduler = ManualScheduler()
    }

    @After
    fun tearDown() {
        clients.forEach { it.shutdown() }
    }

    private fun start(
        store: Store?,
        options: KissMyAppsOptions = KissMyAppsOptions(appVersion = "2.4.0", build = "120"),
        key: String = KEY,
    ): KmaClient {
        val platform = Platform(store, transport, scheduler, { pixel }, "kma-android/1.0.0", { scheduler.now }, { logs.add(it) })
        return KmaClient(key, options, platform).also { clients.add(it) }
    }

    private fun settle(millis: Long = 0) {
        scheduler.advance(millis)
        scheduler.advance(300)
    }

    private fun events(bodies: List<JSONObject> = sent): List<JSONObject> =
        bodies.flatMap { body -> body.getJSONArray("events").let { array -> (0 until array.length()).map { array.getJSONObject(it) } } }

    private fun names(bodies: List<JSONObject> = sent) = events(bodies).map { it.getString("name") }

    @Test
    fun recordsTheInstallOpenScreensAndEventsAndSendsThemOnBackgrounding() {
        val client = start(MemoryStore())
        client.foreground()
        client.screen("Home", emptyMap())
        settle(1000)
        client.screen("Lesson", emptyMap())
        client.track("lesson_completed", mapOf("lesson" to 3))
        scheduler.advance(62_700)
        client.background()
        settle()

        assertEquals(
            listOf("session_started", "app_installed", "app_opened", "screen_viewed", "screen_viewed", "lesson_completed", "app_backgrounded"),
            names(),
        )
        val all = events()
        assertEquals("2.4.0", all[1].getJSONObject("properties").getString("version"))
        assertEquals("120", all[1].getJSONObject("properties").getString("build"))
        assertEquals(false, all[2].getJSONObject("properties").getBoolean("from_background"))
        assertEquals("Lesson", all[4].getString("screen"))
        assertEquals("Home", all[4].getJSONObject("properties").getString("previous"))
        assertEquals(3, all[5].getJSONObject("properties").getInt("lesson"))
        assertEquals("Lesson", all[5].getString("screen"))
        assertEquals(64, all[6].getJSONObject("properties").getInt("seconds_in_foreground"))
        for (body in sent) {
            expectContract(body)
            assertEquals(client.getSessionId(), body.getJSONObject("session").getString("id"))
            val context = body.getJSONObject("context")
            assertEquals("android", context.getString("platform"))
            assertEquals("kma-android/1.0.0", context.getString("sdk"))
            assertEquals("2.4.0", context.getString("app_version"))
            assertEquals("Home", context.getString("page_path"))
            assertEquals("Pixel 7", context.getString("device_model"))
        }
    }

    @Test
    fun tellsAnUpdateFromAnInstallAndKeepsThePersonAndARecentSession() {
        val store = MemoryStore()
        val first = start(store)
        first.foreground()
        settle()
        first.background()
        settle()
        val person = first.getAnonymousId()
        val session = first.getSessionId()
        first.shutdown()
        sent.clear()

        scheduler.advance(minutes(5))
        val second = start(store, KissMyAppsOptions(appVersion = "2.5.0", build = "130"))
        second.foreground()
        settle(10_000)
        assertEquals(listOf("app_updated", "app_opened"), names())
        val properties = events()[0].getJSONObject("properties")
        assertEquals("2.5.0", properties.getString("version"))
        assertEquals("130", properties.getString("build"))
        assertEquals("2.4.0", properties.getString("previous_version"))
        assertEquals("120", properties.getString("previous_build"))
        assertEquals(person, second.getAnonymousId())
        assertEquals(session, second.getSessionId())
    }

    @Test
    fun startsANewSessionAfter30MinutesAway() {
        val client = start(MemoryStore())
        client.foreground()
        settle()
        val first = client.getSessionId()
        client.background()
        settle()
        sent.clear()

        scheduler.advance(minutes(10))
        client.foreground()
        settle(10_000)
        assertEquals(listOf("app_opened"), names())
        assertEquals(true, events()[0].getJSONObject("properties").getBoolean("from_background"))
        assertEquals(first, client.getSessionId())
        client.background()
        settle()
        sent.clear()

        scheduler.advance(minutes(31))
        client.foreground()
        settle(10_000)
        assertEquals(listOf("session_started", "app_opened"), names())
        assertNotEquals(first, client.getSessionId())
    }

    @Test
    fun keepsEventsOfflineRetriesAndSendsThemOnALaterLaunch() {
        val store = MemoryStore()
        answer = { throw IOException("offline") }
        val client = start(store, KissMyAppsOptions(appVersion = "2.4.0", maxQueue = 4))
        client.foreground()
        for (lesson in 1..3) client.track("lesson_completed", mapOf("lesson" to lesson))
        client.background()
        settle(2000)
        assertTrue(sent.isNotEmpty())
        client.shutdown()

        // Only the newest four were kept.
        sent.clear()
        answer = { Response(200, "{}") }
        val later = start(store)
        settle(100)
        val delivered = events()
        assertEquals(listOf("lesson_completed", "lesson_completed", "lesson_completed", "app_backgrounded"), delivered.map { it.getString("name") })
        assertEquals(listOf(1, 2, 3, null), delivered.map { it.getJSONObject("properties").opt("lesson") })
        assertEquals(client.getAnonymousId(), later.getAnonymousId())
    }

    @Test
    fun dropsABatchTheServerRefusesButRetriesWhenItIsBusy() {
        val client = start(MemoryStore())
        answer = { Response(503, "busy") }
        client.foreground()
        settle(10_000)
        assertEquals(1, sent.size)
        answer = { Response(200, "{}") }
        settle(2000)
        assertEquals(2, sent.size)
        assertEquals(events(sent.subList(0, 1)).map { it.getString("insert_id") }, events(sent.subList(1, 2)).map { it.getString("insert_id") })

        answer = { Response(400, "bad") }
        client.track("broken_event", emptyMap())
        settle(10_000)
        answer = { Response(200, "{}") }
        settle(60_000)
        assertEquals(listOf("broken_event"), names(sent.subList(2, sent.size)))
    }

    @Test
    fun namesThePersonOnceIdentifiedAndStartsSomeoneNewOnReset() {
        val client = start(MemoryStore())
        client.foreground()
        client.identify("user-42", mapOf("email" to "amaka@example.com", "plan" to "annual"))
        settle()
        assertEquals("user-42", sent[0].getString("user_id"))
        assertEquals("amaka@example.com", sent[0].getJSONObject("traits").getString("email"))
        assertEquals("annual", sent[0].getJSONObject("traits").getString("plan"))
        client.track("plan_selected", emptyMap())
        settle(10_000)
        assertEquals("user-42", sent[1].getString("user_id"))
        assertTrue(!sent[1].has("traits"))

        val before = client.getAnonymousId()
        client.track("signed_out", emptyMap())
        client.reset()
        client.track("browsed", emptyMap())
        settle(10_000)
        val after = sent.subList(2, sent.size)
        assertEquals(before, after[0].getString("anonymous_id"))
        assertEquals("user-42", after[0].getString("user_id"))
        assertEquals(listOf("signed_out"), names(after.subList(0, 1)))
        assertNotEquals(before, after[1].getString("anonymous_id"))
        assertTrue(!after[1].has("user_id"))
        assertEquals(listOf("session_started", "browsed"), names(after.subList(1, 2)))
    }

    @Test
    fun staysQuietAfterOptingOutAcrossLaunchesUntilOptingIn() {
        val store = MemoryStore()
        val client = start(store)
        client.optOut()
        client.foreground()
        client.track("hidden", emptyMap())
        settle(10_000)
        assertEquals(0, sent.size)
        client.shutdown()

        val next = start(store)
        next.foreground()
        next.track("still_hidden", emptyMap())
        settle(10_000)
        assertEquals(0, sent.size)
        next.optIn()
        next.track("visible", emptyMap())
        settle(10_000)
        assertEquals(listOf("session_started", "visible"), names())
    }

    @Test
    fun keepsAnOpenAppOnlineWithAHeartbeat() {
        val client = start(MemoryStore())
        client.foreground()
        settle(10_000)
        sent.clear()
        // The minute after the last send passes with no request; the next one is a heartbeat.
        settle(50_000)
        assertEquals(0, sent.size)
        settle(60_000)
        assertEquals(1, sent.size)
        assertEquals(0, sent[0].getJSONArray("events").length())
        assertEquals(client.getSessionId(), sent[0].getJSONObject("session").getString("id"))
        client.background()
        settle()
        sent.clear()
        settle(120_000)
        assertEquals(0, sent.size)
    }

    @Test
    fun refusesAServerKeyAndIgnoresBadEventNames() {
        try {
            start(null, key = "kma_sk_live_ABCDEFGHJKLMNPQRSTUVWXYZ")
            fail("a server key was accepted")
        } catch (error: IllegalArgumentException) {
            assertTrue(error.message!!.contains("kma_pk_"))
        }
        val client = start(null, KissMyAppsOptions(trackLifecycle = false, debug = true))
        client.foreground()
        client.track("not valid!", emptyMap())
        client.track("valid_name", emptyMap())
        settle(10_000)
        assertEquals(listOf("session_started", "valid_name"), names())
        assertTrue(logs.any { it.contains("not a valid event name") })
    }

    @Test
    fun turnsAppValuesIntoJsonAndDropsOversizedProperties() {
        val client = start(MemoryStore(), KissMyAppsOptions(trackLifecycle = false, debug = true))
        client.foreground()
        client.track(
            "checkout",
            mapOf(
                "items" to listOf(mapOf("sku" to "A1", "price" to 9.99), mapOf("sku" to "B2", "price" to 5)),
                "at" to Date(0),
                "ratio" to Double.NaN,
                "coupon" to null,
                "big" to 12_000_000_000L,
            ),
        )
        client.track("too_big", mapOf("text" to "x".repeat(40_000)))
        settle(10_000)
        val properties = events()[1].getJSONObject("properties")
        assertEquals("B2", properties.getJSONArray("items").getJSONObject(1).getString("sku"))
        assertEquals(9.99, properties.getJSONArray("items").getJSONObject(0).getDouble("price"), 0.0)
        assertEquals("1970-01-01T00:00:00.000Z", properties.getString("at"))
        assertTrue(properties.isNull("ratio"))
        assertTrue(properties.isNull("coupon"))
        assertEquals(12_000_000_000L, properties.getLong("big"))
        assertEquals(0, events()[2].getJSONObject("properties").length())
        assertTrue(logs.any { it.contains("over 32 KB") })
    }

    @Test
    fun aFileStoreKeepsStateAcrossLaunches() {
        val directory = Files.createTempDirectory("kma").toFile()
        val first = start(FileStore(File(directory, "kissmyapps")))
        first.foreground()
        first.identify("user-7", null)
        first.background()
        settle()
        first.shutdown()

        val second = start(FileStore(File(directory, "kissmyapps")))
        assertEquals(first.getAnonymousId(), second.getAnonymousId())
        assertEquals("user-7", second.getUserId())
        assertNull(File(directory, "kissmyapps").listFiles()!!.firstOrNull { it.name.endsWith(".tmp") })
        directory.deleteRecursively()
    }
}
