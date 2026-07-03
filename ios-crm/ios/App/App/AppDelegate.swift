import UIKit
import WebKit
import Capacitor
import FirebaseCore

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        FirebaseApp.configure()
        configureNativeSurfaces()
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        configureNativeSurfaces()
    }

    // Dark window + transparent WKWebView so iOS 26 Liquid Glass samples
    // a dark surface behind the home indicator and renders it light (invisible).
    private func configureNativeSurfaces() {
        window?.backgroundColor = .black
        window?.overrideUserInterfaceStyle = .dark
        window?.rootViewController?.view.backgroundColor = .black

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            self.fixWebView(in: self.window?.rootViewController?.view)
        }
    }

    private func fixWebView(in view: UIView?) {
        guard let view = view else { return }
        if view.backgroundColor == nil { view.backgroundColor = .black }

        if let webView = view as? WKWebView {
            webView.isOpaque = false
            webView.backgroundColor = .black
            webView.scrollView.isOpaque = false
            webView.scrollView.backgroundColor = .black
            webView.scrollView.indicatorStyle = .white
        }

        for subview in view.subviews {
            fixWebView(in: subview)
        }
    }

    func applicationWillResignActive(_ application: UIApplication) {}
    func applicationDidEnterBackground(_ application: UIApplication) {}
    func applicationWillEnterForeground(_ application: UIApplication) {}
    func applicationWillTerminate(_ application: UIApplication) {}

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }
}
