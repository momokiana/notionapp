package dev.notifier.app

import java.io.IOException
import java.nio.file.Files
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ResponseDraftsTest {
    private val c = Connection.parse("https://drafts.example.test", "a".repeat(64), false)
    private val expected = ConnectionSnapshot(c.namespace)
    private val e = Event("event", "问题🙂", "当前正文", "source", 1, 1,
        Interaction("q", 1, listOf(Action("reply", "文字", "text"), Action("go", "继续", "button"))),
        disposition = "open", expires_at = "2099-01-01T00:00:00Z", updated_at = "2026-01-01T00:00:00Z", can_respond = true)
    private class Disk(initial: LocalState) : StateStore {
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val file = Files.createTempFile("draft-state-", ".enc").toFile().apply { deleteOnExit() }
        var writes = 0; var failAt = -1
        init { file.writeBytes(LocalStateCipher.encrypt(initial, key)) }
        override fun load() = LocalStateCipher.decrypt(file.readBytes(), key)
        override fun save(state: LocalState) { val bytes = LocalStateCipher.encrypt(state, key); writes++; if (writes == failAt) throw IOException("synthetic atomic failure"); file.writeBytes(bytes) }
    }
    private inner class Fixture {
        val disk = Disk(LocalState(c)); var latest = e; var posts = 0; var gets = 0
        var postFailure: Exception? = null; var duringGet: (() -> Unit)? = null
        var recorded: Pending? = null
        val transport = object : Transport {
            override fun call(connection: Connection, method: String, path: String, body: String?): String {
                if (method == "GET") {
                    gets++; duringGet?.invoke()
                    if (path.startsWith("/v1/responses/")) return """{"id":"${recorded!!.id}","event_id":"event"}"""
                    return wire.encodeToString(Event.serializer(), latest)
                }
                posts++; val state = disk.load(); recorded = state.pending
                assertTrue(recorded!!.uncertain); assertTrue(state.drafts.none { it.id == recorded!!.draft?.id })
                assertEquals(recorded!!.body, body); postFailure?.let { throw it }
                return """{"response_id":"${recorded!!.id}"}"""
            }
        }
        val ledger = Ledger(disk, transport)
        val book = ResponseDrafts(disk, ledger) { "2026-11-01T00:00:00Z" }
        fun draft(text: String = "  原文\n🙂  ") = book.create(e, e.interaction!!.actions[0], text, expected)
        fun prepare(d: ResponseDraft) = book.prepare(d, expected)
    }
    private fun fails(block: () -> Unit) { try { block(); fail("expected refusal") } catch (e: AssertionError) { throw e } catch (_: Exception) {} }
    @Test fun oldCipherDefaultFieldsAndUnicodeReopenCompatibility() {
        val f = Fixture(); val old = """{"connection":{"base":"${c.base}","token":"${c.token}"},"pending":null}"""
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, f.disk.key) }
        val legacy = cipher.iv + cipher.doFinal(old.toByteArray())
        assertTrue(LocalStateCipher.decrypt(legacy, f.disk.key).drafts.isEmpty())
        val draft = f.draft(); assertEquals(draft, f.disk.load().drafts.single()); assertEquals(0, f.gets + f.posts)
        assertFalse(f.disk.file.readBytes().toString(Charsets.ISO_8859_1).contains("原文"))
        f.book.edit(draft, "🙂".repeat(4000), expected); assertEquals(4000, f.disk.load().drafts.single().text.codePointCount(0, 8000))
    }
    @Test fun localEditingTemplatesAndAppendNeverWriteHttpOrChangeOriginalBinding() {
        val f = Fixture(); val d = f.draft()
        f.book.template(null, "简短回应", "收到🙂", expected)
        val t = f.disk.load().templates.single(); assertEquals("原字\n收到🙂", appendReplyText("原字", t.text))
        f.book.edit(d, appendReplyText(d.text, t.text), expected)
        val changed = f.disk.load().drafts.single(); assertEquals(d.event_version, changed.event_version); assertEquals(d.action, changed.action)
        f.book.template(t, "修改", "另一文字", expected); f.book.deleteTemplate(f.disk.load().templates.single(), expected)
        assertTrue(f.disk.load().templates.isEmpty()); f.book.delete(changed, expected); assertTrue(f.disk.load().drafts.isEmpty()); assertEquals(0, f.gets + f.posts)
        fails { appendReplyText("a".repeat(4000), "more") }
    }
    @Test fun namespaceSwitchAndDisconnectKeepButDoNotExposeOrMutateOriginalDrafts() {
        val f = Fixture(); val d = f.draft(); f.book.template(null, "回复", "保留", expected)
        f.ledger.connect(c.copy(token = "b".repeat(64)))
        assertEquals(listOf(d), f.disk.load().drafts)
        fails { f.book.edit(d, "迟到", expected) }; fails { f.prepare(d) }
        f.ledger.disconnect(); assertEquals(listOf(d), f.disk.load().drafts); assertEquals(1, f.disk.load().templates.size)
        val isolated = f.disk.load().drafts
        fails { f.book.deleteIsolated(ConnectionSnapshot(null), emptyList()) }
        f.book.deleteIsolated(ConnectionSnapshot(null), isolated); assertTrue(f.disk.load().drafts.isEmpty()); assertEquals(0, f.posts)
    }
    @Test fun staleDraftEditsAndDeletesRefuseInsteadOfClobberingNewText() {
        val f = Fixture(); val old = f.draft(); f.book.edit(old, "new", expected)
        fails { f.book.delete(old, expected) }; fails { f.book.edit(old, "old", expected) }
        assertEquals("new", f.disk.load().drafts.single().text)
    }
    @Test fun quantityAndCipherByteBoundsTamperWrongKeyAndDiskFailurePreserveBytes() {
        val f = Fixture(); val d = f.draft(); val original = f.disk.file.readBytes()
        fails { f.book.create(e, e.interaction!!.actions[0], "🙂".repeat(4001), expected) }
        fails { f.book.create(e, e.interaction!!.actions[1], "button must be empty", expected) }
        fails { f.disk.save(f.disk.load().copy(drafts = List(9) { d.copy(id = "d$it") })) }
        fails { f.disk.save(f.disk.load().copy(templates = List(13) { ReplyTemplate("t$it", "title", "text") })) }
        fails { f.disk.save(f.disk.load().copy(drafts = List(8) { d.copy(id = "d$it", text = "🙂".repeat(4000)) }, templates = List(12) { ReplyTemplate("t$it", "title", "🙂".repeat(1000)) })) }
        assertArrayEquals(original, f.disk.file.readBytes())
        f.disk.failAt = f.disk.writes + 1; fails { f.book.edit(d, "modified", expected) }; assertArrayEquals(original, f.disk.file.readBytes())
        val bad = original.clone(); bad[bad.lastIndex] = (bad.last().toInt() xor 1).toByte(); fails { LocalStateCipher.decrypt(bad, f.disk.key) }
        fails { LocalStateCipher.decrypt(original, KeyGenerator.getInstance("AES").generateKey()) }
        fails { LocalStateCipher.decrypt(ByteArray(MAX_LOCAL_STATE_BYTES + 1), f.disk.key) }
    }
    @Test fun localOperationsPreservePendingAndAuthIntentExactly() {
        val f = Fixture(); val p = Pending(c.namespace, "original", "/v1/events/event/responses", "original-body", true, true)
        val auth = AuthIntent("rotate", "rotation", c.base, "body", prior = c)
        f.disk.save(f.disk.load().copy(pending = p, auth_intent = auth))
        val d = f.draft(); f.book.template(null, "Title", "Body", expected); f.book.edit(d, "Changed", expected)
        assertEquals(p, f.disk.load().pending); assertEquals(auth, f.disk.load().auth_intent)
        fails { f.prepare(f.disk.load().drafts.single()) }; assertEquals(0, f.posts)
    }
    @Test fun prepareIsGetOnlyAllowsProgressButRefusesChangedQuestionSourceAndQualification() {
        val f = Fixture(); val d = f.draft(); f.latest = e.copy(event_version = 2, body = "进展后的当前正文")
        val confirmation = f.prepare(d); assertEquals(2L, confirmation.current.event_version); assertEquals(d, confirmation.draft); assertEquals(0, f.posts)
        val wrong = listOf(e.copy(id = "other"), e.copy(source_id = "other"), e.copy(event_version = 0), e.copy(interaction = e.interaction!!.copy(id = "new")),
            e.copy(interaction = e.interaction!!.copy(version = 2)), e.copy(interaction = e.interaction!!.copy(actions = listOf(Action("reply", "changed label", "text")))),
            e.copy(can_respond = false), e.copy(reserved_response_id = "already"), e.copy(disposition = "completed"), e.copy(expires_at = "2000-01-01T00:00:00Z"))
        wrong.forEach { f.latest = it; fails { f.prepare(d) }; assertEquals(listOf(d), f.disk.load().drafts); assertNull(f.disk.load().pending) }
        assertEquals(0, f.posts)
    }
    @Test fun finalGetChangedOrCancelledPreviewNeverPostsOrRemovesDraft() {
        val f = Fixture(); val d = f.draft(); val confirmation = f.prepare(d)
        f.latest = e.copy(event_version = 2); fails { f.ledger.submitDraft(confirmation, expected) }
        f.latest = e; fails { f.ledger.submitDraft(confirmation, expected) { false } }
        val gate = DraftReviewGate(); val ticket = gate.ticket(); f.duringGet = { gate.invalidate() }
        fails { f.ledger.submitDraft(confirmation, expected) { gate.accepts(ticket) } }
        assertEquals(0, f.posts); assertEquals(listOf(d), f.disk.load().drafts)
    }
    @Test fun lateGetCannotResurrectInvalidatedReviewAndEditedOriginalCannotSubmit() {
        val f = Fixture(); val d = f.draft(); val gate = DraftReviewGate(); val ticket = gate.ticket()
        f.duringGet = { gate.invalidate() }; f.prepare(d); assertFalse(gate.accepts(ticket)); assertEquals(0, f.posts)
        f.duringGet = null; val confirmation = f.prepare(d); f.book.edit(d, "replacement", expected)
        fails { f.ledger.submitDraft(confirmation, expected) }; assertEquals("replacement", f.disk.load().drafts.single().text)
    }
    @Test fun confirmedTransferIsAtomicAndSuccessfulAckDoesNotResurrectDraft() {
        val f = Fixture(); val d = f.draft(); f.ledger.submitDraft(f.prepare(d), expected)
        assertEquals(1, f.posts); assertNotNull(f.recorded!!.draft); assertEquals(d, f.recorded!!.draft)
        assertNull(f.disk.load().pending); assertTrue(f.disk.load().drafts.isEmpty())
        fails { f.ledger.submitDraft(DraftConfirmation(d, e), expected) }; assertEquals(1, f.posts)
    }
    @Test fun failuresAtTransferUncertaintyAndAckClearingKeepExactlyOneRecoverableRecord() {
        for (stage in 1..3) {
            val f = Fixture(); val d = f.draft(); val confirmation = f.prepare(d); f.disk.failAt = f.disk.writes + stage
            fails { f.ledger.submitDraft(confirmation, expected) }
            if (stage == 1) { assertEquals(listOf(d), f.disk.load().drafts); assertNull(f.disk.load().pending); assertEquals(0, f.posts) }
            else {
                assertTrue(f.disk.load().drafts.isEmpty()); assertEquals(d, f.disk.load().pending!!.draft); assertEquals(if (stage == 2) 0 else 1, f.posts)
                f.recorded = f.disk.load().pending; val original = f.recorded!!; f.disk.failAt = -1
                val recovery = object : Transport {
                    override fun call(connection: Connection, method: String, path: String, body: String?): String {
                        if (stage == 2 && method == "GET" && path.startsWith("/v1/responses/")) throw ApiFailure(404, "NOT_FOUND")
                        if (method == "POST") { assertEquals(original.body, body); assertEquals(original.path, path) }
                        return f.transport.call(connection, method, path, body)
                    }
                }
                Ledger(f.disk, recovery).recover(); assertNull(f.disk.load().pending); assertTrue(f.disk.load().drafts.isEmpty()); assertEquals(1, f.posts)
            }
        }
    }
    @Test fun committedLostAckReopensSamePendingAndOnlyExplicitRecoveryResolves() {
        val f = Fixture(); val d = f.draft(); f.postFailure = IOException("lost committed ACK")
        fails { f.ledger.submitDraft(f.prepare(d), expected) }; val pending = f.disk.load().pending!!
        assertTrue(pending.uncertain); assertEquals(d, pending.draft); assertTrue(f.disk.load().drafts.isEmpty())
        assertEquals(1, f.posts); f.postFailure = null
        Ledger(f.disk, f.transport).recover(expected, pending.id)
        assertEquals(1, f.posts); assertNull(f.disk.load().pending); assertTrue(f.disk.load().drafts.isEmpty())
    }
    @Test fun firstKnownRefusalRestoresOriginalDraftButUnknownOrRestoreFailureDoesNot() {
        val f = Fixture(); val d = f.draft(); f.postFailure = ApiFailure(409, "EVENT_VERSION_CONFLICT")
        fails { f.ledger.submitDraft(f.prepare(d), expected) }; assertEquals(listOf(d), f.disk.load().drafts); assertNull(f.disk.load().pending)
        val g = Fixture(); val gd = g.draft(); val confirm = g.prepare(gd)
        g.postFailure = ApiFailure(410, "ACTION_EXPIRED"); g.disk.failAt = g.disk.writes + 3
        fails { g.ledger.submitDraft(confirm, expected) }; assertTrue(g.disk.load().drafts.isEmpty()); assertNotNull(g.disk.load().pending)
        val pending = g.disk.load().pending!!; g.disk.failAt = -1
        val refusing = object : Transport { override fun call(connection: Connection, method: String, path: String, body: String?): String { throw ApiFailure(if (method == "GET") 404 else 409, "EVENT_VERSION_CONFLICT") } }
        fails { Ledger(g.disk, refusing).recover(expected, pending.id) }; assertEquals(pending, g.disk.load().pending); assertTrue(g.disk.load().drafts.isEmpty())
    }
    @Test fun pendingRecoveryMaterialReservesDraftCapacityAndCannotBecomeAnotherLocalDraft() {
        val f = Fixture(); val d = f.draft(); f.postFailure = IOException("unknown")
        fails { f.ledger.submitDraft(f.prepare(d), expected) }
        repeat(7) { f.draft("local $it") }; fails { f.draft("one too many") }
        val old = f.disk.load(); fails { f.disk.save(old.copy(drafts = old.drafts + d)) }; assertEquals(old, f.disk.load())
    }
    @Test fun finalReadFailureAndIdentityOrNamespaceChangesKeepDraftAndNeverPost() {
        val f = Fixture(); val d = f.draft(); val confirmation = f.prepare(d)
        f.duringGet = { throw ApiFailure(401, "UNAUTHENTICATED") }; fails { f.ledger.submitDraft(confirmation, expected) }
        f.duringGet = null; f.ledger.connect(c.copy(token = "b".repeat(64))); fails { f.ledger.submitDraft(confirmation, expected) }
        assertEquals(0, f.posts); assertEquals(listOf(d), f.disk.load().drafts)
    }
    @Test fun twoLedgerOwnersCannotCreateTwoWritesFromOneConfirmedDraft() {
        val f = Fixture(); val d = f.draft(); val confirm = f.prepare(d)
        val errors = java.util.concurrent.CopyOnWriteArrayList<Exception>()
        val threads = List(2) { kotlin.concurrent.thread { try { Ledger(f.disk, f.transport).submitDraft(confirm, expected) } catch (e: Exception) { errors += e } } }
        threads.forEach { it.join(5000); assertFalse(it.isAlive) }
        assertEquals(1, f.posts); assertEquals(1, errors.size); assertTrue(f.disk.load().drafts.isEmpty())
    }
}
