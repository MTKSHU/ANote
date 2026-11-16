import UIKit
import WebKit

/// Native, network-only shell. No script message handlers or private file bridge.
final class ANoteViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private let stack = UIStackView()
    private let serverInput = UITextField()
    private let status = UILabel()
    private var webView: WKWebView?
    private var server: URL?
    private var authenticating = false
    private var authenticationOrigins = Set<String>()
    private var downloadFiles = [ObjectIdentifier: URL]()
    private let previewOrigin = ""

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor)
        ])
        showServerPicker()
    }
    private func clearStack() {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
    }
    private func button(_ title: String, action: Selector) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(title, for: .normal)
        button.addTarget(self, action: action, for: .touchUpInside)
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        return button
    }
    private func origin(_ url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), ["https", "http"].contains(scheme),
              let host = url.host?.lowercased(), url.user == nil, url.password == nil else { return nil }
        let renderedHost = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        let port = url.port
        let suffix = port == nil || (scheme == "https" && port == 443) || (scheme == "http" && port == 80) ? "" : ":\(port!)"
        return "\(scheme)://\(renderedHost)\(suffix)"
    }
    private func acceptedServer(_ value: String) -> URL? {
        guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              let normalized = origin(url), url.path.isEmpty || url.path == "/", url.query == nil, url.fragment == nil else { return nil }
        if url.scheme?.lowercased() == "http" {
            #if DEBUG
            guard normalized == previewOrigin else { return nil }
            #else
            return nil
            #endif
        }
        return URL(string: normalized)
    }
    private func showServerPicker() {
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView = nil
        server = nil
        authenticating = false
        authenticationOrigins.removeAll()
        clearStack()
        stack.spacing = 18
        stack.isLayoutMarginsRelativeArrangement = true
        stack.layoutMargins = UIEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        let spacer = UIView()
        stack.addArrangedSubview(spacer)
        let title = UILabel()
        title.text = "ANote · \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") 预览"
        title.font = .preferredFont(forTextStyle: .largeTitle)
        stack.addArrangedSubview(title)
        let detail = UILabel()
        detail.text = "连接你的 ANote 服务器。登录、笔记与附件只发送到你选择的服务器。"
        detail.numberOfLines = 0
        stack.addArrangedSubview(detail)
        serverInput.placeholder = "https://你的服务器"
        serverInput.keyboardType = .URL
        serverInput.autocapitalizationType = .none
        serverInput.autocorrectionType = .no
        serverInput.borderStyle = .roundedRect
        serverInput.text = UserDefaults.standard.string(forKey: "anote-server") ?? ""
        #if DEBUG
        if serverInput.text?.isEmpty != false { serverInput.text = previewOrigin }
        #endif
        stack.addArrangedSubview(serverInput)
        stack.addArrangedSubview(button("连接服务器", action: #selector(connect)))
        status.text = "首次打开不会自动连接。HTTP 内部预览请只使用隔离测试账号。"
        status.numberOfLines = 0
        status.font = .preferredFont(forTextStyle: .footnote)
        stack.addArrangedSubview(status)
        let bottom = UIView()
        stack.addArrangedSubview(bottom)
        spacer.heightAnchor.constraint(equalTo: bottom.heightAnchor).isActive = true
    }
    @objc private func connect() {
        guard let selected = acceptedServer(serverInput.text ?? "") else {
            status.text = "请输入不含路径、账号或参数的 HTTPS 服务器地址。"
            return
        }
        view.endEditing(true)
        server = selected
        UserDefaults.standard.set(origin(selected), forKey: "anote-server")
        clearStack()
        stack.spacing = 0
        stack.layoutMargins = .zero
        let toolbar = UIStackView(arrangedSubviews: [button("‹", action: #selector(goBack)), status, button("⋯", action: #selector(openMenu))])
        toolbar.axis = .horizontal
        toolbar.spacing = 8
        toolbar.arrangedSubviews.first?.widthAnchor.constraint(equalToConstant: 44).isActive = true
        toolbar.arrangedSubviews.last?.widthAnchor.constraint(equalToConstant: 44).isActive = true
        status.text = origin(selected)
        status.numberOfLines = 1
        status.lineBreakMode = .byTruncatingMiddle
        stack.addArrangedSubview(toolbar)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.customUserAgent = nil
        web.scrollView.keyboardDismissMode = .interactive
        stack.addArrangedSubview(web)
        webView = web
        let cookieOrigin = UserDefaults.standard.string(forKey: "cookie-origin")
        if cookieOrigin != origin(selected) {
            WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) { [weak self, weak web] in
                guard let self = self, let web = web, self.server == selected else { return }
                UserDefaults.standard.set(self.origin(selected), forKey: "cookie-origin")
                web.load(URLRequest(url: selected))
            }
        } else { web.load(URLRequest(url: selected)) }
    }
    private func confirm(title: String, message: String, proceed: @escaping () -> Void) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "继续", style: .default) { _ in proceed() })
        present(alert, animated: true)
    }
    @objc private func goBack() {
        if let web = webView, let selected = server, let url = web.url, origin(url) == origin(selected) {
            web.evaluateJavaScript("(()=>{const event=new Event('anote:mobile-back',{cancelable:true});return !window.dispatchEvent(event);})()") { [weak self] result, _ in
                if (result as? Bool) != true { self?.navigateHistoryOrSelect() }
            }
            return
        }
        navigateHistoryOrSelect()
    }
    private func navigateHistoryOrSelect() {
        if let web = webView, web.canGoBack { web.goBack() }
        else { confirm(title: "切换服务器", message: "请确认笔记已经保存，再离开当前页面。") { self.showServerPicker() } }
    }
    @objc private func openMenu() {
        let menu = UIAlertController(title: "ANote", message: nil, preferredStyle: .actionSheet)
        menu.addAction(UIAlertAction(title: "刷新页面", style: .default) { _ in self.webView?.reload() })
        menu.addAction(UIAlertAction(title: "打印 / 保存 PDF", style: .default) { _ in
            self.printPage()
        })
        menu.addAction(UIAlertAction(title: "切换服务器", style: .default) { _ in
            self.confirm(title: "切换服务器", message: "请确认笔记已经保存，再离开当前页面。") { self.showServerPicker() }
        })
        menu.addAction(UIAlertAction(title: "取消", style: .cancel))
        menu.popoverPresentationController?.sourceView = stack.arrangedSubviews.first
        present(menu, animated: true)
    }
    private func printPage() {
        guard let web = webView, let selected = server, let current = web.url, origin(current) == origin(selected) else { return }
        web.evaluateJavaScript("(document.querySelector('input[aria-label=\"笔记标题\"]')?.value || document.title || '').slice(0,200)") { [weak self, weak web] result, _ in
            guard let self = self, let web = web, self.webView === web, let url = web.url, self.origin(url) == self.origin(selected) else { return }
            let selectedTitle = (result as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let fallback = web.title?.trimmingCharacters(in: .whitespacesAndNewlines)
            let raw = selectedTitle?.isEmpty == false ? selectedTitle! : (fallback?.isEmpty == false ? fallback! : "笔记")
            let title = String(raw.components(separatedBy: CharacterSet.controlCharacters.union(CharacterSet(charactersIn: "/\\:*?\"<>|"))).joined(separator: "_").prefix(180))
            let printer = UIPrintInteractionController.shared
            let info = UIPrintInfo(dictionary: nil)
            info.jobName = title
            printer.printInfo = info
            printer.printFormatter = web.viewPrintFormatter()
            printer.present(animated: true, completionHandler: nil)
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, url.scheme == "blob", let selected = server {
            decisionHandler(downloadOrigin(url) == origin(selected) && navigationAction.shouldPerformDownload ? .download : .cancel)
            return
        }
        guard let url = navigationAction.request.url, let destination = origin(url), let selected = server, let home = origin(selected) else {
            decisionHandler(.cancel); return
        }
        // Leave subresource / embedded document policies to WebKit's same-origin controls.
        if navigationAction.targetFrame?.isMainFrame == false { decisionHandler(.allow); return }
        if destination == home {
            if ["/api/auth/casdoor/start", "/api/auth/casdoor/link"].contains(url.path) { authenticating = true }
            if url.query?.contains("auth_success=") == true || url.query?.contains("auth_error=") == true {
                authenticating = false; authenticationOrigins.removeAll()
            }
            decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
            return
        }
        guard url.scheme == "https" else { decisionHandler(.cancel); return }
        if authenticating {
            if authenticationOrigins.contains(destination) { decisionHandler(.allow); return }
            confirm(title: "继续统一登录", message: "请确认这是你的团队认证服务器：\n" + destination) {
                self.authenticationOrigins.insert(destination)
                webView.load(URLRequest(url: url))
            }
        } else {
            confirm(title: "在浏览器打开链接", message: destination) { UIApplication.shared.open(url) }
        }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if let url = webView.url { status.text = origin(url) }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url,
           let selected = server, origin(url) == origin(selected) { webView.load(navigationAction.request) }
        return nil
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { status.text = "连接失败；请检查网络和 HTTPS 证书" }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard let url = navigationResponse.response.url, let selected = server, downloadOrigin(url) == origin(selected) else {
            decisionHandler(navigationResponse.canShowMIMEType ? .allow : .cancel); return
        }
        let headers = (navigationResponse.response as? HTTPURLResponse)?.allHeaderFields
        let attachment = headers?.contains { String(describing: $0.key).lowercased() == "content-disposition" && String(describing: $0.value).lowercased().contains("attachment") } ?? false
        decisionHandler(attachment || !navigationResponse.canShowMIMEType ? .download : .allow)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard let source = response.url, let selected = server, downloadOrigin(source) == origin(selected) else { completionHandler(nil); return }
        let name = suggestedFilename.components(separatedBy: CharacterSet(charactersIn: "/\\:\n\r")).joined(separator: "_")
        let destination = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + (name.isEmpty ? "附件" : name))
        downloadFiles[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }
    private func downloadOrigin(_ url: URL) -> String? {
        if url.scheme == "blob", let nested = URL(string: String(url.absoluteString.dropFirst(5))) { return origin(nested) }
        return origin(url)
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloadFiles.removeValue(forKey: ObjectIdentifier(download)) else { return }
        let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        share.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: file) }
        share.popoverPresentationController?.sourceView = stack.arrangedSubviews.first
        present(share, animated: true)
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let file = downloadFiles.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: file) }
        status.text = "附件下载失败，请重试"
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: "ANote", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }
    // No trust-challenge override: invalid TLS certificates are rejected by WebKit.
}
