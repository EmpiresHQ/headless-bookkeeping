#if os(iOS)
import SwiftUI

public struct LoginView: View {
    @State private var model: LoginViewModel

    public init(model: LoginViewModel) {
        _model = State(initialValue: model)
    }

    public var body: some View {
        VStack(spacing: 16) {
            Text("Scan enrollment QR")
                .font(.headline)
            QRScannerView { raw in
                Task { await model.handleScan(raw) }
            }
            .frame(maxWidth: .infinity, maxHeight: 400)
            .clipShape(RoundedRectangle(cornerRadius: 12))

            if let error = model.errorMessage {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
        }
        .padding()
    }
}
#endif
