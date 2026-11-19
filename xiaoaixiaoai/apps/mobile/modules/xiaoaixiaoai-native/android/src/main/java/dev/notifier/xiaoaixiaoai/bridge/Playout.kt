package dev.notifier.xiaoaixiaoai.bridge

/**
 * The speaker's jitter buffer: tells the play thread what to write next, or
 * that it writes silence. A reply starts once a cushion of its audio is in
 * (sized from how late the last few replies' audio came); a reply that runs
 * dry waits for a smaller cushion instead of playing scraps, which is what
 * sounds choppy.
 *
 * apps/relay/test/voice/playout.ts is the same logic, and the voice harness
 * next to it measures it against the old direct playback. Keep the two in step.
 * Not thread-safe: VoiceCall guards it with its lock. Times are in ms.
 */
internal class Playout<T : Playout.Piece>(private val framesPerMs: Int) {
  interface Piece {
    val run: String
    val frames: Int
  }

  companion object {
    /** Audio held back before a reply starts, at least and at most. */
    const val MIN_TARGET_MS = 200.0
    const val MAX_TARGET_MS = 400.0
    /** The next reply's target: what the last few replies needed, plus a margin. */
    const val HISTORY_RUNS = 4
    const val MARGIN_MS = 20.0
    /** A stall in the middle of a reply raises the target by this much right away. */
    const val STEP_MS = 60.0
    /** After a stall in the middle of a reply, play again once this share of the target is in. */
    const val REBUFFER_SHARE = 0.5
    const val REBUFFER_MIN_MS = 80.0
    /** Waiting for the target never takes longer than the target plus this. */
    const val HOLD_SLACK_MS = 120.0
    /**
     * Silence kept queued while the track has no speech, so it never runs dry. Only
     * where the track's start threshold is its whole buffer (before Android 12):
     * a dry track there plays again only once the whole buffer is full. From
     * Android 12 one chunk restarts it, and silence would only hold speech back.
     */
    const val LEAD_MS = 40
  }

  private val queue = ArrayDeque<T>()
  private var queued = 0L
  private var holding = true
  /** Holding after a stall in the middle of a reply, not before one. */
  private var rebuffering = false
  private var holdSince = -1L
  private var playing = ""
  private val finished = ArrayDeque<String>()
  // How late the arriving run's audio is against a steady playout from its first chunk.
  private var arrivingRun = ""
  private var arrivingSince = 0L
  private var arrivingMs = 0.0
  private var lateMs = 0.0
  private val needed = ArrayDeque<Double>()

  var targetMs = MIN_TARGET_MS
    private set
  var maxTargetMs = MIN_TARGET_MS
    private set
  var stalls = 0
    private set

  val queuedMs: Double get() = queued.toDouble() / framesPerMs

  fun push(p: T, now: Long) {
    if (p.run != arrivingRun) {
      if (arrivingRun.isNotEmpty()) learn(lateMs)
      arrivingRun = p.run
      arrivingSince = now
      arrivingMs = 0.0
      lateMs = 0.0
    } else {
      lateMs = maxOf(lateMs, now - arrivingSince - arrivingMs)
    }
    arrivingMs += p.frames.toDouble() / framesPerMs
    queue.addLast(p)
    queued += p.frames
  }

  /** A run's audio has all come: the next target covers what the last few needed. */
  private fun learn(late: Double) {
    needed.addLast(late)
    if (needed.size > HISTORY_RUNS) needed.removeFirst()
    targetMs = (needed.max() + MARGIN_MS).coerceIn(MIN_TARGET_MS, MAX_TARGET_MS)
    maxTargetMs = maxOf(maxTargetMs, targetMs)
  }

  /** The service has sent all of this run's audio. */
  fun finish(run: String) {
    if (finished.contains(run)) return
    finished.addLast(run)
    if (finished.size > 64) finished.removeFirst()
  }

  /** The run was stopped: its queued audio goes. */
  fun drop(run: String) {
    if (queue.removeAll { it.run == run }) queued = queue.sumOf { it.frames.toLong() }
    if (playing == run) playing = ""
    holding = true
    rebuffering = false
    holdSince = -1
  }

  /** Pieces flushed out of the track that still have to be played, back at the front. */
  fun requeue(pieces: List<T>) {
    for (p in pieces.asReversed()) {
      queue.addFirst(p)
      queued += p.frames
    }
  }

  /** What to write next, or null for nothing. [audioFrames]: speech the track holds and has not played yet. */
  fun take(now: Long, audioFrames: Long): T? {
    if (holding) {
      if (queue.isEmpty()) return null
      if (holdSince < 0) holdSince = now
      val want = if (rebuffering) maxOf(REBUFFER_MIN_MS, targetMs * REBUFFER_SHARE) else targetMs
      val ready = queuedMs >= want ||
        finished.contains(queue.first().run) ||
        finished.contains(queue.last().run) ||
        now - holdSince >= want + HOLD_SLACK_MS
      if (!ready) return null
      holding = false
      rebuffering = false
      holdSince = -1
    }
    val p = queue.removeFirstOrNull()
    if (p == null) {
      if (audioFrames <= 0) {
        // Ran dry in the middle of a reply: wait for a cushion instead of playing scraps.
        val midReply = playing.isNotEmpty() && !finished.contains(playing)
        if (midReply) {
          stalls++
          targetMs = minOf(MAX_TARGET_MS, targetMs + STEP_MS)
          maxTargetMs = maxOf(maxTargetMs, targetMs)
        }
        holding = true
        rebuffering = midReply
      }
      return null
    }
    queued -= p.frames
    playing = p.run
    return p
  }
}
