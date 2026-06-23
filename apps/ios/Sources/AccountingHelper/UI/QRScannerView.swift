#if os(iOS)
import SwiftUI
import AVFoundation

/// AVFoundation-backed QR scanner. Calls `onScan` once with the first decoded
/// payload string. Thin device wrapper — verified manually, not unit-tested.
public struct QRScannerView: UIViewControllerRepresentable {
    public let onScan: (String) -> Void

    public init(onScan: @escaping (String) -> Void) {
        self.onScan = onScan
    }

    public func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

    public func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.coordinator = context.coordinator
        return controller
    }

    public func updateUIViewController(_ uiViewController: ScannerController, context: Context) {}

    public final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        private let onScan: (String) -> Void
        private var didScan = false

        init(onScan: @escaping (String) -> Void) { self.onScan = onScan }

        public func metadataOutput(_ output: AVCaptureMetadataOutput,
                                   didOutput metadataObjects: [AVMetadataObject],
                                   from connection: AVCaptureConnection) {
            guard !didScan,
                  let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  obj.type == .qr, let value = obj.stringValue else { return }
            didScan = true
            onScan(value)
        }
    }

    public final class ScannerController: UIViewController {
        var coordinator: Coordinator?
        private let session = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?

        public override func viewDidLoad() {
            super.viewDidLoad()
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else { return }
            session.addInput(input)

            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(coordinator, queue: .main)
            output.metadataObjectTypes = [.qr]

            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.bounds
            view.layer.addSublayer(layer)
            preview = layer
        }

        public override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            if !session.isRunning {
                // `startRunning()` blocks, so it must run off the main actor. The
                // session isn't `Sendable`, but it is the only owner here and is not
                // mutated concurrently, so the local `nonisolated(unsafe)` binding
                // asserts it is safe to hand to the detached task.
                nonisolated(unsafe) let session = self.session
                Task.detached { session.startRunning() }
            }
        }

        public override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            if session.isRunning { session.stopRunning() }
        }

        public override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }
    }
}
#endif
