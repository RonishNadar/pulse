import SwiftUI

// Pulse for iPhone: the same web UI as the desktop app, hosted in a web view.
// Spotify only streams to its own app on iOS, so Pulse is a remote for the Spotify app.
@main
struct PulseApp: App {
    @StateObject private var bridge = Bridge()

    var body: some Scene {
        WindowGroup {
            WebView(bridge: bridge)
                .ignoresSafeArea()
                .background(Color(red: 0.05, green: 0.03, blue: 0.05))
                .preferredColorScheme(.dark)
                // the Spotify app returns here (pulse://callback) after waking up to play
                .onOpenURL { bridge.spotify.handle(url: $0) }
        }
    }
}
