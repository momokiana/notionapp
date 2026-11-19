package dev.notifier.xiaoaixiaoai.bridge

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.math.sqrt

private const val TAG = "PocketVoice"
private const val MIC_RATE = 16_000
private const val SPEAKER_RATE = 48_000
private const val SPEAKER_PER_MS = SPEAKER_RATE / 1000
/** 20 ms of 16 kHz mono PCM16. */
private const val MIC_FRAME_BYTES = 640
/** From Android 12 the track starts once this much is written; before, only once its whole buffer is full. */
private const val START_THRESHOLD_MS = 40
/** A track that holds audio but has not moved for this long is waiting to be filled: top it up with silence. */
private const val STUCK_MS = 150L
/** How often the play thread looks again when it has nothing to write. */
private const val PLAY_LOOP_MS = 5L

/**
 * One voice call to the relay's /v1/assistant/live. Audio never passes through
 * JavaScript: the microphone goes straight to the socket, speech straight to the
 * speaker, and playback receipts follow what was actually heard (MOSS-Live
 * playback.* events). JS only gets the text events for captions and state.
 */
class VoiceCall(
  private val ctx: Context,
  private val server: String,
  private val token: String,
  private val onEnded: () -> Unit,
) {
  companion object {
    @Volatile var current: VoiceCall? = null
  }

  private data class Ref(val chunkId: String, val runId: String, val turnId: String)
  private class Chunk(val ref: Ref, val pcm: ByteArray, override val frames: Int, val level: Float) : Playout.Piece {
    override val run: String get() = ref.runId
  }
  private class Scope {
    var turnId = ""
    var finished = false
    var drained = false
    var stopped = false
    var outstanding = 0
    var playedMs = 0.0
  }

  private val client = OkHttpClient.Builder()
    .pingInterval(20, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.MILLISECONDS)
    .connectTimeout(15, TimeUnit.SECONDS)
    .build()
  private var ws: WebSocket? = null
  private val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var focus: AudioFocusRequest? = null
  private var prevMode = AudioManager.MODE_NORMAL
  private var record: AudioRecord? = null
  private var track: AudioTrack? = null
  private val effects = mutableListOf<android.media.audiofx.AudioEffect>()

  @Volatile private var ended = false
  @Volatile private var ready = false
  @Volatile var muted = false
    private set
  @Volatile private var micLevel = 0f

  // Playback ledger; guarded by `lock`.
  private val lock = Any()
  private val contexts = ArrayDeque<Ref>()
  /** Audio received and not yet written to the track: the jitter buffer. */
  private val playout = Playout<Chunk>(SPEAKER_PER_MS)
  /** Chunks written to the track, with the frame position their end reaches. */
  private val inflight = ArrayDeque<Pair<Chunk, Long>>()
  /** Frames written to the track since it was last flushed, silence included. */
  private var written = 0L
  /** Bumped by a flush: the play thread drops what it was writing and primes the track again. */
  private var generation = 0
  /** Replies the service stopped (response.audio.stop), for the call's stats. */
  private var stops = 0
  private val scopes = HashMap<String, Scope>()
  private val stoppedRuns = HashSet<String>()

  private val threads = mutableListOf<Thread>()

  fun start() {
    current = this
    XiaoaiBus.emit("onCall", mapOf("state" to "connecting"))
    try {
      openAudio()
    } catch (e: Throwable) {
      Log.w(TAG, "audio", e)
      end("打不开麦克风：${e.message ?: "未知原因"}")
      return
    }
    // The token rides in a header: a URL ends up in reverse-proxy access logs.
    val req = Request.Builder().url(wsUrl(server, "/v1/assistant/live")).header("Authorization", "Bearer $token").build()
    ws = client.newWebSocket(req, Listener())
    thread("pocket-mic") { micLoop() }
    thread("pocket-play") { playLoop() }
    thread("pocket-ack") { ackLoop() }
  }

  private fun thread(name: String, body: () -> Unit) {
    val t = Thread({
      try {
        body()
      } catch (e: Throwable) {
        if (!ended) Log.w(TAG, name, e)
      }
    }, name)
    t.isDaemon = true
    threads.add(t)
    t.start()
  }

  // ----------------------------------------------------------------------- audio setup

  private fun openAudio() {
    prevMode = am.mode
    val attrs = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(attrs).build()
      am.requestAudioFocus(focus!!)
    }
    am.mode = AudioManager.MODE_IN_COMMUNICATION
    routeOutput()

    val minIn = AudioRecord.getMinBufferSize(MIC_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    @Suppress("MissingPermission")
    val rec = AudioRecord(
      MediaRecorder.AudioSource.VOICE_COMMUNICATION,
      MIC_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
      // Room for half a second: a busy phone must not lose the person's words.
      maxOf(minIn * 2, MIC_FRAME_BYTES * 25),
    )
    if (rec.state != AudioRecord.STATE_INITIALIZED) {
      rec.release()
      throw IllegalStateException("没有麦克风权限")
    }
    // Hear the person, not our own voice coming out of the speaker.
    if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(rec.audioSessionId)?.let { it.enabled = true; effects.add(it) }
    if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(rec.audioSessionId)?.let { it.enabled = true; effects.add(it) }
    if (AutomaticGainControl.isAvailable()) AutomaticGainControl.create(rec.audioSessionId)?.let { it.enabled = true; effects.add(it) }
    record = rec

    val minOut = AudioTrack.getMinBufferSize(SPEAKER_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
    val tr = AudioTrack.Builder()
      .setAudioAttributes(attrs)
      .setAudioFormat(
        AudioFormat.Builder()
          .setSampleRate(SPEAKER_RATE)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .build(),
      )
      .setTransferMode(AudioTrack.MODE_STREAM)
      .setBufferSizeInBytes(maxOf(minOut, SPEAKER_RATE * 2 / 5))
      .build()
    // The jitter buffer decides when speech starts; the track should not wait for a full buffer on top of it.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      try { tr.setStartThresholdInFrames(START_THRESHOLD_MS * SPEAKER_PER_MS) } catch (_: Throwable) {}
    }
    track = tr
    rec.startRecording()
    tr.play()
  }

  /** Headset when one is plugged in, otherwise the loudspeaker (a hands-free call). */
  private fun routeOutput() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val devices = am.availableCommunicationDevices
      val headset = devices.firstOrNull {
        it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET ||
          it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET || it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
          it.type == AudioDeviceInfo.TYPE_USB_HEADSET
      }
      val target = headset ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
      if (target != null) am.setCommunicationDevice(target)
    } else {
      @Suppress("DEPRECATION")
      am.isSpeakerphoneOn = !am.isWiredHeadsetOn && !am.isBluetoothScoOn
    }
  }

  private fun closeAudio() {
    try { record?.stop() } catch (_: Throwable) {}
    try { record?.release() } catch (_: Throwable) {}
    for (e in effects) try { e.release() } catch (_: Throwable) {}
    effects.clear()
    try { track?.pause(); track?.flush() } catch (_: Throwable) {}
    try { track?.release() } catch (_: Throwable) {}
    record = null
    track = null
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice()
      else {
        @Suppress("DEPRECATION")
        am.isSpeakerphoneOn = false
      }
      am.mode = prevMode
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) focus?.let { am.abandonAudioFocusRequest(it) }
    } catch (_: Throwable) {}
  }

  // ----------------------------------------------------------------------- loops

  private fun micLoop() {
    Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
    val rec = record ?: return
    val frame = ByteArray(MIC_FRAME_BYTES)
    val silence = ByteArray(MIC_FRAME_BYTES)
    while (!ended) {
      var off = 0
      while (off < frame.size && !ended) {
        val n = rec.read(frame, off, frame.size - off)
        if (n <= 0) {
          if (n < 0) return
          continue
        }
        off += n
      }
      micLevel = if (muted) 0f else rms(frame, frame.size)
      // Silence keeps flowing while muted: the model expects a continuous realtime stream.
      if (ready) ws?.send((if (muted) silence else frame).toByteString(0, frame.size))
    }
  }

  /** Frames the track has played since it was last flushed. */
  private fun head(tr: AudioTrack): Long = try { tr.playbackHeadPosition.toLong() and 0xFFFFFFFFL } catch (_: Throwable) { written }

  /** What the track needs before it plays: since Android 12 the threshold set above, before that its whole buffer. */
  private fun startFrames(tr: AudioTrack): Long = try {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) tr.startThresholdInFrames.toLong() else tr.bufferSizeInFrames.toLong()
  } catch (_: Throwable) {
    (SPEAKER_RATE / 5).toLong()
  }

  /** Writes up to [frames] of silence without blocking; returns what went in. */
  private fun writeSilence(tr: AudioTrack, silence: ByteArray, frames: Long): Long {
    var left = frames
    while (left > 0) {
      val n = tr.write(silence, 0, minOf(silence.size.toLong(), left * 2).toInt(), AudioTrack.WRITE_NON_BLOCKING)
      if (n <= 0) break
      written += n / 2
      left -= n / 2
    }
    return frames - left
  }

  /**
   * Feeds the speaker. The jitter buffer (Playout) says when a reply has enough
   * audio in to start, and when one that ran dry may go on. A track that ran dry
   * plays again only once it holds its start threshold: 40 ms from Android 12
   * (set in openAudio), the whole buffer before; there a little silence keeps it
   * running between replies.
   */
  private fun playLoop() {
    Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
    val tr = track ?: return
    val silence = ByteArray(SPEAKER_PER_MS * 2 * 20)
    var cur: Chunk? = null
    var off = 0
    var gen = -1
    var lastHead = -1L
    var headSince = 0L
    // Silence between replies only where a dry track waits for its whole buffer (see Playout.LEAD_MS).
    val leadFrames = if (startFrames(tr) >= tr.bufferSizeInFrames) Playout.LEAD_MS.toLong() * SPEAKER_PER_MS else 0L
    while (!ended) {
      val now = SystemClock.elapsedRealtime()
      synchronized(lock) {
        val head = head(tr)
        if (gen != generation) {
          // Started or flushed: an empty track only plays once it holds its start threshold.
          gen = generation
          cur = null
          off = 0
          writeSilence(tr, silence, startFrames(tr))
        }
        if (head != lastHead) {
          lastHead = head
          headSince = now
        } else if (cur == null && written - head > 0 && now - headSince >= STUCK_MS) {
          // Holding audio but not moving: some devices want more than the threshold; give it silence.
          writeSilence(tr, silence, tr.bufferSizeInFrames.toLong())
          headSince = now
        }
        while (!ended) {
          if (cur == null) {
            // Speech still in the track: the end of the last chunk written, if it has not been played yet.
            val audio = maxOf(0L, (inflight.lastOrNull()?.second ?: 0L) - head)
            val next = playout.take(now, audio) ?: break
            if (stoppedRuns.contains(next.ref.runId)) continue
            inflight.addLast(next to (written + next.frames))
            written += next.frames
            cur = next
            off = 0
          }
          val c = cur!!
          val n = tr.write(c.pcm, off, c.pcm.size - off, AudioTrack.WRITE_NON_BLOCKING)
          if (n < 0) {
            // Counted as written above; the rest never went in.
            written -= (c.pcm.size - off) / 2
            cur = null
            break
          }
          off += n
          if (off < c.pcm.size) break
          cur = null
        }
        // Nothing to write now: before Android 12, keep a little silence queued so the track keeps running.
        if (cur == null && written - head < leadFrames) writeSilence(tr, silence, leadFrames - (written - head))
      }
      Thread.sleep(PLAY_LOOP_MS)
    }
  }

  /** Acknowledges chunks once the speaker has really played them, and reports levels for the UI. */
  private fun ackLoop() {
    var lastLevel = 0L
    while (!ended) {
      Thread.sleep(20)
      val tr = track ?: continue
      val out = mutableListOf<JSONObject>()
      var outLevel = 0f
      synchronized(lock) {
        val head = head(tr)
        while (inflight.isNotEmpty() && inflight.first().second <= head) acked(inflight.removeFirst().first, out)
        inflight.firstOrNull()?.let { outLevel = it.first.level }
      }
      for (m in out) ws?.send(m.toString())
      val now = System.currentTimeMillis()
      if (now - lastLevel >= 100) {
        lastLevel = now
        XiaoaiBus.emit("onLevel", mapOf("mic" to micLevel.toDouble(), "out" to outLevel.toDouble()))
      }
    }
  }

  /** A chunk the speaker has played in full: its receipt, and the reply's when it was the last. Under `lock`. */
  private fun acked(chunk: Chunk, out: MutableList<JSONObject>) {
    out.add(JSONObject().put("action", "playback.chunk.completed").put("chunk_id", chunk.ref.chunkId).put("run_id", chunk.ref.runId).put("turn_id", chunk.ref.turnId))
    val s = scope(chunk.ref.runId, chunk.ref.turnId)
    s.playedMs += chunk.frames * 1000.0 / SPEAKER_RATE
    if (s.outstanding > 0) s.outstanding--
    drained(chunk.ref.runId, s)?.let { out.add(it) }
  }

  private fun scope(runId: String, turnId: String): Scope {
    val s = scopes.getOrPut(runId) { Scope() }
    if (turnId.isNotEmpty()) s.turnId = turnId
    return s
  }

  private fun drained(runId: String, s: Scope): JSONObject? {
    if (!s.finished || s.drained || s.stopped || s.outstanding > 0) return null
    s.drained = true
    return JSONObject().put("action", "playback.completed").put("run_id", runId).put("turn_id", s.turnId)
  }

  /** The model was interrupted: stop its speech now and report how much was heard. */
  private fun stopRun(runId: String, turnId: String, reason: String) {
    val out = mutableListOf<JSONObject>()
    synchronized(lock) {
      stoppedRuns.add(runId)
      stops++
      playout.drop(runId)
      val s = scope(runId, turnId)
      // Stopped, not completed: no playback.completed for it from the receipts below.
      s.stopped = true
      val tr = track
      if (inflight.any { it.first.ref.runId == runId } && tr != null) {
        val head = head(tr)
        // Chunks heard in full get their receipts first (MOSS-Live asks for that order), then the part of the current one.
        val back = mutableListOf<Chunk>()
        for ((c, end) in inflight) {
          val start = end - c.frames
          when {
            end <= head -> acked(c, out)
            c.ref.runId == runId -> if (head > start) s.playedMs += (head - start) * 1000.0 / SPEAKER_RATE
            // Another reply's audio in the track: it goes back to be played after the flush.
            else -> back.add(c)
          }
        }
        try {
          tr.pause()
          tr.flush()
          tr.play()
        } catch (_: Throwable) {}
        inflight.clear()
        playout.requeue(back)
        generation++
        written = head(tr)
      }
      s.outstanding = 0
      s.finished = true
      s.stopped = true
      s.drained = true
      // All of the reply that was heard; the relay turns it into what each service expects.
      out.add(
        JSONObject().put("action", "playback.stopped").put("run_id", runId).put("turn_id", s.turnId)
          .put("played_audio_ms", s.playedMs.toLong()).put("reason", reason),
      )
      s.playedMs = 0.0
    }
    for (m in out) ws?.send(m.toString())
  }

  // ----------------------------------------------------------------------- socket

  private inner class Listener : WebSocketListener() {
    override fun onMessage(webSocket: WebSocket, text: String) {
      if (ended) return
      val o = try { JSONObject(text) } catch (_: Throwable) { return }
      val action = o.optString("action")
      val d = o.optJSONObject("data") ?: JSONObject()
      when (action) {
        "relay.state" -> {
          when (d.optString("state")) {
            "ready" -> {
              ready = true
              webSocket.send(JSONObject().put("action", "mic_state").put("enabled", !muted).toString())
              XiaoaiBus.emit("onCall", mapOf("state" to "ready"))
            }
            "error", "closed" -> {
              end(d.optString("message").ifEmpty { "通话结束了" })
              return
            }
          }
        }
        "response.audio.context" -> synchronized(lock) {
          contexts.addLast(Ref(d.optString("chunk_id"), d.optString("run_id"), d.optString("turn_id")))
          if (contexts.size > 512) contexts.removeFirst()
        }
        "response.audio.started" -> synchronized(lock) {
          val run = d.optString("run_id")
          if (!stoppedRuns.contains(run)) {
            val s = scope(run, d.optString("turn_id"))
            s.finished = false; s.drained = false; s.stopped = false; s.playedMs = 0.0
          }
        }
        "response.audio.done" -> {
          val m = synchronized(lock) {
            val run = d.optString("run_id")
            if (stoppedRuns.contains(run)) null
            else {
              // A short reply that is all in plays at once, without waiting for the cushion.
              playout.finish(run)
              scope(run, d.optString("turn_id")).let { s -> s.finished = true; drained(run, s) }
            }
          }
          m?.let { webSocket.send(it.toString()) }
        }
        "response.audio.stop" -> stopRun(d.optString("run_id"), d.optString("turn_id"), d.optString("reason").ifEmpty { "interrupted" })
      }
      // Captions and state for the UI; audio contexts are only plumbing.
      if (action != "response.audio.context") XiaoaiBus.emit("onCallEvent", mapOf("json" to text))
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      if (ended) return
      val pcm = bytes.toByteArray()
      synchronized(lock) {
        val ref = contexts.removeFirstOrNull() ?: return
        if (stoppedRuns.contains(ref.runId)) return
        scope(ref.runId, ref.turnId).outstanding++
        playout.push(Chunk(ref, pcm, pcm.size / 2, rms(pcm, pcm.size)), SystemClock.elapsedRealtime())
      }
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      val why = when (response?.code) {
        401 -> "授权失效，请重新配对"
        403 -> "只有手机可以打语音"
        503 -> "服务器还没开语音功能"
        else -> "连接断了"
      }
      end(why)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      end("通话结束了")
    }
  }

  // ----------------------------------------------------------------------- controls

  fun setMuted(value: Boolean) {
    muted = value
    if (ready) ws?.send(JSONObject().put("action", "mic_state").put("enabled", !value).toString())
    XiaoaiBus.emit("onCall", mapOf("state" to "ready", "muted" to value))
  }

  fun hangup() {
    try { ws?.send(JSONObject().put("action", "relay.hangup").toString()) } catch (_: Throwable) {}
    end("挂断了")
  }

  /** Mid-reply stalls of the jitter buffer, its cushion, AudioTrack underruns (silence ones too) and stopped replies. */
  private fun stats(): JSONObject = synchronized(lock) {
    val underruns = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) track?.underrunCount ?: -1 else -1
    JSONObject().put("action", "call.stats").put(
      "data",
      JSONObject().put("stalls", playout.stalls).put("target_ms", playout.targetMs.toLong())
        .put("max_target_ms", playout.maxTargetMs.toLong()).put("underruns", underruns).put("stops", stops),
    )
  }

  @Synchronized
  fun end(message: String) {
    if (ended) return
    ended = true
    ready = false
    if (current === this) current = null
    try { ws?.close(1000, "bye") } catch (_: Throwable) {}
    // How the speaker did, for the app's log: what a real call leaves to look at afterwards.
    val stats = try { stats() } catch (_: Throwable) { null }
    closeAudio()
    client.dispatcher.executorService.shutdown()
    stats?.let {
      Log.i(TAG, it.toString())
      XiaoaiBus.emit("onCallEvent", mapOf("json" to it.toString()))
    }
    XiaoaiBus.emit("onCall", mapOf("state" to "ended", "message" to message))
    onEnded()
  }
}

private fun rms(pcm: ByteArray, len: Int): Float {
  var sum = 0.0
  var n = 0
  var i = 0
  while (i + 1 < len) {
    val s = ((pcm[i + 1].toInt() shl 8) or (pcm[i].toInt() and 0xFF)).toShort().toInt()
    sum += (s * s).toDouble()
    n++
    i += 2
  }
  if (n == 0) return 0f
  return minOf(1f, (sqrt(sum / n) / 32768.0 * 4).toFloat())
}
