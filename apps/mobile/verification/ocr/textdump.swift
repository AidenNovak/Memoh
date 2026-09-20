import AppKit
import Foundation
import Vision

private struct TextLine: Codable {
  let text: String
  let x: Double
  let y: Double
}

private struct TextDump: Codable {
  let text: String
  let lines: [TextLine]
}

private struct SelfTestResult: Codable {
  let ok: Bool
  let recognized: String
}

private enum TextDumpError: LocalizedError {
  case missingImage(String)
  case noBitmap
  case noPNG
  case selfTest(String)

  var errorDescription: String? {
    switch self {
    case .missingImage(let path): "image does not exist: \(path)"
    case .noBitmap: "could not create a bitmap for the self-test image"
    case .noPNG: "could not encode the self-test image as PNG"
    case .selfTest(let text): "Vision did not recognize the self-test phrase; got: \(text)"
    }
  }
}

private func recognize(_ imageURL: URL) throws -> TextDump {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.recognitionLanguages = ["en-US", "zh-Hans"]
  try VNImageRequestHandler(url: imageURL).perform([request])

  let lines = (request.results ?? []).compactMap { observation -> TextLine? in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    let box = observation.boundingBox
    return TextLine(
      text: candidate.string,
      x: Double(box.midX),
      // Vision uses a bottom-left origin; screenshots and Maestro use top-left.
      y: Double(1 - box.midY)
    )
  }.sorted { lhs, rhs in
    if abs(lhs.y - rhs.y) > 0.01 { return lhs.y < rhs.y }
    return lhs.x < rhs.x
  }

  return TextDump(text: lines.map(\.text).joined(separator: "\n"), lines: lines)
}

private func writeJSON<T: Encodable>(_ value: T) throws {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys]
  FileHandle.standardOutput.write(try encoder.encode(value))
  FileHandle.standardOutput.write(Data([0x0a]))
}

private func makeSelfTestImage(at url: URL) throws {
  let size = NSSize(width: 900, height: 240)
  let image = NSImage(size: size)
  image.lockFocus()
  NSColor.white.setFill()
  NSRect(origin: .zero, size: size).fill()
  let attributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 60, weight: .semibold),
    .foregroundColor: NSColor.black,
  ]
  "Waiting for you".draw(at: NSPoint(x: 72, y: 82), withAttributes: attributes)
  image.unlockFocus()

  guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff) else {
    throw TextDumpError.noBitmap
  }
  guard let png = bitmap.representation(using: .png, properties: [:]) else {
    throw TextDumpError.noPNG
  }
  try png.write(to: url, options: .atomic)
}

private func runSelfTest() throws {
  let url = FileManager.default.temporaryDirectory
    .appendingPathComponent("memoh-textdump-\(UUID().uuidString).png")
  defer { try? FileManager.default.removeItem(at: url) }
  try makeSelfTestImage(at: url)
  let dump = try recognize(url)
  guard dump.text.localizedCaseInsensitiveContains("Waiting for you") else {
    throw TextDumpError.selfTest(dump.text)
  }
  try writeJSON(SelfTestResult(ok: true, recognized: dump.text))
}

do {
  let arguments = Array(CommandLine.arguments.dropFirst())
  if arguments == ["--self-test"] {
    try runSelfTest()
  } else if arguments.count == 1 {
    let path = arguments[0]
    guard FileManager.default.fileExists(atPath: path) else {
      throw TextDumpError.missingImage(path)
    }
    try writeJSON(recognize(URL(fileURLWithPath: path)))
  } else {
    fputs("usage: textdump <screenshot.png> | --self-test\n", stderr)
    exit(2)
  }
} catch {
  fputs("textdump: \(error.localizedDescription)\n", stderr)
  exit(1)
}
