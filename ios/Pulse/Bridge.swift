import AuthenticationServices
import CryptoKit
import Security
import SpotifyiOS
import UIKit
import WebKit

/// `window.pulse` for the web UI: the same calls the desktop preload exposes, answered natively.
@MainActor
final class Bridge: NSObject, ObservableObject, WKScriptMessageHandlerWithReply {
    weak var webView: WKWebView?
    let spotify = Spotify()

    static let shim = """
    (() => {
      const call = (name, ...args) => window.webkit.messageHandlers.pulse.postMessage({ name, args });
      window.pulse = {
        platform: 'ios',
        configured: () => call('configured'), clientInfo: () => call('clientInfo'),
        setClientId: id => call('setClientId', id), useBuiltIn: () => call('useBuiltIn'),
        login: () => call('login'), token: () => call('token'), logout: () => call('logout'),
        wake: uri => call('wake', uri),
        mini: async () => {}, pin: async () => {}, chrome: () => {},
        lastfm: null, loginItem: null, // desktop-only features
      };
    })();
    """

    // A thrown error becomes a rejected promise in JS (its message is shown in a toast).
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard let body = message.body as? [String: Any], let name = body["name"] as? String else { return (nil, "bad call") }
        let arg = (body["args"] as? [Any])?.first as? String ?? ""
        do {
            switch name {
            case "configured": return (spotify.clientID != nil, nil)
            case "clientInfo": return (spotify.clientInfo, nil)
            case "setClientId": try spotify.setCustom(arg); return (nil, nil)
            case "useBuiltIn": spotify.useBuiltIn(); return (nil, nil)
            case "login": return (try await spotify.login(), nil)
            case "token": return (try await spotify.token() ?? NSNull(), nil) // null = logged out
            case "logout": spotify.logout(); return (nil, nil)
            case "wake": try await spotify.wake(uri: arg); return (nil, nil)
            default: return (nil, "unknown call \(name)")
            }
        } catch {
            return (nil, error.localizedDescription)
        }
    }
}

struct PulseError: LocalizedError {
    let message: String
    var status = 0
    var errorDescription: String? { message }
}

