package com.kissmyapps

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.IOException

private const val KEY = "kma_pk_live_ABCDEFGHJKLMNPQRSTUVWXYZ"
private const val ENDPOINT = "https://events.kissmyapps.dev"
private const val LINK = "https://fluent.go.kissmyapps.dev/lesson-4?dl=lesson&id=4"

private val attribution = JSONObject(File(System.getProperty("kma.contract")).readText()).getJSONObject("attribution")

private fun texts(array: JSONArray?): List<String> =
    if (array == null) emptyList() else (0 until array.length()).map { array.getString(it) }

/** The longest value a field takes, from the contract's "at most N characters". */
private fun mostCharacters(field: String): Int =
    Regex("at most (\\d+) characters").find(attribution.getJSONObject("fields").getString(field))!!.groupValues[1].toInt()

/** The rules of /v1/attribution/install and /v1/attribution/open, from the contract. */
internal fun expectAttributionContract(kind: String, body: JSONObject) {
    val rules = attribution.getJSONObject(kind)
    val fields = attribution.getJSONObject("fields")
    val required = texts(rules.getJSONArray("required"))
    val allowed = required + texts(rules.optJSONArray("optional"))
    for (field in required) assertTrue("$kind needs $field", body.has(field) && !body.isNull(field))
    for (field in body.keys()) assertTrue("$kind does not take $field", field in allowed)
    assertTrue(body.getString("platform") in texts(fields.getJSONArray("platform")))
    for (field in body.keys()) {
        val rule = fields.opt(field)
        if (rule is String && rule.startsWith("^")) assertTrue("$field: ${body.get(field)}", Regex(rule).matches(body.getString(field)))
    }
    for (field in listOf("anonymous_id", "session_id", "sdk", "user_id", "app_version", "link_url", "url", "referrer")) {
        if (body.has(field)) assertTrue("$field is text", body.get(field) is String)
    }
    for (field in listOf("link_url", "url")) {
        if (!body.has(field)) continue
        val link = body.getString(field)
        assertTrue("$field is https: $link", link.startsWith("https://"))
        assertTrue("$field is too long", link.length <= mostCharacters(field))
    }
    if (body.has("referrer")) assertTrue(body.getString("referrer").length <= mostCharacters("referrer"))
    for (field in listOf("referrer_click_ts", "install_begin_ts")) {
        if (!body.has(field)) continue
        val value = body.get(field)
        assertTrue("$field is whole seconds: $value", value is Int || value is Long)
        assertTrue("$field is a time", body.getLong(field) > 0)
    }
    if (body.getString("platform") == "android") {
        // Fields the contract keeps for iOS, such as the Apple Ads one, and the clipboard click.
        for (field in fields.keys()) {
            val rule = fields.opt(field)
            if (rule is String && rule.contains("iOS") && rule.contains("only")) assertFalse(field, body.has(field))
        }
        assertFalse(body.has("clipboard_click"))
    }
}

/** The answer's rules, from the contract. */
private fun expectAnswerContract(answer: JSONObject) {
    val rules = attribution.getJSONObject("response")
    for (field in texts(rules.getJSONArray("required"))) assertTrue(field, answer.has(field))
    for (field in answer.keys()) assertTrue(field, field in texts(rules.getJSONArray("required")) + texts(rules.getJSONArray("optional")))
    assertTrue(answer.getString("method") in texts(rules.getJSONArray("methods")))
    val deepLink = answer.optJSONObject("deep_link") ?: return
    for (field in texts(rules.getJSONObject("deep_link").getJSONArray("required"))) assertTrue(field, deepLink.has(field))
}

private val exampleInstall get() = attribution.getJSONObject("examples").getJSONObject("install")
private val exampleOpen get() = attribution.getJSONObject("examples").getJSONObject("open")
private val exampleAnswer get() = attribution.getJSONObject("examples").getJSONObject("response")

