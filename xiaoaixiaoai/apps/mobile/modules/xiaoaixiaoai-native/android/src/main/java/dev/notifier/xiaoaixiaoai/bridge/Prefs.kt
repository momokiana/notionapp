package dev.notifier.xiaoaixiaoai.bridge

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/** What the background service needs after the app process is gone (app-private storage). */
class Prefs(ctx: Context) {
  // Keep the private file name used by previous 小爱小爱 builds so an update keeps pairing and reminder deduplication.
  private val p: SharedPreferences = ctx.applicationContext.getSharedPreferences("pocket_native", Context.MODE_PRIVATE)

  companion object {
    // A previous socket must never advance the new pairing's replay cursor.
    private val lock = Any()
  }

  class Pairing(val server: String, val token: String)
  private val server: String? get() = p.getString("server", null)
  val token: String? get() = p.getString("token", null)
  val notify: Boolean get() = p.getBoolean("notify", false)
  val kinds: Set<String> get() = p.getStringSet("kinds", setOf("blocked", "done", "reminder")) ?: emptySet()
  val assistantName: String get() = p.getString("assistantName", "爱弥斯") ?: "爱弥斯"
  var ledgerEnabled: Boolean
    get() = p.getBoolean("ledgerEnabled", false)
    set(value) {
      synchronized(lock) { p.edit().putBoolean("ledgerEnabled", value).apply() }
    }
  val ledgerSnapshot: String? get() = p.getString("ledgerSnapshot", null)
  fun setLedgerSnapshot(json: String?) = synchronized(lock) {
    p.edit().putString("ledgerSnapshot", json).apply()
  }

  data class WeChatCardLine(val text: String, val collapsedHintCount: Int = 0)

  fun consumeWeChatCardLines(cardKey: String, postTime: Long, rawLines: List<String>, collapsedCount: Int): List<WeChatCardLine> = synchronized(lock) {
    val lines = rawLines.map { it.trim() }.filter { it.isNotEmpty() }
    if (lines.isEmpty()) return@synchronized emptyList()
    val root = try { JSONObject(p.getString("wcCardStates", "{}") ?: "{}") } catch (_: Throwable) { JSONObject() }
    val prevObj = root.optJSONObject(cardKey)
    val prevTs = prevObj?.optLong("ts", 0L) ?: 0L
    val prevCount = prevObj?.optInt("count", 0) ?: 0
    val prevLines = ArrayList<String>().apply {
      val arr = prevObj?.optJSONArray("lines")
      if (arr != null) for (i in 0 until arr.length()) arr.optString(i)?.let { if (it.isNotEmpty()) add(it) }
    }

    if (prevObj != null && prevTs == postTime && prevLines == lines && prevCount == collapsedCount) {
      return@synchronized emptyList()
    }

    val result = ArrayList<WeChatCardLine>()
    if (lines.size == 1) {
      val line = lines[0]
      if (collapsedCount > 1) {
        if (prevObj == null) {
          result.add(WeChatCardLine(line, collapsedHintCount = collapsedCount))
        } else if (collapsedCount > prevCount) {
          val delta = collapsedCount - prevCount
          result.add(WeChatCardLine(line, collapsedHintCount = if (delta > 1) collapsedCount else 0))
        } else if (line != prevLines.firstOrNull() || postTime - prevTs >= 2_500L) {
          result.add(WeChatCardLine(line, collapsedHintCount = 0))
        }
      } else {
        if (prevObj == null || line != prevLines.firstOrNull() || postTime - prevTs >= 2_500L) {
          result.add(WeChatCardLine(line, collapsedHintCount = 0))
        }
      }
    } else {
      var overlap = 0
      val maxK = minOf(prevLines.size, lines.size)
      for (k in maxK downTo 1) {
        if (prevLines.subList(prevLines.size - k, prevLines.size) == lines.subList(0, k)) {
          overlap = k
          break
        }
      }
      if (overlap == 0 && prevLines == lines && postTime - prevTs < 2_500L) {
        overlap = lines.size
      }
      for (i in overlap until lines.size) {
        result.add(WeChatCardLine(lines[i], collapsedHintCount = 0))
      }
    }

    val nextObj = JSONObject().apply {
      put("ts", postTime)
      put("count", collapsedCount)
      put("updatedAt", System.currentTimeMillis())
      put("lines", JSONArray().apply { for (l in lines.takeLast(12)) put(l) })
    }
    root.put(cardKey, nextObj)
    // Cap tracked notification cards to prevent unbounded preference growth.
    if (root.length() > 32) {
      val keys = root.keys().asSequence().toList()
        .sortedBy { root.optJSONObject(it)?.optLong("updatedAt", 0L) ?: 0L }
      for (staleKey in keys.take(root.length() - 32)) root.remove(staleKey)
    }
    p.edit().putString("wcCardStates", root.toString()).apply()
    result
  }

  fun forgetWeChatCard(cardKey: String) = synchronized(lock) {
    val raw = p.getString("wcCardStates", null) ?: return@synchronized
    val root = try { JSONObject(raw) } catch (_: Throwable) { return@synchronized }
    if (root.remove(cardKey) != null) {
      p.edit().putString("wcCardStates", root.toString()).apply()
    }
  }

