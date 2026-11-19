package dev.notifier.xiaoaixiaoai.bridge

import android.content.Context
import android.content.SharedPreferences

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
