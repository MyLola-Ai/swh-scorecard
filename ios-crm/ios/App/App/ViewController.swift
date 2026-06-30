import Capacitor

// Subclass of CAPBridgeViewController kept here for future native customizations.
// Home Indicator auto-hide is controlled via the SystemBars plugin from JS
// (Capacitor's prefersHomeIndicatorAutoHidden is declared in an extension as
// `override public`, which blocks re-overriding in subclasses outside the module).
class ViewController: CAPBridgeViewController {}
