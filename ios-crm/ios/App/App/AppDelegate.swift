import UIKit
import Capacitor
import FirebaseCore
import ObjectiveC

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        FirebaseApp.configure()
        patchHomeIndicator()
        return true
    }

    // MARK: - Home Indicator

    // Capacitor's SystemBars.swift declares `override public var
    // prefersHomeIndicatorAutoHidden` in a Swift extension, which blocks
    // re-overriding from subclasses outside the Capacitor module (Swift
    // requires `open`, not `public`, for that). Swizzle at the ObjC runtime
    // level instead — this fires before any VC appears, so UIKit's first
    // evaluation of the property already returns true (auto-hide enabled).
    private func patchHomeIndicator() {
        guard
            let cls = NSClassFromString("Capacitor.CAPBridgeViewController"),
            let method = class_getInstanceMethod(cls, NSSelectorFromString("prefersHomeIndicatorAutoHidden"))
        else { return }
        let alwaysHide: @convention(block) (AnyObject) -> Bool = { _ in true }
        method_setImplementation(method, imp_implementationWithBlock(alwaysHide as AnyObject))
    }

    func applicationWillResignActive(_ application: UIApplication) {}

    func applicationDidEnterBackground(_ application: UIApplication) {}

    func applicationWillEnterForeground(_ application: UIApplication) {}

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Ensure the patched value is picked up after returning from background.
        window?.rootViewController?.setNeedsUpdateOfHomeIndicatorAutoHidden()
    }

    func applicationWillTerminate(_ application: UIApplication) {}

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
