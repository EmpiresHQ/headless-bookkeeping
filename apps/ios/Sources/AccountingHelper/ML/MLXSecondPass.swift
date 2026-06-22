#if os(iOS) && canImport(MLXVLM)
import CoreGraphics
import CoreImage
import Foundation
import MLXVLM
import MLXLMCommon
import MLXHuggingFace
import HuggingFace
import Tokenizers

/// On-device VLM "second pass" backed by a small Qwen 3.5 vision model via MLX.
///
/// Pipeline role: runs ONLY after the cheap ``VisionGate`` passes, as a precision
/// filter that kills false positives the text gate cannot distinguish (weather, chat,
/// web screenshots are all text-heavy). It asks the model a single yes/no question and
/// parses the first YES/NO token.
///
/// Lifecycle / safety:
/// - The model (~0.5 GB, 4-bit) is downloaded from Hugging Face on first use and cached
///   by the Hub client (`~/Library/Caches`), never bundled.
/// - Loading is lazy and happens at most once; concurrent calls await the same load task.
/// - Every failure path (not downloaded, download in progress, load error, generation
///   error) returns `nil` — "couldn't decide" — and NEVER crashes. Callers treat `nil`
///   as a pass to preserve recall.
///
/// This is Metal-only and therefore lives behind `#if os(iOS) && canImport(MLXVLM)` so
/// it stays out of the macOS host (`swift test`) build entirely.
public actor MLXSecondPass: SecondPassClassifier {
    /// Smallest natively-multimodal Qwen 3.5 variant, 4-bit. `config.json` reports
    /// `model_type: qwen3_5` with a `vision_config`, so VLMModelFactory routes it to the
    /// MLXVLM `Qwen35` (vision-capable) model rather than the text-only MLXLLM one.
    public static let modelId = "mlx-community/Qwen3.5-0.8B-4bit"

    private let prompt: String
    private let maxTokens: Int

    private enum LoadState {
        case idle
        case loading(Task<ModelContainer?, Never>)
        case loaded(ModelContainer)
        case failed
    }
    private var state: LoadState = .idle

    public init(
        prompt: String = "Look at this image. Is it a receipt, invoice, bill, payment slip, "
            + "or any accounting/financial document? Answer with exactly one word: YES or NO.",
        maxTokens: Int = 4
    ) {
        self.prompt = prompt
        self.maxTokens = maxTokens
    }

    public func isAccountingDocument(_ image: CGImage) async -> Bool? {
        guard let container = await ensureLoaded() else { return nil }

        // CGImage -> CIImage for UserInput.Image.ciImage (the VLM image processor
        // resizes/normalizes from here).
        let ci = CIImage(cgImage: image)

        do {
            // Keep output tiny: we only need the first YES/NO word. Greedy decode
            // (temperature 0) for a deterministic, constrained answer.
            let session = ChatSession(
                container,
                generateParameters: GenerateParameters(maxTokens: maxTokens, temperature: 0))
            let answer = try await session.respond(to: prompt, image: .ciImage(ci))
            return Self.parseVerdict(answer)
        } catch {
            // Generation failed (e.g. OOM on an older device) — undecided, never crash.
            return nil
        }
    }

    /// Parse the first standalone YES/NO from the model's reply. Unknown/empty → nil.
    static func parseVerdict(_ raw: String) -> Bool? {
        let upper = raw.uppercased()
        // Scan in order so the FIRST decisive token wins (the model may ramble).
        for token in upper.components(separatedBy: CharacterSet.alphanumerics.inverted) where !token.isEmpty {
            if token == "YES" { return true }
            if token == "NO" { return false }
        }
        return nil
    }

    /// Lazily load the model exactly once. Returns nil on any failure; concurrent
    /// callers await the same in-flight load.
    private func ensureLoaded() async -> ModelContainer? {
        switch state {
        case .loaded(let c):
            return c
        case .failed:
            return nil
        case .loading(let task):
            return await task.value
        case .idle:
            let task = Task<ModelContainer?, Never> { [modelId = Self.modelId] in
                do {
                    // Default Hub client + swift-transformers tokenizer; downloads &
                    // caches the weights on first run.
                    let container = try await #huggingFaceLoadModelContainer(
                        configuration: ModelConfiguration(id: modelId))
                    return container
                } catch {
                    return nil
                }
            }
            state = .loading(task)
            let result = await task.value
            state = result.map(LoadState.loaded) ?? .failed
            return result
        }
    }
}
#endif
