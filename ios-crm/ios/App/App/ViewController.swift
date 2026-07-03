import UIKit
import WebKit
import Capacitor

class ViewController: CAPBridgeViewController {

    override func viewDidLoad() {
        overrideUserInterfaceStyle = .dark
        super.viewDidLoad()

        view.backgroundColor = .black

        // Transparent + dark WKWebView so the native layer is never white.
        if let wv = webView {
            wv.isOpaque = false
            wv.backgroundColor = .black
            wv.scrollView.backgroundColor = .black
        }

        // Pin a transparent UIView to the safe-area bottom zone.
        // Transparent so the CSS glass nav renders through to the physical bottom
        // with no native color blocking it. Stays in the UIKit hierarchy so
        // overrideUserInterfaceStyle = .dark (set above) keeps the home indicator white.
        let safeZone = UIView()
        safeZone.backgroundColor = UIColor.clear
        safeZone.isUserInteractionEnabled = false
        safeZone.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(safeZone)
        NSLayoutConstraint.activate([
            safeZone.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            safeZone.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            safeZone.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            safeZone.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Home indicator auto-hide is driven by Capacitor's SystemBars plugin
        // (JS calls SystemBars.hide({bar:'NavigationBar'}) at boot). Log the
        // flag now and again after the web layer has booted.
        print("[HomeIndicator] viewDidAppear: prefersHomeIndicatorAutoHidden =", prefersHomeIndicatorAutoHidden)
        print("[HomeIndicator] viewDidAppear: childForHomeIndicatorAutoHidden =", String(describing: childForHomeIndicatorAutoHidden))
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            guard let self else { return }
            print("[HomeIndicator] +4s: prefersHomeIndicatorAutoHidden =", self.prefersHomeIndicatorAutoHidden)
            self.setNeedsUpdateOfHomeIndicatorAutoHidden()
        }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return .lightContent
    }
}