  fun rememberWeChatTx(dedupKey: String, ts: Long): Boolean = synchronized(lock) {
    val raw = p.getString("wcRecentKeys", "[]") ?: "[]"
    val arr = try { JSONArray(raw) } catch (_: Throwable) { JSONArray() }
    val fresh = JSONArray()
    val cutoff = ts - 20_000L
    for (i in 0 until arr.length()) {
      val o = arr.optJSONObject(i) ?: continue
      if (o.optLong("ts") < cutoff) continue
      if (o.optString("k") == dedupKey) return false
      fresh.put(o)
    }
    fresh.put(JSONObject().put("k", dedupKey).put("ts", ts))
    while (fresh.length() > 64) fresh.remove(0)
    p.edit().putString("wcRecentKeys", fresh.toString()).apply()
    true
  }

  fun enqueuePendingLedger(item: JSONObject) = synchronized(lock) {
    val raw = p.getString("wcPendingQueue", "[]") ?: "[]"
    val arr = try { JSONArray(raw) } catch (_: Throwable) { JSONArray() }
    val ext = item.optString("externalId")
    for (i in 0 until arr.length()) {
      if (ext.isNotEmpty() && arr.optJSONObject(i)?.optString("externalId") == ext) return@synchronized
    }
    arr.put(item)
    while (arr.length() > 50) arr.remove(0)
    p.edit().putString("wcPendingQueue", arr.toString()).apply()
  }

  fun drainPendingLedger(): List<JSONObject> = synchronized(lock) {
    val raw = p.getString("wcPendingQueue", "[]") ?: "[]"
    p.edit().remove("wcPendingQueue").apply()
    val arr = try { JSONArray(raw) } catch (_: Throwable) { return emptyList() }
    val out = ArrayList<JSONObject>(arr.length())
    for (i in 0 until arr.length()) arr.optJSONObject(i)?.let(out::add)
    out
  }

  fun restorePendingLedger(items: List<JSONObject>) = synchronized(lock) {
    val existing = drainPendingLedger()
    val merged = JSONArray()
    val seen = HashSet<String>()
    for (item in items + existing) {
      val ext = item.optString("externalId")
      if (ext.isEmpty() || seen.add(ext)) merged.put(item)
      if (merged.length() >= 50) break
    }
    p.edit().putString("wcPendingQueue", merged.toString()).apply()
  }
  private val lastTs: Long get() = p.getLong("lastTs", 0L)

  fun configure(server: String?, token: String?, enabled: Boolean, kinds: Set<String>, name: String?) = synchronized(lock) {
    val edit = p.edit().putString("server", server).putString("token", token)
      .putBoolean("notify", enabled && !server.isNullOrEmpty() && !token.isNullOrEmpty()).putStringSet("kinds", kinds)
    if (server != this.server || token != this.token) edit.remove("lastTs").remove("recentIds")
    if (!name.isNullOrEmpty()) edit.putString("assistantName", name)
    edit.apply()
  }

  fun pairing(): Pairing? = synchronized(lock) {
    val s = server
    val t = token
    if (notify && !s.isNullOrEmpty() && !t.isNullOrEmpty()) Pairing(s, t) else null
  }

  fun matches(pair: Pairing): Boolean = synchronized(lock) { notify && server == pair.server && token == pair.token }

  fun revoke(pair: Pairing) = synchronized(lock) {
    if (matches(pair)) p.edit().putBoolean("notify", false).apply()
  }

  fun since(pair: Pairing): Long? = synchronized(lock) {
    if (!matches(pair)) return@synchronized null
    // Include the last millisecond to recover a second notice with the same timestamp.
    (lastTs.takeIf { it > 0 } ?: System.currentTimeMillis()).minus(1).coerceAtLeast(1)
  }

  fun seedCursor(pair: Pairing, since: Long) = synchronized(lock) {
    if (lastTs == 0L && matches(pair)) p.edit().putLong("lastTs", since).apply()
  }

  fun remember(pair: Pairing, id: String, ts: Long): Boolean = synchronized(lock) {
    if (!matches(pair)) return@synchronized false
    val ids = (p.getString("recentIds", "") ?: "").split(",").filter { it.isNotEmpty() }
    if (id in ids) return@synchronized false
    p.edit().putString("recentIds", (ids + id).takeLast(256).joinToString(","))
      .putLong("lastTs", maxOf(lastTs, ts)).apply()
    true
  }
}

/** Events for the JS side, delivered while the app's module is alive. */
object XiaoaiBus {
  @Volatile var listener: ((String, Map<String, Any?>) -> Unit)? = null

  fun emit(name: String, body: Map<String, Any?>) {
    try {
      listener?.invoke(name, body)
    } catch (_: Throwable) {
      // The JS runtime may be going away; the service keeps running regardless.
    }
  }
}

fun wsUrl(server: String, path: String): String {
  val base = server.trimEnd('/')
  return when {
    base.startsWith("https://", ignoreCase = true) -> "wss://" + base.substring(8)
    base.startsWith("http://", ignoreCase = true) -> "ws://" + base.substring(7)
    else -> base
  } + path
}
