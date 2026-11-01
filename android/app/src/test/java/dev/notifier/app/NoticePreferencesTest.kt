package dev.notifier.app

import java.io.IOException
import java.nio.file.Files
import java.time.*
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.crypto.KeyGenerator
import org.junit.Assert.*
import org.junit.Test

class NoticePreferencesTest {
    private val ns = "a".repeat(64)
    private val other = "b".repeat(64)
    private val payload = PushEnvelope("event", 1, "delivery", "c".repeat(64))
    private val event = Event("event", "PRIVATE TITLE", "PRIVATE BODY", "source", 1, 0, disposition = "open", expires_at = "2099-01-01T00:00:00Z", updated_at = "2026-01-01T00:00:00Z")
    private class Disk : PushVault {
        val file = Files.createTempFile("notice-policy-push-", ".json").toFile().apply { deleteOnExit() }
        init { save(PushDatabase()) }
        override fun load() = wire.decodeFromString<PushDatabase>(file.readText())
        override fun save(state: PushDatabase) { file.writeText(wire.encodeToString(PushDatabase.serializer(), state)) }
    }
    private class Preferences(var value: NoticePreferences = NoticePreferences()) : NoticeVault {
        override fun load() = value
        override fun save(value: NoticePreferences) { value.validate(); this.value = value }
    }
    private fun fails(action: () -> Unit) { try { action(); fail("must reject") } catch (_: Exception) {} }
    @Test fun oldInstallDefaultsToSecretNoNewDndAndNoSourceRules() {
        val decoded = wire.decodeFromString<NoticePreferences>("{}")
        assertEquals("secret", decoded.lock_screen); assertTrue(decoded.enabled); assertFalse(decoded.quiet_enabled); assertTrue(decoded.muted_sources.isEmpty())
        assertNull(decoded.suppression(ns, "source", LocalTime.MIDNIGHT))
        fails { decoded.copy(lock_screen = "private_body_preview").validate() }
    }
    @Test fun localWindowBoundariesWrapAndDisabledBehavior() {
        val day = NoticePreferences(quiet_enabled = true, quiet_start = 9 * 60, quiet_end = 17 * 60)
        assertNull(day.suppression(ns, "source", LocalTime.of(8, 59)))
        assertEquals("quiet_hours", day.suppression(ns, "source", LocalTime.of(9, 0)))
        assertEquals("quiet_hours", day.suppression(ns, "source", LocalTime.of(16, 59)))
        assertNull(day.suppression(ns, "source", LocalTime.of(17, 0)))
        val night = NoticePreferences(quiet_enabled = true)
        listOf(LocalTime.of(22, 0), LocalTime.of(23, 59), LocalTime.MIDNIGHT, LocalTime.of(7, 59)).forEach { assertEquals("quiet_hours", night.suppression(ns, "source", it)) }
        assertNull(night.suppression(ns, "source", LocalTime.of(8, 0)))
        assertNull(night.copy(quiet_enabled = false).suppression(ns, "source", LocalTime.MIDNIGHT))
        fails { night.copy(quiet_start = 60, quiet_end = 60).validate() }
    }
    @Test fun currentTimezoneAndDstAreNotCachedOffsets() {
        val old = TimeZone.getDefault()
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
            val minute = LocalTime.now().hour * 60 + LocalTime.now().minute
            val policy = NoticePreferences(quiet_enabled = true, quiet_start = (minute + 1435) % 1440, quiet_end = (minute + 5) % 1440)
            assertEquals("quiet_hours", policy.suppression(ns, "source"))
            TimeZone.setDefault(TimeZone.getTimeZone("Asia/Tokyo")); assertNull(policy.suppression(ns, "source"))
        } finally { TimeZone.setDefault(old) }
        val zone = ZoneId.of("America/New_York")
        val policy = NoticePreferences(quiet_enabled = true, quiet_start = 90, quiet_end = 210)
        fun reason(instant: String) = policy.suppression(ns, "source", Instant.parse(instant).atZone(zone).toLocalTime())
        assertEquals("quiet_hours", reason("2026-03-08T06:59:00Z"))
        assertEquals("quiet_hours", reason("2026-03-08T07:01:00Z"))
        assertNull(reason("2026-03-08T07:31:00Z"))
        assertEquals("quiet_hours", reason("2026-11-01T05:45:00Z")); assertEquals("quiet_hours", reason("2026-11-01T06:45:00Z"))
    }
    @Test fun strictTimesSourceScopeAndBounds() {
        assertEquals(0, NoticePreferences.parseTime("00:00")); assertEquals(1439, NoticePreferences.parseTime("23:59"))
        listOf("24:00", "9:00", "12:60", "00:00 ", "-1:00", "12;00").forEach { fails { NoticePreferences.parseTime(it) } }
        val p = NoticePreferences(muted_sources = mapOf(ns to setOf("source")))
        assertEquals("source_muted", p.suppression(ns, "source")); assertNull(p.suppression(other, "source")); assertNull(p.suppression(ns, "Source"))
        assertEquals("app_disabled", p.copy(enabled = false).suppression(other, "other"))
        fails { p.copy(muted_sources = mapOf(ns to (1..201).map { "s$it" }.toSet())).validate() }
        fails { p.copy(muted_sources = mapOf("bad" to setOf("source"))).validate() }
        fails { p.copy(muted_sources = mapOf(ns to setOf("../source"))).validate() }
    }
    @Test fun cipherRoundTripTamperWrongKeyAndUnknownFormatRefuse() {
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val p = NoticePreferences(lock_screen = "generic", quiet_enabled = true, muted_sources = mapOf(ns to setOf("source")))
        val bytes = NoticeCipher.encode(p, key); assertEquals(p, NoticeCipher.decode(bytes, key))
        assertFalse(bytes.toString(Charsets.ISO_8859_1).contains("source"))
        val bad = bytes.clone(); bad[bad.lastIndex] = (bad.last().toInt() xor 1).toByte(); fails { NoticeCipher.decode(bad, key) }
        fails { NoticeCipher.decode(bytes, KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()) }
        fails { NoticeCipher.decode(ByteArray(NoticeCipher.LIMIT + 1), key) }
        fails { NoticeCipher.encode(p.copy(format = 2), key) }
    }
    @Test fun explicitSuppressionDurableWithoutPostedAndNeverReplaysAfterReenable() {
        val disk = Disk(); val r = PushRecords(disk, ns); val prefs = Preferences(NoticePreferences(enabled = false)); var posts = 0
        r.received(payload)
        val result = postWithNoticePreferences(prefs, r, ns, payload, event, { true }) { posts++ }
        assertFalse(result.posted); assertFalse(result.posting_unknown); assertEquals("app_disabled", result.suppression)
        assertEquals(1L, result.suppressed_at_version); assertEquals(0, posts)
        prefs.value = NoticePreferences(lock_screen = "generic")
        val reopened = PushRecords(disk, ns)
        postWithNoticePreferences(prefs, reopened, ns, payload, event, { true }) { posts++ }
        val duplicate = payload.copy(delivery_id = "new_duplicate")
        reopened.received(duplicate); postWithNoticePreferences(prefs, reopened, ns, duplicate, event, { true }) { posts++ }
        assertEquals(0, posts)
        val next = payload.copy(delivery_id = "next_round", event_version = 2)
        reopened.received(next); postWithNoticePreferences(prefs, reopened, ns, next, event.copy(event_version = 2), { true }) { assertEquals("generic", it.lock_screen); posts++ }
        assertEquals(1, posts); assertTrue(reopened.snapshot().deliveries[next.delivery_id]!!.posted)
    }
    @Test fun sourceAndQuietMutesLeaveOnlyReceiptAndNextVersionStillWorks() {
        listOf(NoticePreferences(muted_sources = mapOf(ns to setOf("source"))), NoticePreferences(quiet_enabled = true)).forEach { p ->
            val r = PushRecords(Disk(), ns); r.received(payload); var posts = 0; val prefs = Preferences(p)
            val obs = postWithNoticePreferences(prefs, r, ns, payload, event, { true }, { LocalTime.MIDNIGHT }) { posts++ }
            assertNotNull(obs.suppression); assertFalse(obs.posted); assertEquals(0, posts)
            prefs.value = NoticePreferences()
            postWithNoticePreferences(prefs, r, ns, payload, event, { true }, { LocalTime.NOON }) { posts++ }
            assertEquals(0, posts)
        }
    }
    @Test fun policyReadFailureOrSuppressionSaveFailureNeverCallsNotify() {
        var posts = 0
        val disk = Disk(); val r = PushRecords(disk, ns); r.received(payload); val original = disk.file.readBytes()
        val unreadable = object : NoticeVault { override fun load(): NoticePreferences = throw IOException("bad preferences"); override fun save(value: NoticePreferences) = error("no write") }
        fails { postWithNoticePreferences(unreadable, r, ns, payload, event, { true }) { posts++ } }
        assertArrayEquals(original, disk.file.readBytes())
        val full = object : PushVault { override fun load() = disk.load(); override fun save(state: PushDatabase) = throw IOException("disk full") }
        fails { postWithNoticePreferences(Preferences(NoticePreferences(enabled = false)), PushRecords(full, ns), ns, payload, event, { true }) { posts++ } }
        assertEquals(0, posts); assertArrayEquals(original, disk.file.readBytes())
    }
    @Test fun systemDenialIsNotPolicySuppressionAndUnknownOsEffectRemainsUnknown() {
        val r = PushRecords(Disk(), ns); r.received(payload); val prefs = Preferences(); var posts = 0
        assertFalse(postWithNoticePreferences(prefs, r, ns, payload, event, { false }) { posts++ }.posted)
        assertNull(r.snapshot().deliveries[payload.delivery_id]!!.suppression)
        fails { postWithNoticePreferences(prefs, r, ns, payload, event, { true }) { posts++; throw IOException("OS unknown") } }
        prefs.value = NoticePreferences(enabled = false)
        val unknown = postWithNoticePreferences(prefs, r, ns, payload, event, { true }) { posts++ }
        assertTrue(unknown.posting_unknown); assertNull(unknown.suppression); assertFalse(unknown.posted); assertEquals(1, posts)
    }
    @Test fun localDiagnosticsBindOriginalVersionAndSeparateSuppressionUnknownAndPosted() {
        val delivery = NotificationDelivery(payload.delivery_id, 1, "platform_accepted")
        val muted = DeviceObservation(payload, suppression = "quiet_hours", suppressed_at_version = 2)
        val label = localNoticeStatus(event.id, delivery, muted)!!
        assertTrue(label.contains("原投递 v1")); assertTrue(label.contains("静默时段")); assertTrue(label.contains("事件v2")); assertTrue(label.contains("不代表事件从未提醒"))
        assertNull(localNoticeStatus("other", delivery, muted)); assertNull(localNoticeStatus(event.id, delivery.copy(version = 2), muted))
        assertTrue(localNoticeStatus(event.id, delivery, muted.copy(posting_unknown = true))!!.contains("效果未知"))
        assertTrue(localNoticeStatus(event.id, delivery, muted.copy(suppression = null, posted = true))!!.contains("不证明用户看见或听见"))
    }
    @Test fun preferenceCommitWaitsForInFlightNotifyBoundary() {
        val prefs = Preferences(); val r = PushRecords(Disk(), ns); r.received(payload)
        val notifying = CountDownLatch(1); val release = CountDownLatch(1); val committed = CountDownLatch(1); val failure = AtomicReference<Throwable?>()
        val post = kotlin.concurrent.thread { try { postWithNoticePreferences(prefs, r, ns, payload, event, { true }) { notifying.countDown(); check(release.await(5, TimeUnit.SECONDS)) } } catch (e: Throwable) { failure.set(e) } }
        assertTrue(notifying.await(3, TimeUnit.SECONDS))
        val save = kotlin.concurrent.thread { synchronized(NoticeGate.monitor) { prefs.save(NoticePreferences(enabled = false)); committed.countDown() } }
        try { assertFalse(committed.await(200, TimeUnit.MILLISECONDS)) } finally { release.countDown() }
        post.join(3000); save.join(3000); assertNull(failure.get()); assertFalse(post.isAlive); assertFalse(save.isAlive); assertFalse(prefs.value.enabled)
    }
}
