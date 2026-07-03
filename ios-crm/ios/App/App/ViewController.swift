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

        // Pin a non-interactive dark UIView to the exact safe-area bottom zone.
        // iOS 26 Liquid Glass samples the UIKit layer stack to pick the indicator
        // color; this native dark view ensures it reads dark → renders white pill
        // (invisible against the dark nav background).
        let safeZone = UIView()
        safeZone.backgroundColor = UIColor(red: 0.118, green: 0.118, blue: 0.118, alpha: 1)
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

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return .lightContent
    }
}
