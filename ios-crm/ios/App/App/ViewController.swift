import UIKit
import WebKit
import Capacitor

class ViewController: CAPBridgeViewController {

    override func viewDidLoad() {
        // Set dark mode on this VC's trait environment BEFORE Capacitor initializes
        // the WKWebView — ensures iOS 26 Liquid Glass composites the home indicator
        // as white/transparent (invisible against the dark nav background).
        overrideUserInterfaceStyle = .dark

        super.viewDidLoad()

        // After Capacitor creates and attaches the WKWebView, make its native
        // layer dark + non-opaque so the OS compositor never sees a white surface.
        view.backgroundColor = .black
        if let wv = webView {
            wv.isOpaque = false
            wv.backgroundColor = .black
            wv.scrollView.backgroundColor = .black
        }
    }

    // White status-bar icons (clock, battery) on the dark background.
    override var preferredStatusBarStyle: UIStatusBarStyle {
        return .lightContent
    }
}
