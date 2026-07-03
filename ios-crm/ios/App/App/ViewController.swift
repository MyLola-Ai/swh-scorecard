import Capacitor

class ViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        // hideHomeIndicator is @objc on CAPBridgeViewController but not open for subclass
        // override outside Capacitor's module. Set via KVC to reach the didSet observer,
        // which calls setNeedsUpdateOfHomeIndicatorAutoHidden().
        setValue(true, forKey: "hideHomeIndicator")
    }
}
