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
/// - The model (~0.5 GB, 4-bit) is BUNDLED INTO THE APP at build time (folder reference
///   `Qwen3.5-0.8B-4bit/` in `Bundle.main`) and loaded from disk. There is NO Hugging
///   Face download at runtime — if the bundled directory is missing, loading returns nil.
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

    /// Name of the bundled model directory (a folder reference copied into the .app at
    /// build time by Scripts/fetch-qwen.sh + the XcodeGen `type: folder` resource entry).
    public static let bundledModelDirectoryName = "Qwen3.5-0.8B-4bit"

    /// On-disk URL of the bundled model directory inside `Bundle.main`, or nil if it was
    /// not bundled (e.g. the host/test build, or a build where fetch-qwen.sh never ran).
    static var bundledModelURL: URL? {
        Bundle.main.url(forResource: bundledModelDirectoryName, withExtension: nil)
    }

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
            // Resolve the bundled directory up front — if it isn't in the .app there is
            // nothing to load and we must NOT fall back to a network download.
            guard let directory = Self.bundledModelURL else {
                state = .failed
                return nil
            }
            let task = Task<ModelContainer?, Never> {
                do {
                    // Load purely from the on-disk bundled directory (no Downloader, no
                    // Hub access). The tokenizer loader reads tokenizer.json &c from the
                    // same local folder via swift-transformers' AutoTokenizer.
                    let container = try await loadModelContainer(
                        from: directory, using: #huggingFaceTokenizerLoader())
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
