import SwiftUI
import WebKit

struct WebView: UIViewRepresentable {
    let bridge: Bridge

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let ucc = config.userContentController
        ucc.addScriptMessageHandler(bridge, contentWorld: .page, name: "pulse")
        ucc.addUserScript(WKUserScript(source: Bridge.shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.contentInsetAdjustmentBehavior = .never // the page handles safe areas itself
        web.scrollView.bounces = false
        web.isInspectable = true // Safari > Develop > iPhone, for debugging
        web.navigationDelegate = context.coordinator
        bridge.webView = web

        let dir = Bundle.main.url(forResource: "web", withExtension: nil)!
        web.loadFileURL(dir.appendingPathComponent("index.html"), allowingReadAccessTo: dir)
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate {
        // links (dashboard, LRCLIB, Last.fm) open in Safari, never inside the app
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if action.navigationType == .linkActivated, let url = action.request.url, url.scheme == "https" {
                UIApplication.shared.open(url)
                return decisionHandler(.cancel)
            }
            decisionHandler(.allow)
        }
    }
}