/** Google Play as the test wants it: answering at once, later, or never. */
private class FakePlay(
    var key: String? = deviceKeyFor("test"),
    var details: InstallReferrer? = InstallReferrer(
        "kma_lc=Q2xpY2tJZDAwMDAwMDAwMQ&utm_source=tiktok&utm_campaign=launch",
        1761818300,
        1761818320,
    ),
    var answers: Boolean = true,
) : AttributionSource {
    var reads = 0
    var waiting: ((InstallReferrer?) -> Unit)? = null

    override fun deviceKey() = key

    override fun installReferrer(done: (InstallReferrer?) -> Unit) {
        reads += 1
        if (answers) done(details) else waiting = done
    }
}

class AttributionTest {
    private lateinit var scheduler: ManualScheduler
    private val calls = ArrayList<Pair<String, JSONObject>>()
    private var installAnswer: () -> Response = { Response(200, ATTRIBUTION_OFF) }
    private var openAnswer: () -> Response = { Response(200, ATTRIBUTION_OFF) }
    private val clients = ArrayList<KmaClient>()
    private val logs = ArrayList<String>()
    private val onMain = ArrayList<() -> Unit>()
    private val delivered = ArrayList<DeepLink>()

    private val transport = object : Transport {
        override fun post(url: String, key: String, body: String): Response {
            assertEquals(KEY, key)
            val path = url.removePrefix(ENDPOINT)
            calls.add(path to JSONObject(body))
            return when (path) {
                "/v1/attribution/install" -> installAnswer()
                "/v1/attribution/open" -> openAnswer()
                "/v1/events" -> Response(200, "{}")
                else -> throw AssertionError("unexpected $url")
            }
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
        play: AttributionSource? = FakePlay(),
        options: KissMyAppsOptions = KissMyAppsOptions(appVersion = "2.4.0", build = "120"),
    ): KmaClient {
        val platform = Platform(
            store, transport, scheduler, { pixel }, "kma-android/$SDK_VERSION", { scheduler.now }, { logs.add(it) },
            attribution = play,
            main = { onMain.add(it) },
        )
        return KmaClient(KEY, options, platform).also { clients.add(it) }
    }

    /** Runs what the SDK posted to the main thread. */
    private fun runMain() {
        val tasks = ArrayList(onMain)
        onMain.clear()
        tasks.forEach { it() }
    }

    private fun relaunch(store: Store, play: AttributionSource? = FakePlay(), minutesLater: Int = 5): KmaClient {
        clients.forEach { it.shutdown() }
        scheduler.advance(minutesLater * 60_000L)
        return start(store, play)
    }

    private fun bodies(path: String) = calls.filter { it.first == path }.map { it.second }
    private fun installs() = bodies("/v1/attribution/install")
    private fun opens() = bodies("/v1/attribution/open")

    private fun answer(deepLink: JSONObject?, method: String = "link_open") =
        Response(200, JSONObject().put("matched", true).put("method", method).put("deep_link", deepLink ?: JSONObject.NULL).toString())

    @Test
    fun theContractsExamplesPassTheseChecks() {
        expectAttributionContract("install", exampleInstall)
        expectAttributionContract("open", exampleOpen)
        expectAnswerContract(exampleAnswer)
        // The iOS-only check above has something to hold Android bodies to.
        val fields = attribution.getJSONObject("fields")
        assertTrue(fields.keys().asSequence().any { (fields.opt(it) as? String)?.let { rule -> rule.contains("iOS") && rule.contains("only") } == true })
    }

    @Test
    fun buildsTheContractsInstallExampleFromPlaysInstallReferrer() {
        val example = exampleInstall
        val details = InstallReferrer(
            referrer = "kma_lc=Q2xpY2tJZDAwMDAwMDAwMQ&utm_source=tiktok&utm_campaign=launch",
            referrerClickTimestampSeconds = 1761818300,
            installBeginTimestampSeconds = 1761818320,
        )
        val body = installBody(
            anonymousId = example.getString("anonymous_id"),
            sessionId = example.getString("session_id"),
            platform = "android",
            installedAt = example.getString("installed_at"),
            sdk = "kma-android/$SDK_VERSION",
            appVersion = "2.4.0",
            deviceKey = deviceKeyFor("test"),
            referrer = details,
        )
        assertTrue("$body\n$example", JSONObject(body.toString()).similar(example))
        expectAttributionContract("install", body)
    }

    @Test
    fun leavesOutWhatPlayDoesNotKnowAndKeepsTheReferrerShort() {
        fun build(details: InstallReferrer?) = installBody("a", "s", "android", "2026-10-30T09:59:00.010Z", "kma-android/1.1.0", referrer = details)
        val unknown = build(InstallReferrer("utm_source=google-play&utm_medium=organic", 0, 0))
        assertEquals("utm_source=google-play&utm_medium=organic", unknown.getString("referrer"))
        assertFalse(unknown.has("referrer_click_ts"))
        assertFalse(unknown.has("install_begin_ts"))
        val empty = build(InstallReferrer("", 0, 1761818320))
        assertFalse(empty.has("referrer"))
        assertEquals(1761818320L, empty.getLong("install_begin_ts"))
        val long = build(InstallReferrer("kma_lc=Q2xpY2tJZDAwMDAwMDAwMQ&x=" + "y".repeat(2000), 1, 2))
        assertEquals(mostCharacters("referrer"), long.getString("referrer").length)
        assertFalse(build(null).has("referrer"))
        // A link or device key outside the rules is left out rather than refused by the server.
        val odd = installBody("a", "s", "android", "2026-10-30T09:59:00.010Z", "kma-android/1.1.0", deviceKey = "ABC", linkUrl = "http://x.test/a")
        assertFalse(odd.has("device_key"))
        assertFalse(odd.has("link_url"))
    }

    @Test
    fun theDeviceKeyIsTheSha256OfTheIdNeverTheIdItself() {
        assertEquals(exampleInstall.getString("device_key"), deviceKeyFor("test"))
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", deviceKeyFor("abc"))
        assertNull(deviceKeyFor(null))
        assertNull(deviceKeyFor(" "))
        assertNull(deviceKeyFor("9774d56d682e549c"))
    }

    @Test
    fun readsTheContractsAnswer() {
        val answer = parseAttributionAnswer(exampleAnswer.toString())!!
        assertTrue(answer.matched)
        assertEquals("install_referrer", answer.method)
        assertEquals("tiktok", answer.source)
        assertEquals("launch", answer.campaign)
        assertNull(answer.channel)
        assertFalse(answer.reinstall)
        assertEquals(DeepLink("lesson", mapOf("id" to "4"), deferred = true, url = null), answer.deepLink)

        val off = parseAttributionAnswer(ATTRIBUTION_OFF)!!
        assertFalse(off.matched)
        assertEquals("off", off.method)
        assertNull(off.deepLink)
        for (method in texts(attribution.getJSONObject("response").getJSONArray("methods"))) {
            assertEquals(method, parseAttributionAnswer("""{"matched":false,"method":"$method","deep_link":null}""")!!.method)
        }
        val params = JSONObject()
        for (index in 1..12) params.put("k%02d".format(index), index)
        val many = parseAttributionAnswer(answer(JSONObject().put("value", JSONObject.NULL).put("params", params).put("deferred", false)).text, LINK)!!
        assertNull(many.deepLink!!.value)
        assertEquals(10, many.deepLink!!.params.size)
        assertEquals("1", many.deepLink!!.params["k01"])
        assertEquals(LINK, many.deepLink!!.url)
        assertNull(parseAttributionAnswer("not json"))
        assertNull(parseAttributionAnswer("""{"matched":true}"""))
    }

    @Test
    fun takesOnlyHttpsLinks() {
        val client = start(MemoryStore())
        assertTrue(client.handleDeepLink(LINK))
        assertTrue(client.handleDeepLink("HTTPS://fluent.go.kissmyapps.dev/a"))
        assertFalse(client.handleDeepLink("http://fluent.go.kissmyapps.dev/a"))
        assertFalse(client.handleDeepLink("fluent://lesson/4"))
        assertFalse(client.handleDeepLink("https://"))
        assertFalse(client.handleDeepLink("https:///path"))
        assertFalse(client.handleDeepLink("https://fluent.go.kissmyapps.dev/" + "a".repeat(mostCharacters("url"))))
    }

    @Test
    fun callsInstallOnceOnTheFirstLaunchAfterAppInstalledIsQueued() {
        val store = MemoryStore()
        val play = FakePlay()
        val client = start(store, play)
        client.foreground()
        scheduler.advance(10_300)

        assertEquals(1, installs().size)
        val body = installs()[0]
        expectAttributionContract("install", body)
        assertEquals(client.getAnonymousId(), body.getString("anonymous_id"))
        assertEquals(client.getSessionId(), body.getString("session_id"))
        assertEquals("android", body.getString("platform"))
        assertEquals("2026-10-30T09:59:00.000Z", body.getString("installed_at"))
        assertEquals("kma-android/1.1.0", body.getString("sdk"))
        assertEquals("2.4.0", body.getString("app_version"))
        assertEquals(deviceKeyFor("test"), body.getString("device_key"))
        assertEquals(exampleInstall.getString("referrer"), body.getString("referrer"))
        assertEquals(1761818300L, body.getLong("referrer_click_ts"))
        assertEquals(1761818320L, body.getLong("install_begin_ts"))
        assertFalse(body.has("link_url"))
        assertFalse(body.has("user_id"))
        // app_installed went into the same session.
        val installed = bodies("/v1/events").first { it.toString().contains("app_installed") }
        assertEquals(body.getString("session_id"), installed.getJSONObject("session").getString("id"))

        // Done is remembered: later launches never call again, nor read the referrer again.
        val next = relaunch(store, play)
        next.foreground()
        scheduler.advance(10_300)
        assertEquals(1, installs().size)
        assertEquals(1, play.reads)
    }

    @Test
    fun anAppUpdatedFromAnEarlierSdkVersionIsNotANewInstall() {
        val store = MemoryStore()
        val first = start(store)
        first.foreground()
        scheduler.advance(300)
        // 1.0.0 kept no attribution state.
        store.data.keys.filter { it.endsWith("-attribution") }.forEach { store.data.remove(it) }
        calls.clear()
        val next = relaunch(store)
        next.foreground()
        scheduler.advance(10_300)
        assertEquals(0, installs().size)
    }

    @Test
    fun handsTheDeferredDeepLinkOverOnceOnTheMainThreadAndHoldsItUntilAListenerIsSet() {
        installAnswer = { Response(200, exampleAnswer.toString()) }
        val client = start(MemoryStore())
        client.foreground()
        scheduler.advance(300)
        runMain()
        assertEquals(0, delivered.size)

        client.onDeepLink { delivered.add(it) }
        assertEquals(0, delivered.size) // not before the main thread runs it
        runMain()
        assertEquals(listOf(DeepLink("lesson", mapOf("id" to "4"), deferred = true, url = null)), delivered)

        // Once: a second listener does not get it again.
        val later = ArrayList<DeepLink>()
        client.onDeepLink { later.add(it) }
        runMain()
        assertEquals(0, later.size)
    }

    @Test
    fun aListenerSetBeforeTheAnswerGetsTheDeepLinkAsItArrives() {
        installAnswer = { Response(200, exampleAnswer.toString()) }
        val client = start(MemoryStore())
        client.onDeepLink { delivered.add(it) }
        client.foreground()
        scheduler.advance(300)
        runMain()
        assertEquals(1, delivered.size)
        assertTrue(delivered[0].deferred)
    }

    @Test
    fun theLinkThatOpensTheFirstLaunchGoesWithTheInstallCallAndLaterLinksAreOpens() {
        installAnswer = { answer(JSONObject().put("value", "lesson").put("params", JSONObject().put("id", "4")).put("deferred", true)) }
        openAnswer = { answer(JSONObject().put("value", "offer").put("params", JSONObject()).put("deferred", false)) }
        val client = start(MemoryStore())
        client.onDeepLink { delivered.add(it) }
        // Activity.onCreate runs before onStart.
        assertTrue(client.handleDeepLink(LINK))
        client.foreground()
        scheduler.advance(300)
        runMain()
        assertEquals(1, installs().size)
        assertEquals(0, opens().size)
        assertEquals(LINK, installs()[0].getString("link_url"))
        expectAttributionContract("install", installs()[0])
        assertEquals(listOf(DeepLink("lesson", mapOf("id" to "4"), deferred = true, url = LINK)), delivered)

        // onNewIntent, a minute later.
        scheduler.advance(60_000)
        val offer = "https://fluent.go.kissmyapps.dev/spring?src=newsletter"
        assertTrue(client.handleDeepLink(offer))
        runMain()
        assertEquals(1, opens().size)
        val open = opens()[0]
        expectAttributionContract("open", open)
        assertEquals(offer, open.getString("url"))
        assertEquals("2026-10-30T10:00:00.300Z", open.getString("opened_at"))
        assertEquals(client.getSessionId(), open.getString("session_id"))
        assertEquals(deviceKeyFor("test"), open.getString("device_key"))
        assertEquals(DeepLink("offer", emptyMap(), deferred = false, url = offer), delivered[1])
    }

    @Test
    fun aLinkOnALaterLaunchIsSentAsAnOpenWithTheUser() {
        val store = MemoryStore()
        val first = start(store)
        first.foreground()
        first.identify("user-42", null)
        scheduler.advance(10_300)
        val next = relaunch(store)
        assertTrue(next.handleDeepLink(LINK))
        next.foreground()
        scheduler.advance(300)
        assertEquals(1, installs().size)
        assertEquals(1, opens().size)
        assertEquals("user-42", opens()[0].getString("user_id"))
        expectAttributionContract("open", opens()[0])
    }

    @Test
    fun triesTheInstallCallAgainOnTheNextThreeLaunchesThenGivesUp() {
        val store = MemoryStore()
        val play = FakePlay()
        installAnswer = { throw IOException("offline") }
        val first = start(store, play)
        assertTrue(first.handleDeepLink(LINK))
        first.foreground()
        scheduler.advance(10_300)
        val person = first.getAnonymousId()
        val session = first.getSessionId()
        assertEquals(1, installs().size)

        for (launch in 2..4) {
            // A server error counts as a failure too.
            installAnswer = if (launch == 3) ({ Response(503, "busy") }) else ({ throw IOException("offline") })
            val next = relaunch(store, play, minutesLater = 60)
            next.foreground()
            scheduler.advance(10_300)
            assertEquals(launch, installs().size)
        }
        val tries = installs()
        for (body in tries) {
            // Each try is the first launch's install: same person, session, time, link and referrer.
            assertEquals(person, body.getString("anonymous_id"))
            assertEquals(session, body.getString("session_id"))
            assertEquals("2026-10-30T09:59:00.000Z", body.getString("installed_at"))
            assertEquals(LINK, body.getString("link_url"))
            assertEquals(exampleInstall.getString("referrer"), body.getString("referrer"))
            expectAttributionContract("install", body)
        }
        assertEquals(1, play.reads)

        val fifth = relaunch(store, play)
        fifth.foreground()
        scheduler.advance(10_300)
        assertEquals(4, installs().size)
    }

    @Test
    fun aLinkOnARetryLaunchWaitsForTheInstallCall() {
        val store = MemoryStore()
        installAnswer = { throw IOException("offline") }
        val first = start(store)
        first.foreground()
        scheduler.advance(300)
        installAnswer = { Response(200, ATTRIBUTION_OFF) }
        val next = relaunch(store)
        assertTrue(next.handleDeepLink(LINK))
        next.foreground()
        scheduler.advance(300)
        val order = calls.map { it.first }.filter { it.startsWith("/v1/attribution/") }
        assertEquals(listOf("/v1/attribution/install", "/v1/attribution/install", "/v1/attribution/open"), order)
        assertFalse(installs()[1].has("link_url"))
    }

    @Test
    fun anInstallCallTheServerRefusesIsNotTriedAgain() {
        val store = MemoryStore()
        installAnswer = { Response(400, """{"error":"invalid_body"}""") }
        val first = start(store, options = KissMyAppsOptions(appVersion = "2.4.0", debug = true))
        first.foreground()
        scheduler.advance(300)
        assertTrue(logs.any { it.contains("refused (400)") })
        val next = relaunch(store)
        next.foreground()
        scheduler.advance(10_300)
        assertEquals(1, installs().size)
    }

    @Test
    fun waitsTenSecondsForTheReferrerThenSendsWithoutIt() {
        val store = MemoryStore()
        val play = FakePlay(answers = false)
        val client = start(store, play)
        client.foreground()
        scheduler.advance(9_000)
        assertEquals(0, installs().size)
        scheduler.advance(1_000)
        assertEquals(1, installs().size)
        assertFalse(installs()[0].has("referrer"))
        assertFalse(installs()[0].has("install_begin_ts"))
        // A late answer changes nothing.
        play.waiting!!(play.details)
        scheduler.advance(300)
        assertEquals(1, installs().size)
    }

    @Test
    fun aReferrerThatAnswersLaterIsSentWhenItArrives() {
        val play = FakePlay(answers = false)
        val client = start(MemoryStore(), play)
        client.foreground()
        scheduler.advance(2_000)
        assertEquals(0, installs().size)
        play.waiting!!(play.details)
        assertEquals(1, installs().size)
        assertEquals(exampleInstall.getString("referrer"), installs()[0].getString("referrer"))
        scheduler.advance(20_000)
        assertEquals(1, installs().size)
    }

    @Test
    fun noReferrerOrDeviceKeyStillSendsTheInstall() {
        // Play's FEATURE_NOT_SUPPORTED or SERVICE_UNAVAILABLE, on a phone without an ID.
        val client = start(MemoryStore(), FakePlay(key = null, details = null))
        client.foreground()
        scheduler.advance(300)
        assertEquals(1, installs().size)
        val body = installs()[0]
        expectAttributionContract("install", body)
        for (field in listOf("device_key", "referrer", "referrer_click_ts", "install_begin_ts")) assertFalse(field, body.has(field))
    }

    @Test
    fun theInstallCallDoesNotDependOnLifecycleEvents() {
        val client = start(MemoryStore(), options = KissMyAppsOptions(trackLifecycle = false))
        client.foreground()
        scheduler.advance(300)
        assertEquals(1, installs().size)
        assertFalse(installs()[0].has("app_version"))
    }

    @Test
    fun sendsNothingWhileOptedOutAndTheInstallOnceOptedIn() {
        val store = MemoryStore()
        val client = start(store)
        client.optOut()
        assertTrue(client.handleDeepLink(LINK))
        client.foreground()
        scheduler.advance(10_300)
        assertTrue(client.handleDeepLink(LINK))
        scheduler.advance(300)
        assertEquals(0, calls.size)

        client.optIn()
        scheduler.advance(300)
        assertEquals(1, installs().size)
        assertEquals(0, opens().size)
        expectAttributionContract("install", installs()[0])
        assertNotNull(client.getSessionId())
        assertEquals(client.getSessionId(), installs()[0].getString("session_id"))
    }

    @Test
    fun anOpenThatFailsOrIsRefusedDeliversNothing() {
        val store = MemoryStore()
        val client = start(store)
        client.onDeepLink { delivered.add(it) }
        client.foreground()
        scheduler.advance(300)
        openAnswer = { throw IOException("offline") }
        client.handleDeepLink(LINK)
        openAnswer = { Response(401, "revoked") }
        client.handleDeepLink(LINK)
        openAnswer = { Response(200, "<html>") }
        client.handleDeepLink(LINK)
        runMain()
        assertEquals(3, opens().size)
        assertEquals(0, delivered.size)
    }
}
