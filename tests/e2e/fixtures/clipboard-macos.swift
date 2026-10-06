import AppKit
import Foundation

struct ClipboardItem: Codable, Equatable {
    let values: [String: String]
}

enum ClipboardFailure: Error { case unavailable, rejected, mismatch }

func readItems(_ pasteboard: NSPasteboard) throws -> [ClipboardItem] {
    try (pasteboard.pasteboardItems ?? []).map { item in
        var values: [String: String] = [:]
        for type in item.types {
            guard let bytes = item.data(forType: type) else { throw ClipboardFailure.unavailable }
            values[type.rawValue] = bytes.base64EncodedString()
        }
        return ClipboardItem(values: values)
    }
}

do {
    let pasteboard = NSPasteboard.general
    if CommandLine.arguments.dropFirst().first == "capture" {
        FileHandle.standardOutput.write(try JSONEncoder().encode(readItems(pasteboard)))
    } else {
        let snapshot = try JSONDecoder().decode([ClipboardItem].self, from: FileHandle.standardInput.readDataToEndOfFile())
        let items = try snapshot.map { saved -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, encoded) in saved.values {
                guard let bytes = Data(base64Encoded: encoded), item.setData(bytes, forType: NSPasteboard.PasteboardType(type)) else { throw ClipboardFailure.rejected }
            }
            return item
        }
        pasteboard.clearContents()
        if !items.isEmpty && !pasteboard.writeObjects(items) { throw ClipboardFailure.rejected }
        if try readItems(pasteboard) != snapshot { throw ClipboardFailure.mismatch }
    }
} catch {
    FileHandle.standardError.write(Data("Clipboard operation failed\n".utf8))
    exit(1)
}