/// Spotify login (PKCE, no client secret), token refresh, and waking the Spotify app.
@MainActor
final class Spotify: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let redirect = "pulse://callback"
    static let scopes = [
        "user-read-email", "user-read-private", "user-read-playback-state", "user-modify-playback-state",
        "user-read-currently-playing", "user-read-recently-played", "user-top-read",
        "user-library-read", "user-library-modify", "user-follow-read", "user-follow-modify",
        "playlist-read-private", "playlist-read-collaborative", "playlist-modify-public", "playlist-modify-private",
        "ugc-image-upload",
    ]

    // Client ID: built-in (web/build.json from build.sh) or the user's own (UserDefaults); own wins.
    private let builtIn: String? = {
        guard let url = Bundle.main.url(forResource: "build", withExtension: "json", subdirectory: "web"),
              let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = json["clientId"] as? String, !id.isEmpty else { return nil }
        return id
    }()
    private var custom: String? {
        get { UserDefaults.standard.string(forKey: "customClientId").flatMap { $0 == builtIn ? nil : $0 } }
        set { UserDefaults.standard.set(newValue, forKey: "customClientId") }
    }
    var clientID: String? { custom ?? builtIn }
    var clientInfo: [String: Any] {
        ["builtIn": builtIn != nil, "custom": custom.map { "••••" + $0.suffix(4) } ?? NSNull()]
    }

    func setCustom(_ id: String) throws {
        let id = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard id.range(of: "^[0-9a-fA-F]{32}$", options: .regularExpression) != nil else {
            throw PulseError(message: "That does not look like a Spotify Client ID (32 letters and digits).")
        }
        if id != custom { custom = id; logout() } // a login belongs to one Spotify app
    }

    func useBuiltIn() {
        if builtIn != nil, custom != nil { custom = nil; logout() }
    }

    // MARK: tokens

    private var access: String?
    private var expires = Date.distantPast
    private var refreshing: Task<String?, Error>?
    private var authSession: ASWebAuthenticationSession?

    /// nil = logged out; throws = couldn't refresh right now (session kept, try again later)
    func token() async throws -> String? {
        if let access, Date() < expires { return access }
        guard let saved = Keychain.load(), Set(saved.scope.split(separator: " ").map(String.init)).isSuperset(of: Self.scopes) else { return nil }
        if let refreshing { return try await refreshing.value }
        let task = Task<String?, Error> {
            defer { self.refreshing = nil }
            do { return try await self.tokenRequest(["grant_type": "refresh_token", "refresh_token": saved.refresh]) }
            catch let e as PulseError where e.status == 400 || e.status == 401 { Keychain.delete(); return nil } // revoked
            catch { throw PulseError(message: "Couldn’t reach Spotify. Check your connection.") }
        }
        refreshing = task
        return try await task.value
    }

    func login() async throws -> String {
        guard let id = clientID else { throw PulseError(message: "No Spotify Client ID set.") }
        let verifier = Self.randomURLSafe(64)
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
        let state = Self.randomURLSafe(16)
        var url = URLComponents(string: "https://accounts.spotify.com/authorize")!
        url.queryItems = [
            .init(name: "client_id", value: id), .init(name: "response_type", value: "code"),
            .init(name: "redirect_uri", value: Self.redirect), .init(name: "scope", value: Self.scopes.joined(separator: " ")),
            .init(name: "code_challenge_method", value: "S256"), .init(name: "code_challenge", value: challenge),
            .init(name: "state", value: state),
        ]
        let callback: URL = try await withCheckedThrowingContinuation { cont in
            let session = ASWebAuthenticationSession(url: url.url!, callbackURLScheme: "pulse") { url, error in
                if let url { cont.resume(returning: url) }
                else { cont.resume(throwing: PulseError(message: "Login cancelled")) }
            }
            session.presentationContextProvider = self
            authSession = session // must stay alive while the sheet is up
            session.start()
        }
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (name: String) in items.first { $0.name == name }?.value }
        guard value("state") == state, let code = value("code") else {
            throw PulseError(message: value("error").map { "Spotify: \($0)" } ?? "Login failed")
        }
        return try await tokenRequest(["grant_type": "authorization_code", "code": code,
                                       "redirect_uri": Self.redirect, "code_verifier": verifier])
    }

    func logout() {
        access = nil
        expires = .distantPast
        Keychain.delete()
    }

    private func tokenRequest(_ params: [String: String]) async throws -> String {
        guard let id = clientID else { throw PulseError(message: "No Spotify Client ID set.") }
        var req = URLRequest(url: URL(string: "https://accounts.spotify.com/api/token")!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = Self.form(params.merging(["client_id": id]) { a, _ in a }).data(using: .utf8)
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            throw PulseError(message: "Spotify token error \(status): \(String(data: data, encoding: .utf8) ?? "")", status: status)
        }
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        guard let token = json["access_token"] as? String, let life = json["expires_in"] as? Double else {
            throw PulseError(message: "Spotify sent an unexpected token response.")
        }
        let old = Keychain.load()
        Keychain.save(.init(refresh: json["refresh_token"] as? String ?? old?.refresh ?? "",
                            scope: json["scope"] as? String ?? old?.scope ?? ""))
        access = token
        expires = Date().addingTimeInterval(life - 60)
        return token
    }

    // MARK: waking the Spotify app

    private var appRemote: SPTAppRemote?
    private var wakeWaiter: CheckedContinuation<Void, Error>?

    /// Opens the Spotify app playing `uri` ("" = last song); resolves when Spotify hands control back.
    func wake(uri: String) async throws {
        guard let id = clientID else { throw PulseError(message: "No Spotify Client ID set.") }
        let remote = SPTAppRemote(configuration: SPTConfiguration(clientID: id, redirectURL: URL(string: Self.redirect)!), logLevel: .error)
        appRemote = remote
        finishWake(PulseError(message: "Cancelled")) // a previous wake that never came back
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            wakeWaiter = cont
            remote.authorizeAndPlayURI(uri) { installed in
                if !installed {
                    self.finishWake(PulseError(message: "The Spotify app isn’t installed. Get it from the App Store, log in, then try again."))
                }
            }
            Task {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                self.finishWake(PulseError(message: "Spotify didn’t hand control back. Switch to Pulse and try again."))
            }
        }
    }

    func handle(url: URL) {
        guard url.scheme == "pulse" else { return }
        if let error = appRemote?.authorizationParameters(from: url)?[SPTAppRemoteErrorDescriptionKey] {
            finishWake(PulseError(message: "Spotify: \(error)"))
        } else {
            finishWake(nil)
        }
    }

    private func finishWake(_ error: Error?) {
        guard let waiter = wakeWaiter else { return }
        wakeWaiter = nil
        if let error { waiter.resume(throwing: error) } else { waiter.resume() }
    }

    // MARK: helpers

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
        }
    }

    private static func randomURLSafe(_ bytes: Int) -> String {
        var data = Data(count: bytes)
        _ = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, bytes, $0.baseAddress!) }
        return data.base64URL
    }

    private static func form(_ params: [String: String]) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return params.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }.joined(separator: "&")
    }
}

/// The refresh token lives in the iOS keychain (this device only, readable after first unlock).
enum Keychain {
    struct Session: Codable { var refresh: String; var scope: String }
    private static let base: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.ronishnadar.pulse",
        kSecAttrAccount as String: "spotify",
    ]

    static func load() -> Session? {
        var query = base
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Session.self, from: data)
    }

    static func save(_ session: Session) {
        delete()
        var item = base
        item[kSecValueData as String] = try? JSONEncoder().encode(session)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    static func delete() { SecItemDelete(base as CFDictionary) }
}

extension Data {
    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
