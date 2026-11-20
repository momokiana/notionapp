package dev.notifier.xiaoaixiaoai.bridge

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AudioEffect
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import java.io.ByteArrayOutputStream
import kotlin.math.sqrt

private const val CV_TAG = "PocketChatVoice"
private const val MIC_RATE = 16_000
private const val MIC_FRAME_BYTES = 640 // 20 ms at 16 kHz mono PCM16LE
private const val MAX_REC_BYTES = MIC_RATE * 2 * 60 // 60 s cap

/**
 * Push-to-talk microphone capture and normal-chat streaming TTS playback
 * independent of live voice calls (`VoiceCall`).
 */
internal object ChatVoice {
  // -------------------------------------------------------------------------
  // Push-to-Talk Recorder (16 kHz mono PCM16LE)
  // -------------------------------------------------------------------------

  private val recLock = Object()
  @Volatile private var recActive = false
  private var recRecord: AudioRecord? = null
  private var recThread: Thread? = null
  private var recOut: ByteArrayOutputStream? = null
  private var recFocus: AudioFocusRequest? = null
  private var recAm: AudioManager? = null
  private val recEffects = mutableListOf<AudioEffect>()

  fun startRecording(ctx: Context) {
    if (VoiceCall.current != null) throw IllegalStateException("通话中不能录语音消息")
    stopSpeech(null)
    cancelRecording()

    val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val attrs = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()
    var focusReq: AudioFocusRequest? = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusReq = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
        .setAudioAttributes(attrs)
        .build()
      am.requestAudioFocus(focusReq)
    }

    val minBuf = AudioRecord.getMinBufferSize(MIC_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    @Suppress("MissingPermission")
    val rec = AudioRecord(
      MediaRecorder.AudioSource.MIC,
      MIC_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
      maxOf(minBuf * 2, MIC_FRAME_BYTES * 25),
    )
    if (rec.state != AudioRecord.STATE_INITIALIZED) {
      try { rec.release() } catch (_: Throwable) {}
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusReq != null) {
        try { am.abandonAudioFocusRequest(focusReq) } catch (_: Throwable) {}
      }
      throw IllegalStateException("没有麦克风权限或麦克风被占用")
    }

    val localEffects = mutableListOf<AudioEffect>()
    if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(rec.audioSessionId)?.let { it.enabled = true; localEffects.add(it) }
    if (AutomaticGainControl.isAvailable()) AutomaticGainControl.create(rec.audioSessionId)?.let { it.enabled = true; localEffects.add(it) }

    val out = ByteArrayOutputStream()
    val thread = Thread({
      val buf = ByteArray(MIC_FRAME_BYTES)
      var tick = 0
      try {
        while (recActive) {
          val n = rec.read(buf, 0, buf.size)
          if (n <= 0) {
            if (n < 0) break
            continue
          }
          synchronized(recLock) {
            if (out.size() + n <= MAX_REC_BYTES) out.write(buf, 0, n)
          }
          tick++
          if (tick % 4 == 0) {
            val level = pcmLevel(buf, n)
            XiaoaiBus.emit("onPttLevel", mapOf("level" to level.toDouble()))
          }
        }
      } catch (e: Throwable) {
        if (recActive) Log.w(CV_TAG, "ptt read", e)
      }
    }, "pocket-ptt-mic")
    thread.isDaemon = true

