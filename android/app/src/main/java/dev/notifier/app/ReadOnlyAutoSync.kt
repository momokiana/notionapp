package dev.notifier.app

import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

/** One lifecycle-scoped listener, no service/polling loop. Signals never call Ledger.recover(). */
@Composable fun ReadOnlyAutoSync(model: ClientModel) {
    val owner = LocalLifecycleOwner.current
    val context = LocalContext.current.applicationContext
    DisposableEffect(owner, model, context) {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val handler = Handler(Looper.getMainLooper())
        var registered = false
        var active = false
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { handler.post { if (active) model.autoRefresh() } }
        }
        fun start() {
            if (active) return
            active = true
            runCatching { manager.registerDefaultNetworkCallback(callback); registered = true }
            model.foreground(true)
        }
        fun stop() {
            active = false
            if (registered) { runCatching { manager.unregisterNetworkCallback(callback) }; registered = false }
            model.foreground(false)
        }
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_START) start()
            if (event == Lifecycle.Event.ON_STOP) stop()
        }
        owner.lifecycle.addObserver(observer)
        if (owner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) start()
        onDispose { owner.lifecycle.removeObserver(observer); stop() }
    }
}
