import UIKit
import WebKit
import Capacitor
import FirebaseCore

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        FirebaseApp.configure()
        window?.backgroundColor = .black
        window?.overrideUserInterfaceStyle = .light

        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
            print("\n\n========== VIEW HIERARCHY ==========")
            if let win = self.window {
                self.printViewHierarchy(win, depth: 0)
            }
            print("====================================\n\n")
        }

        return true
    }

    private func colorDescription(_ color: UIColor?) -> String {
        guard let color = color else { return "nil" }
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        if a == 0 { return "clear" }
        return String(format: "rgba(%.2f,%.2f,%.2f,%.2f) #%02X%02X%02X",
                      r, g, b, a,
                      Int(r * 255), Int(g * 255), Int(b * 255))
    }

    private func printViewHierarchy(_ view: UIView, depth: Int) {
        let indent = String(repeating: "  ", count: depth)
        let cls = NSStringFromClass(type(of: view))
        let f = view.frame
        let bg = colorDescription(view.backgroundColor)
        let opaque = view.isOpaque ? "OPAQUE" : "transparent"
        let safe = view.safeAreaInsets

        var tags = [String]()
        if view is WKWebView     { tags.append("WKWebView") }
        if view is UIScrollView  { tags.append("UIScrollView") }
        let tagStr = tags.isEmpty ? "" : " [\(tags.joined(separator: ","))]"

        print("\(indent)[\(depth)] \(cls)\(tagStr)")
        print("\(indent)     frame: (\(Int(f.minX)),\(Int(f.minY))) \(Int(f.width))x\(Int(f.height))")
        print("\(indent)     bg: \(bg)  \(opaque)")
        if safe != .zero {
            print("\(indent)     safeArea: T\(Int(safe.top)) B\(Int(safe.bottom)) L\(Int(safe.left)) R\(Int(safe.right))")
        }
        if let scroll = view as? UIScrollView {
            print("\(indent)     scrollView.indicatorStyle: \(scroll.indicatorStyle.rawValue)")
            print("\(indent)     scrollView.bg: \(colorDescription(scroll.backgroundColor))  isOpaque:\(scroll.isOpaque)")
        }

        for sub in view.subviews {
            printViewHierarchy(sub, depth: depth + 1)
        }
    }

    func applicationWillResignActive(_ application: UIApplication) {}
    func applicationDidEnterBackground(_ application: UIApplication) {}
    func applicationWillEnterForeground(_ application: UIApplication) {}
    func applicationDidBecomeActive(_ application: UIApplication) {}
    func applicationWillTerminate(_ application: UIApplication) {}

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