    synchronized(recLock) {
      recActive = true
      recRecord = rec
      recOut = out
      recFocus = focusReq
      recAm = am
      recEffects.clear()
      recEffects.addAll(localEffects)
      recThread = thread
    }
    rec.startRecording()
    thread.start()
  }

  fun stopRecording(): Map<String, Any> {
    val rec: AudioRecord?
    val thread: Thread?
    val out: ByteArrayOutputStream?
    val am: AudioManager?
    val focusReq: AudioFocusRequest?
    val effects: List<AudioEffect>

    synchronized(recLock) {
      recActive = false
      rec = recRecord
      thread = recThread
      out = recOut
      am = recAm
      focusReq = recFocus
      effects = recEffects.toList()
      recRecord = null
      recThread = null
      recOut = null
      recAm = null
      recFocus = null
      recEffects.clear()
    }

    try { rec?.stop() } catch (_: Throwable) {}
    try { thread?.join(400) } catch (_: Throwable) {}
    try { rec?.release() } catch (_: Throwable) {}
    for (e in effects) try { e.release() } catch (_: Throwable) {}
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusReq != null && am != null) {
      try { am.abandonAudioFocusRequest(focusReq) } catch (_: Throwable) {}
    }
    XiaoaiBus.emit("onPttLevel", mapOf("level" to 0.0))

    val bytes = if (out != null) synchronized(recLock) { out.toByteArray() } else ByteArray(0)
    val durationMs = (bytes.size.toLong() * 1000L / (MIC_RATE * 2L)).toInt()
    val b64 = if (bytes.isNotEmpty()) Base64.encodeToString(bytes, Base64.NO_WRAP) else ""
    return mapOf("audioBase64" to b64, "sampleRate" to MIC_RATE, "durationMs" to durationMs)
  }

  fun cancelRecording() {
    val hadActive: Boolean
    synchronized(recLock) {
      hadActive = recActive || recRecord != null
    }
    if (!hadActive) return
    stopRecording()
  }

  private fun pcmLevel(buf: ByteArray, len: Int): Float {
    val samples = len / 2
    if (samples <= 0) return 0f
    var sum = 0.0
    var i = 0
    while (i + 1 < len) {
      val s = ((buf[i + 1].toInt() shl 8) or (buf[i].toInt() and 0xFF)).toShort() / 32768.0
      sum += s * s
      i += 2
    }
    return minOf(1f, (sqrt(sum / samples) * 4.5).toFloat())
  }

  // -------------------------------------------------------------------------
  // Streaming Chat TTS Player (48 kHz mono PCM16LE)
  // -------------------------------------------------------------------------

  private val playLock = Object()
  private var playGen = 0
  private var playId: String? = null
  private var playRate = 48_000
  private val playQueue = ArrayDeque<ByteArray>()
  private var playInputDone = false
  private var playTrack: AudioTrack? = null
  private var playFocus: AudioFocusRequest? = null
  private var playAm: AudioManager? = null

  fun startSpeech(ctx: Context, utteranceId: String, sampleRate: Int) {
    if (VoiceCall.current != null) return
    synchronized(playLock) {
      startSpeechLocked(ctx.applicationContext, utteranceId, sampleRate)
    }
  }

  fun feedSpeech(ctx: Context, utteranceId: String, pcmBase64: String) {
    if (VoiceCall.current != null) return
    val bytes = try {
      Base64.decode(pcmBase64, Base64.DEFAULT)
    } catch (_: Throwable) {
      return
    }
    if (bytes.isEmpty()) return
    synchronized(playLock) {
      if (playId != utteranceId) {
        startSpeechLocked(ctx.applicationContext, utteranceId, 48_000)
      }
      if (playId == utteranceId) {
        playQueue.addLast(bytes)
        playLock.notifyAll()
      }
    }
  }

  fun finishSpeech(utteranceId: String) {
    synchronized(playLock) {
      if (playId == utteranceId) {
        playInputDone = true
        playLock.notifyAll()
      }
    }
  }

  fun stopSpeech(utteranceId: String?) {
    val stoppedId: String
    val tr: AudioTrack?
    val focus: AudioFocusRequest?
    val am: AudioManager?
    synchronized(playLock) {
      val cur = playId ?: return
      if (utteranceId != null && utteranceId != cur) return
      stoppedId = cur
      playId = null
      playGen++
      playQueue.clear()
      playInputDone = false
      tr = playTrack
      focus = playFocus
      am = playAm
      playTrack = null
      playFocus = null
      playAm = null
      playLock.notifyAll()
    }
    releasePlayer(tr, am, focus)
    XiaoaiBus.emit("onSpeech", mapOf("utteranceId" to stoppedId, "state" to "stopped"))
  }

  private fun startSpeechLocked(ctx: Context, utteranceId: String, sampleRate: Int) {
    val prevId = playId
    val prevTrack = playTrack
    val prevFocus = playFocus
    val prevAm = playAm

    playGen++
    val myGen = playGen
    playId = utteranceId
    val rate = sampleRate.coerceIn(8_000, 48_000)
    playRate = rate
    playQueue.clear()
    playInputDone = false
    playTrack = null
    playFocus = null
    playAm = null
    playLock.notifyAll()

    if (prevTrack != null || prevFocus != null) {
      releasePlayer(prevTrack, prevAm, prevFocus)
    }
    if (prevId != null && prevId != utteranceId) {
      XiaoaiBus.emit("onSpeech", mapOf("utteranceId" to prevId, "state" to "stopped"))
    }

    val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val attrs = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_MEDIA)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()
    var focusReq: AudioFocusRequest? = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusReq = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(attrs)
        .build()
      am.requestAudioFocus(focusReq)
    }

    val minOut = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
    val tr = AudioTrack.Builder()
      .setAudioAttributes(attrs)
      .setAudioFormat(
        AudioFormat.Builder()
          .setSampleRate(rate)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .build(),
      )
      .setTransferMode(AudioTrack.MODE_STREAM)
      .setBufferSizeInBytes(maxOf(minOut * 2, rate * 2))
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      try { tr.setStartThresholdInFrames((rate / 1000) * 40) } catch (_: Throwable) {}
    }
    tr.play()
    playTrack = tr
    playFocus = focusReq
    playAm = am

    XiaoaiBus.emit("onSpeech", mapOf("utteranceId" to utteranceId, "state" to "playing"))

    val t = Thread({
      var writtenFrames = 0L
      try {
        while (true) {
          var chunk: ByteArray? = null
          var done = false
          synchronized(playLock) {
            while (playGen == myGen && playQueue.isEmpty() && !playInputDone) {
              playLock.wait(25)
            }
            if (playGen != myGen) return@Thread
            chunk = playQueue.removeFirstOrNull()
            done = playInputDone && playQueue.isEmpty()
          }
          val bytes = chunk
          if (bytes != null) {
            var off = 0
            while (off < bytes.size) {
              synchronized(playLock) {
                if (playGen != myGen) return@Thread
              }
              val n = tr.write(bytes, off, bytes.size - off, AudioTrack.WRITE_BLOCKING)
              if (n <= 0) break
              off += n
              writtenFrames += n / 2
            }
          } else if (done) {
            break
          }
        }

        // Wait for remaining queued audio to play out naturally.
        val startedDrainAt = SystemClock.elapsedRealtime()
        val maxWaitMs = maxOf(600L, minOf(15_000L, (writtenFrames * 1000L) / rate + 500L))
        var lastHead = -1L
        var lastAdvanceAt = startedDrainAt
        while (true) {
          synchronized(playLock) {
            if (playGen != myGen) return@Thread
          }
          val head = tr.playbackHeadPosition.toLong() and 0xFFFFFFFFL
          if (head >= writtenFrames) break
          val now = SystemClock.elapsedRealtime()
          if (head > lastHead) {
            lastHead = head
            lastAdvanceAt = now
          }
          if (now - startedDrainAt >= maxWaitMs || now - lastAdvanceAt >= 1_500L) break
          Thread.sleep(25)
        }

        val cleanFinish: Boolean
        synchronized(playLock) {
          cleanFinish = playGen == myGen
          if (cleanFinish) {
            playId = null
            playQueue.clear()
            playInputDone = false
            playTrack = null
            playFocus = null
            playAm = null
          }
        }
        if (cleanFinish) {
          releasePlayer(tr, am, focusReq)
          XiaoaiBus.emit("onSpeech", mapOf("utteranceId" to utteranceId, "state" to "ended"))
        }
      } catch (e: Throwable) {
        Log.w(CV_TAG, "chat play", e)
        var wasCur = false
        synchronized(playLock) {
          if (playGen == myGen) {
            wasCur = true
            playId = null
            playQueue.clear()
            playInputDone = false
            playTrack = null
            playFocus = null
            playAm = null
          }
        }
        if (wasCur) {
          releasePlayer(tr, am, focusReq)
          XiaoaiBus.emit("onSpeech", mapOf("utteranceId" to utteranceId, "state" to "stopped"))
        }
      }
    }, "pocket-chat-play")
    t.isDaemon = true
    t.start()
  }

  private fun releasePlayer(tr: AudioTrack?, am: AudioManager?, focus: AudioFocusRequest?) {
    try { tr?.pause(); tr?.flush() } catch (_: Throwable) {}
    try { tr?.release() } catch (_: Throwable) {}
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focus != null && am != null) {
      try { am.abandonAudioFocusRequest(focus) } catch (_: Throwable) {}
    }
  }
}
